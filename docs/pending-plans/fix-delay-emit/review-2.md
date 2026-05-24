# Review Round 2 — Kiro Write/Edit 空 content 修复计划（实施层视角）

评审对象：[2026-05-22-08-49-36-903-req-127-0-0-1-0-mutable-lovelace.md](/home/chris/.claude/plans/2026-05-22-08-49-36-903-req-127-0-0-1-0-mutable-lovelace.md)
代码基线：当前 `main`（commit `670d703`，v3.0.9.6）
评审范围：主任务 Fix A / Fix B / Fix D + 附加任务（web_search / web_fetch 映射）

## 1. 与 Round 1 的关系

[review-1.md](review-1.md) 聚焦**计划设计层面**：blockIndex 状态机、错误类型实测步骤、配置开关组合矩阵、fixture 化等。

本轮（Round 2）切换到**代码实施层面**，把计划与现有代码逐点对照，验证落地时是否会撞上 Round 1 没覆盖的"代码现实"。

发现 3 处实施层 must-fix（计划与现有代码协调缺失）+ 2 处建议（可观测性与 provider-pool 交互）。

## 2. 总体结论
(review对象已经被分拆并废弃了其中web-search|web-fetch的实施计划)
**计划方向正确，但实施前必须解决以下与现有代码的耦合问题，否则 Fix A/B/D 的实际行为会与计划描述偏离。**

## 3. 必须修订（Implementation Must-fix）

### 3.1 Fix A — `repairToolInputJson` 的 4 处流式调用点未协调

计划描述"延迟下发 content_block_start / input_json_delta，等到 toolUseStop 时再校验决定下发或丢弃"。但当前流式路径中 `repairToolInputJson` 被调用了**4 次**，每次都伴随 `isIncompleteFileToolCall` 判断与 `toolCalls.push` 决策：

