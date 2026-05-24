# Review Round 1 — Kiro Write/Edit 空 content 修复计划
(review对象已经被分拆并废弃了其中web-search|web-fetch的实施计划)
评审对象：[2026-05-22-08-49-36-903-req-127-0-0-1-0-mutable-lovelace.md](/home/chris/.claude/plans/2026-05-22-08-49-36-903-req-127-0-0-1-0-mutable-lovelace.md)
代码基线：当前 `main`（commit `670d703`，v3.0.9.6）
评审范围：主任务（修复 A/B/D）+ 附加任务（web_search / web_fetch 映射）

## 1. 总体评价

**结论：整体方向正确，可进入实施；但有 4 处必须修订、3 处建议修订才能落地。**

## 2. 必须修订（Must-fix）

### 2.1 Fix A — 文本块关闭与 blockIndex 分配时机未说明

计划描述"延迟下发 content_block_start / input_json_delta"，但没说清：

1. **文本块关闭时机**：[claude-kiro.js:2907](src/providers/claude/claude-kiro.js#L2907) 在工具进入前 `stopBlock(textBlockIndex)`。延迟后该立刻关闭还是同样延迟？需明确。
2. **blockIndex 分配**：当前 index = `assistantContent.length`。延迟下被丢弃的工具不能"占位"，否则后续块索引会跳号。

**修订要求**：在 Fix A 的"参考实现"或伪代码段补一个状态机说明：
- text block 在第一帧 toolUse 到达时立即 stopBlock（与现状一致），不延迟；
- 把 toolUse 的 blockIndex 分配延后到"校验通过、确认下发"的瞬间；
- 校验失败丢弃整个 tool_use 块时，blockIndex 计数器**不递增**，避免后续 text block 或下一次 tool_use 的 index 出现跳号。

否则实施者可能把 blockIndex 分配也提前，导致客户端收到"index=2 缺失，直接跳到 index=3"的错位流，触发新的兼容性问题。

### 2.2 Fix B — 与现有 `hasMessageStop` 机制的兼容性未验证

计划要求"下发 error 帧后立即结束 SSE 流（不再发 message_stop）"。但 [common.js:743-748](src/utils/common.js#L743-L748) 的 `hasMessageStop` 仅追踪是否发过 message_stop，对"未发"路径在 SSE 写入层不会自动补发——这部分是正确的。**但** [common.js:640-655](src/utils/common.js#L640-L655) 的 `handleStreamRequest` 外层是否会在 generator 自然返回后做"兜底 message_stop"补发？计划没核验。

**修订要求**：实施前先在 `common.js` 的 `handleStreamRequest` 与 `addEvent` 链路上确认两件事：

1. yield `{type: "error", ...}` 后再 `return`，外层 SSE 写入是否会在 finally 块或 stream end handler 里追加 `event: message_stop`？如果会，error 帧会被"假装正常"的 message_stop 紧跟，客户端拿不到错误语义；
2. 现有的 Claude 错误帧路径（[common.js:2106-2115](src/utils/common.js#L2106-L2115)）已经下发 error 帧，可参考其后续是否有 message_stop 补发的处理——直接复用其行为，不要自创。

如果外层确实会补发，Fix B 需要额外在 generator 内 yield 一个特殊 sentinel，或在 SSE 写入层加分支跳过 message_stop。计划必须在实施前把这条路径串通。

### 2.3 Fix B — `overloaded_error` vs `api_error` 的实测步骤缺失

计划原文："类型选 `overloaded_error` 而非 `api_error`，因为 Claude SDK 对前者有内置重试策略……如果实测发现 SDK 对 `api_error` 同样会重试再调整。"

这是个**未完成的伪条件**——计划落地时谁来做这个"实测"？什么算"同样会重试"？没有验证步骤就把决定权悬在半空。

**修订要求**：在 Phase 3 验证段补一个独立小节"错误类型选型实测"，给出可复现步骤：

1. 起一个本地代理实例，强制让某条 capture 进入 Fix B 路径；
2. 用真实 Claude Code SDK（最新版本）作为客户端发同一请求；
3. 分别下发 `overloaded_error` / `api_error` / `invalid_request_error` 三种错误，记录 SDK 日志中是否出现重试请求（同 invocationId / 新 invocationId 均算）；
4. 统计三种 error type 的重试次数与最终成功率，把数据写进 PR 描述；
5. 选项落地后保留为常量，便于后续随 SDK 升级再核对。

### 2.4 Phase 3 — 配置开关组合矩阵未覆盖

计划引入两个独立开关 `KIRO_STREAM_TOOL_USE_DEFER`、`KIRO_STREAM_TRUNCATION_ERROR`，但没有列出四种组合下的预期行为：

| DEFER | TRUNCATION_ERROR | 预期行为 | 是否合法 |
|---|---|---|---|
| true  | true  | 完全新行为：延迟下发 + error 帧 | ✅（默认） |
| true  | false | 延迟下发，但末尾退回 end_turn | ⚠ 半新半旧，需要明确语义 |
| false | true  | 立即下发 deltas，末尾再发 error 帧 | ⚠ 客户端可能已处理残缺工具又收到 error，行为冲突 |
| false | false | 完全旧行为（当前 main） | ✅（紧急回退） |

**修订要求**：

1. 在 Phase 3 验证段把这张矩阵补全；
2. 第三行（DEFER=false + TRUNCATION_ERROR=true）属于"行为冲突"组合——立即下发的 deltas 让客户端已经看到残缺工具，再发 error 帧会让 SDK 收到两套互斥信号。建议在配置加载时检测到该组合直接 warn + 自动改为 false/false（或 true/true）；
3. 明确 **Fix D（`isIncompleteFileToolCall` 修订）始终生效，不受任何开关影响**——它是确定性 bug 修复，不需要回退路径。这一点计划里没明说，容易让实施者误以为也需要开关。

## 3. 建议修订（Suggested）

### 3.1 把 5 份失败 capture 固化为仓库内 fixture

Phase 2 数据完全依赖用户机器上 `~/captures/kiro/` 的 5 份 `.bin`，PR review / CI 都看不到。建议在 Fix A/B 同 PR 里把它们复制成仓库 fixture，命名按"截断点 + invocationId 前 8 位"区分：

```
tests/fixtures/kiro-stream/truncated-edit-filepath-8cc24095.bin   # 停在 file_path 后
tests/fixtures/kiro-stream/truncated-edit-filepath-ead9c018.bin
tests/fixtures/kiro-stream/truncated-edit-filepath-3ee70b18.bin
tests/fixtures/kiro-stream/truncated-edit-filepath-1119af9f.bin
tests/fixtures/kiro-stream/truncated-edit-oldstring-c2e63065.bin  # 停在 old_string 中段
```

并在 [tests/providers/claude-kiro-parser-fixture.test.js](tests/providers/claude-kiro-parser-fixture.test.js) 风格的测试里加 `truncated-edit` 套件，断言 Fix A/B 的输出。这样 Phase 2 的取证结果在仓库里有"活样本"留存，未来回归测试能持续拦截。

### 3.2 web_fetch description 应直接引用 Kiro spec 原文

计划在过滤循环里手写了 web_fetch 的 description（"Fetch the contents of a URL. Use mode=full ..."）。这会导致代理写的描述与 Kiro 平台原生 spec 之间漂移，后续 Kiro 升级 spec 时这里不会跟着改。

**建议**：实施时直接读取 [/mnt/c/Users/chris/Downloads/kiro sessions/tool-specification.json](file:///mnt/c/Users/chris/Downloads/kiro%20sessions/tool-specification.json) 的 line 1106-1153 原文摘要，或在仓库里固化一份 `src/providers/claude/kiro-tool-specs.json` 单独管理两条工具的 description / inputSchema，循环里只引用常量。

### 3.3 Fix D 的 `hasNonEmpty` / `hasAny` 工具函数应单测覆盖边界

计划给出的参考实现：

```js
function hasNonEmpty(obj, keys) {
    return keys.some(k => {
        const v = obj && obj[k];
        return typeof v === 'string' ? v.length > 0 : v != null;
    });
}
```

边界条件容易写错：`obj === null`、`v === undefined`、`v === ''`、`v === 0`、`v === false`、`v` 是数组/对象等。建议在 `tests/providers/` 下加一个 `kiro-incomplete-tool-call.test.js`，至少覆盖：

- Write + `{file_path: "x"}` → 不完整
- Write + `{file_path: "x", content: ""}` → 不完整（空字符串）
- Write + `{file_path: "x", content: "hi"}` → 完整
- Write + `{path: "x", text: "hi"}` → 完整（Kiro 风格 key）
- Edit + `{file_path: "x", old_string: "a", new_string: ""}` → 完整（删除场景）
- Edit + `{file_path: "x"}` → 不完整
- 未知工具 + 任意 → 完整（保留现状）

## 4. 已确认正确（无需修订）

- **行号准确**：[claude-kiro.js:398-403](src/providers/claude/claude-kiro.js#L398-L403)、[claude-kiro.js:2940-2949](src/providers/claude/claude-kiro.js#L2940-L2949)、[claude-kiro.js:3060-3088](src/providers/claude/claude-kiro.js#L3060-L3088)、[claude-kiro.js:3203](src/providers/claude/claude-kiro.js#L3203) 均与当前 main 一致。
- **Suspect 1 因果链**：上游 toolUse 头到达 → 立即下发 content_block_start + input_json_delta（仅 file_path 部分）→ 上游断流 → fallback 路径让 stop_reason 退回 end_turn → 客户端拿残缺 input 执行 → SDK abort。完全成立。
- **Phase 2 取证表**：5/5 失败样本结论 A、零 B/C 样本，`parser.remaining===0` 排除代理端字节丢失，结论稳健。
- **Fix D 分支拆分**：按 toolName 分支（Write/Edit/MultiEdit/其它）+ Anthropic/Kiro 双 key 风格识别覆盖完整，没有遗漏分支。
- **附加任务的过滤代码替换点**：[claude-kiro.js:1209-1220](src/providers/claude/claude-kiro.js#L1209-L1220) 唯一一处，下游包装 `{toolSpecification: {...}}` 共用，符合"和其它工具同走一条转换路径"的约定。

## 5. 实施顺序建议

按风险从低到高、依赖从无到有排列：

1. **先做 Fix D + 单测**（独立 commit / 小 PR）：确定性 bug 修复、不影响流式路径，可立即上线观察。
2. **再做 Fix A + Fix B + 配置开关 + fixture 化**（同 PR，主修复）：依赖 Fix D 落地的判据，且 A/B 互相耦合（A 把残缺整段吞，B 接管末尾错误下发），不应拆分。
3. **附加任务（web_search / web_fetch 映射）独立 PR**：与主任务零代码重叠，并行无冲突。建议主修复合并并稳定 1-2 天后再合并附加任务，避免观察期相互干扰。

## 6. 风险与回退

| 修复 | 主要风险 | 回退手段 |
|---|---|---|
| Fix A | 失去渐进式工具参数渲染体验；blockIndex 状态机若实施有误会让客户端报"index 跳号" | `KIRO_STREAM_TOOL_USE_DEFER=false` 立即退回旧路径 |
| Fix B | SDK 对 error 帧的兼容性未知；某些老版本 SDK 可能把 error 帧当致命错误不重试 | `KIRO_STREAM_TRUNCATION_ERROR=false` 退回"假装 end_turn" |
| Fix D | 第三方工具同名（Write/Edit）被误识别——但当前代码仅覆盖 Anthropic/Kiro 标准工具集，风险面小 | 无开关；如出问题直接 revert commit |
| 附加任务 | Kiro 后续修改 schema 后硬编码失效 | `KIRO_ENABLE_REMOTE_WEB_SEARCH=false` / `KIRO_ENABLE_WEB_FETCH=false` 任一关闭 |

**总体评估**：四个修复都有明确的回退路径（Fix D 除外，但其风险面足够小）；只要按 Section 5 的顺序分两个 PR 提交，可以做到"任一阶段出问题都能在 1 个环境变量内回滚"。建议 Fix A/B 合并后保留两个开关至少一个迭代周期再考虑移除。