| 调用点 | 行号 | 触发场景 | 当前行为 |
|---|---|---|---|
| 切换工具时收尾旧调用 | [claude-kiro.js:2920](src/providers/claude/claude-kiro.js#L2920) | 同帧出现新 toolUseId | 已立即发完 content_block_start + deltas |
| `tc.stop=true` 帧内闭环 | [claude-kiro.js:2980](src/providers/claude/claude-kiro.js#L2980) | toolUse 帧自带 stop 标记 | 已发完，再判断 push |
| 独立 `toolUseStop` 事件 | [claude-kiro.js:3034](src/providers/claude/claude-kiro.js#L3034) | toolUseStop 帧到达 | 已发完 deltas，再判断 |
| 流自然结束的兜底 | [claude-kiro.js:3066](src/providers/claude/claude-kiro.js#L3066) | for-await 退出后 currentToolCall 仍在 | 已发完 deltas，再判断 |

**问题**：计划只描述了"延迟到 toolUseStop"——但实际有 3 个等价的"终态触发点"（2920 / 2980 / 3034），加上 1 个流断的兜底（3066）。Fix A 必须在**所有 4 处**统一应用"延迟下发 + 决策时机"的状态机，否则会出现：

- 仅在 3034 处延迟下发 → 当上游用 `tc.stop=true` 在 toolUse 帧内闭环（2980 路径）时，旧的"立即发完"行为依然走，Fix A 失效；
- 仅在 toolUseStop 处延迟 → 上游切到下一个工具（2920 路径）时旧逻辑依然 leak。

**修订要求**：

1. 在计划的 Fix A 段落明确列出"4 处终态触发点 + 1 处流断兜底"，每处都需要统一的延迟决策逻辑；
2. 把延迟下发逻辑抽成一个内部函数 `flushOrDropToolCall(currentToolCall, blockIndex, sentBlockStart, pendingDeltas)`，4 处调用点统一调用，避免漏改；
3. 该函数必须负责：
   - 判断是否已发过 `content_block_start`（首次 toolUse 帧若延迟则未发）；
   - 决定下发：补发 `content_block_start` → `input_json_delta`(完整 input) → `content_block_stop`；
   - 决定丢弃：若 `content_block_start` 已发出（开关关闭或半旧路径），需补发 `content_block_stop` 修复块边界；若未发出，则 blockIndex 计数器回滚（与 Round 1 §2.1 联动）。

### 3.2 Fix B — error 帧路径会丢失 usage / token 计费

[claude-kiro.js:3199-3223](src/providers/claude/claude-kiro.js#L3199-L3223) 在流自然结束时统一下发 `message_delta` + `message_stop`：

```js
yield { type: "message_delta", delta: { stop_reason }, usage: {
    input_tokens: reportedNonCached, output_tokens, cache_creation_input_tokens, cache_read_input_tokens
}};
yield { type: "message_stop" };
```

`message_delta.usage` 是 Claude 客户端**唯一的 token 计费来源**，且其 `input_tokens` 经过 `inflationDelta` 压力膨胀（[claude-kiro.js:3189-3197](src/providers/claude/claude-kiro.js#L3189-L3197)），用于驱动 Claude Code 的 context auto-compact 决策。

计划 Fix B 描述"yield error 帧后立即 return，不再发 message_stop"——但**没明说 message_delta 也不发**。如果实施时把整个收尾段（3199-3223）都跳过，会出现：

1. 客户端拿不到 `usage.input_tokens` / `output_tokens` → 本次请求计费数据丢失；
2. 失去 `inflationDelta` 压力膨胀信号 → 后续 auto-compact 触发时机紊乱；
3. `cache_creation_input_tokens` / `cache_read_input_tokens` 同样丢失 → 缓存效益统计偏低。

**修订要求**：

1. Fix B 必须明确：error 帧与 message_delta 是**互斥的终态信号**，但 token 计费仍需保留——可在 error 帧 payload 中扩展 `usage` 字段，或在 error 帧之前先 yield 一个 `message_delta`(stop_reason 任选 + 完整 usage) 再 yield error；
2. 与 Round 1 §2.2 联动验证：[common.js:640-655](src/utils/common.js#L640-L655) 外层在收到 `type: error` 后是否会跳过后续 yield——若会，则必须用"先 message_delta 后 error"方案；
3. PR 描述中明确记录 Fix B 路径下 token 上报路径，避免合并后才发现计费倒退。

### 3.3 Fix D — 工具名映射假设需基于实际 capture 验证

`buildKiroToolNameMaps` 在 [claude-kiro.js:71-92](src/providers/claude/claude-kiro.js#L71-L92) 实现的不是"语义翻译"——`shortenKiroToolName` 仅在工具名超过 64 字符时做哈希截断（[claude-kiro.js:60-69](src/providers/claude/claude-kiro.js#L60-L69)）。

含义：客户端发来的 `Write` / `Edit` / `MultiEdit` **原名直接注册到 Kiro**，Kiro 也以同名回传 `toolUse` 事件。所以：

1. 现有 [claude-kiro.js:401](src/providers/claude/claude-kiro.js#L401) 的 `name.includes('create_text_file')` 分支若是为了应对 Kiro 端原生工具名而存在，**目前并无 capture 证据**——`grep` 全仓库 `create_text_file` / `fs_write` / `str_replace` 仅命中这一处 substring 检查；
2. `MultiEdit` 在 claude-kiro.js 中**完全无任何引用**，仅靠 `name.includes('Edit')` 顺便覆盖；
3. Round 1 §3.3 的测试用例同时覆盖 Anthropic 风格 key（`file_path` / `content`）与 Kiro 风格 key（`path` / `text`）——但 Kiro 风格 key 仅在某些客户端 / 平台原生工具下出现，主线 Claude Code 路径全部是 Anthropic 风格。

**修订要求**：

1. 计划 Fix D 必须基于 Phase 2 已收集的 5 份 capture 实际样本，列出**当前 main 上真实出现过的 (toolName, inputKeys) 组合**——例如：
   ```
   Write {file_path, content}     ← 5/5 capture 命中
   Edit  {file_path, old_string}  ← 1/5 capture 命中（断在 old_string 中段）
   ```
   只对真实出现的组合写分支，避免为虚构场景写死代码；
2. 若 Fix D 仍要保留 `fs_write` / `create_text_file` / `str_replace` 等"Kiro 原生工具名"分支，必须给出**至少一份 capture 文件路径**作为证据，否则在评审时直接删除该分支；
3. `MultiEdit` 若计划支持，需补一份 capture 验证 Kiro 实际回传的 `edits[]` 数组结构是否与 Anthropic 一致——本仓库目前**零证据**支持此假设。

## 4. 建议修订（Suggested）

### 4.1 Fix A 丢弃 tool_use 时缺少结构化日志字段

[claude-kiro.js:2930](src/providers/claude/claude-kiro.js#L2930) / [claude-kiro.js:2985](src/providers/claude/claude-kiro.js#L2985) / [claude-kiro.js:3040](src/providers/claude/claude-kiro.js#L3040) / [claude-kiro.js:3071](src/providers/claude/claude-kiro.js#L3071) 当前丢弃日志只有 `toolName` 和（仅 3071 处）`Object.keys(parsedInput)`。Fix A 落地后丢弃路径会更频繁，需要更多上下文才能在生产排查"客户端报丢失工具"问题。

**建议**：在 `flushOrDropToolCall` 内统一记录如下结构化字段：

- `invocationId`（从 [claude-kiro.js](src/providers/claude/claude-kiro.js) 当前 request 上下文中取，[v3.0.9.6](src/providers/claude/claude-kiro.js) 的 502 重试日志已有相同字段）；
- `toolUseId`、`toolName`、`triggerSite`（"toolSwitch"/"tcStop"/"toolUseStop"/"streamEnd" 四选一）；
- `rawInputBytes` = `currentToolCall.input.length`、`parsedKeys` = `Object.keys(parsedInput).join(',')`；
- 若开关 `KIRO_STREAM_TOOL_USE_DEFER=true` 导致 block_start 未发出，记录 `blockStartSent: false`；否则 `true`（便于回归测试时区分两条路径）。

### 4.2 Fix B 与 provider-pool 502 重试的语义区分

当前 [_tryRotateProxyAndRetryOn502](src/providers/claude/claude-kiro.js#L2012) 仅在**HTTP 502** 触发 session 轮换重试。Fix B 引入的"上游正常 200 + 流中段截断"是**应用层错误**——HTTP 层已 200，pool manager 看不到。

**问题**：Fix B 的 error 帧不会触发 pool switching，但截断本身可能是某条 session 的"上游连接被代理强制 reset"——即同一种"代理出错"症状可能呈现两种网络层表现（502 / 流中断），却走两条完全不同的路径。

**建议**：

1. Fix B 在 yield error 帧前，记录一行 `[Kiro][POOL] stream truncation observed on session=<id>, not triggering rotate (proxy 200)`，便于运维识别"这条 session 是不是该被人工拉黑"；
2. 后续如发现同 sessionId 多次截断，可考虑扩展 pool manager 增加"应用层错误计数"信号，但**本计划不应承担此扩展**——计划保持纯 client-facing fix 即可。

## 5. 配置命名一致性

计划提出两个新开关 `KIRO_STREAM_TOOL_USE_DEFER`、`KIRO_STREAM_TRUNCATION_ERROR`。当前仓库 `KIRO_*` 命名约定：

- 资源类：`KIRO_OAUTH_CREDS_DIR_PATH` / `KIRO_OAUTH_CREDS_BASE64` / `KIRO_OAUTH_CREDS_FILE_PATH` / `KIRO_REFRESH_URL` / `KIRO_REFRESH_IDC_URL` / `KIRO_BASE_URL`；
- 行为类：`KIRO_REQUEST_MIN_INTERVAL_MS` / `KIRO_STREAM_TIMEOUT_MS` / `KIRO_STREAM_INACTIVITY_MS`。

行为类全部以"对象 + 量词/单位"结尾（`MIN_INTERVAL_MS`、`TIMEOUT_MS`、`INACTIVITY_MS`），新开关是布尔型，建议统一加 `_ENABLED` 后缀，便于一眼分辨布尔与数值：

- `KIRO_STREAM_TOOL_USE_DEFER` → `KIRO_STREAM_DEFER_TOOL_USE_ENABLED`
- `KIRO_STREAM_TRUNCATION_ERROR` → `KIRO_STREAM_TRUNCATION_ERROR_ENABLED`

并在 [README-KIRO.md](README-KIRO.md)（如存在）或主 README 的环境变量段落中补充说明。

## 6. 测试覆盖建议

Round 1 §3.1 提到的 fixture 化覆盖单工具截断场景，但**多工具混合**场景未覆盖。Phase 2 已知 5/5 失败 capture 都是单 tool_use，但生产中可能出现：

1. 第一个工具完整下发 + 第二个工具截断 → 验证 Fix A 的 blockIndex 不会因第二个工具被丢弃而错位；
2. 第一个工具截断（被丢弃）+ 第二个工具完整 → 验证第二个工具的 blockIndex 是否正确递增、客户端能否正常解析。

**建议**：在 fixture 套件中合成（或从 capture 拼接）至少一份"双工具，第二个截断"和一份"双工具，第一个截断"的样本，单独断言 blockIndex 序列与 toolCalls 数组长度。

## 7. 实施顺序补充

Round 1 §5 给出三步顺序（Fix D → A+B+开关 → 附加任务），本轮补充：

- Fix D 单独 PR 时，建议在该 PR 内同时**移除** `name.includes('create_text_file')` 等无 capture 证据的分支（或显式标注 `// TODO: 待 capture 证据`）——避免后续 Fix A/B PR 评审时再次纠结这些分支；
- Fix A/B PR 合并后，建议保留 §4.1 的结构化丢弃日志至少 1 个迭代周期（约 2 周），收集生产环境真实丢弃率，作为后续是否调整 `KIRO_STREAM_DEFER_TOOL_USE_ENABLED` 默认值的数据依据。

## 8. 总结

Round 1 解决"计划本身是否自洽"，Round 2 解决"计划落地与现有代码是否对齐"。两轮合计 7 处 must-fix（Round 1 四处 + Round 2 三处）+ 5 处建议。

按 Round 1 §5 + Round 2 §7 的实施顺序执行，并把本轮 §3.1 的 `flushOrDropToolCall` 抽象、§3.2 的 token 计费保留、§3.3 的工具名实证三条作为 Fix A/B/D PR 的代码评审硬指标，整体落地风险可控。

