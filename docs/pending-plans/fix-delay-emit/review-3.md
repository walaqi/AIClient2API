# 审阅意见 — `docs/pending-plans/fix-delay-emit/fix-write-failed.md`

## Context（这份审阅在做什么）

被审阅的计划针对 Kiro 流式响应中"上游 mid-stream 截断 tool_use input → 客户端拿残缺 input 执行 → Write/Edit failed → SDK abort"的故障，提出 Fix A（延迟下发）+ Fix B（error 帧 + 计费保留）+ Fix D（判据修订）三项修复，分 PR-1 / PR-2 / PR-3 三轮提交。

本审阅的目标是基于实际代码验证计划的技术声明、找出执行风险、点出内部矛盾。验证范围：[claude-kiro.js](src/providers/claude/claude-kiro.js)、[common.js](src/utils/common.js)、[aws-event-stream-parser.js](src/providers/claude/aws-event-stream-parser.js)、[claude-kiro-parser-fixture.test.js](tests/providers/claude-kiro-parser-fixture.test.js)、[claude-kiro-parser.test.js](tests/providers/claude-kiro-parser.test.js)、`tests/fixtures/kiro-stream/`、`package.json`。

总体结论：**计划方法论扎实、Phase 2 取证有数据支撑、PR 拆分合理、回退手段完备**。但落地前需要修正下面 3 项确凿问题与 4 项值得讨论的盲点，否则 PR-1 / PR-2 落地时会出现实现与单测矛盾、协议门控不生效等问题。

---

## 一、确凿问题（必须修订）

### 问题 1：Fix D 参考实现 vs 单测 case 9/10 自相矛盾

[fix-write-failed.md:393-396](docs/pending-plans/fix-delay-emit/fix-write-failed.md#L393-L396) 在"显式不实现的分支"段明确说：

> ❌ MultiEdit：本仓库 zero capture 验证 Kiro 实际回传的 `edits[]` 数组结构是否与 Anthropic 一致，**零证据**支持此假设。本次 PR-1 不为 MultiEdit 添加任何分支——遇到 MultiEdit 工具时落到"其它工具"分支返回 `false`（"完整"），保持现状。

[fix-write-failed.md:411-425](docs/pending-plans/fix-delay-emit/fix-write-failed.md#L411-L425) 的参考实现也确实只覆盖 `'write'` 与 `'edit'` 两个分支，MultiEdit 走 default `return false`。

但 [fix-write-failed.md:489-493](docs/pending-plans/fix-delay-emit/fix-write-failed.md#L489-L493) 的单测 case 9 / case 10 要求：

| # | toolName | parsedInput | 期望返回 |
|---|---|---|---|
| 9 | `MultiEdit` | `{file_path: "x", edits: []}` | `true`（不完整）|
| 10 | `MultiEdit` | `{file_path: "x", edits: [{...}]}` | `false`（完整）|

按参考实现，这两个 case 都会落到 default 分支返回 `false`——case 9 直接 fail。

**修订建议**：删除 case 9 / case 10，与"PR-1 不为 MultiEdit 添加分支"的决定保持一致；或者参考实现里加 MultiEdit 分支并标注"基于 PR-1 的 zero-capture 防御性补充"。**二选一，但当前两者不能并存**。我倾向前者——计划本身的论据更倾向"无证据不实现"。

### 问题 2：Fix B 的 `event: error` 帧只在 `addEvent=true` 时才有 event 行

[common.js:656](src/utils/common.js#L656) `addEvent` 仅在 `fromProvider` 是 `CLAUDE` 或 `OPENAI_RESPONSES` 时为 true。其它客户端（OpenAI Chat Completions / Gemini）走 needsConversion 路径，`addEvent === false`，[common.js:750-764](src/utils/common.js#L750-L764) 的 `event:` 行不写。

也就是说，当 generator yield `{type: "error", error: {...}}` 时：

- **fromProvider=CLAUDE**（计划默认场景）：客户端读到 `event: error\ndata: {"type":"error",...}\n\n` ✓
- **fromProvider=OPENAI / GEMINI**：客户端只读到 `data: {"type":"error",...}\n\n`，且会被下游 `convertData('streamChunk', ...)` 路径试图翻译——大概率落到 default 分支或抛错。

计划全程把 Fix B 描述成"Anthropic SSE 协议的 `event: error` 帧"，但没说明这个协议门控。Kiro provider 主流场景确实是 Claude 客户端，但项目支持多协议，OpenAI 客户端调 Kiro provider 的链路是真实存在的（grep `MODEL_PROVIDER.CLAUDE_KIRO` 在 OpenAI 侧的入口能看到）。

**修订建议**：在 Phase 3 验证段补一条："Fix B 路径下，对 `fromProvider=OPENAI/GEMINI` 客户端的兼容性验证或显式声明不支持"。最小代价是：在 [common.js:660 起](src/utils/common.js#L660) 的循环里，遇到 `chunk.type === 'error'` 时，对 OpenAI 客户端走 [createStreamErrorResponse](src/utils/common.js#L2106-L2115) 同款的协议适配（OpenAI 用 `chat.completion.chunk` 错误对象、Gemini 用 `{error: {code, message}}`）。**否则 Kiro→OpenAI 链路在截断场景下会输出非法格式的 SSE。**

### 问题 3：Fix B 双工具 fixture 合成不可行

[fix-write-failed.md:507-511](docs/pending-plans/fix-delay-emit/fix-write-failed.md#L507-L511) 要求"从已有 capture 拼接（或合成）至少 2 份双工具样本"。但 AWS event-stream 帧每帧带 4 字节 prelude CRC + 4 字节 message CRC（[aws-event-stream-parser.js:12-13](src/providers/claude/aws-event-stream-parser.js#L12-L13)），二进制拼接两份 capture 的中段切片**不会自然形成有效帧**——parser 会进入"sync loss"路径（[aws-event-stream-parser.js:31-37](src/providers/claude/aws-event-stream-parser.js#L31-L37)），最坏情况按 `MAX_SYNC_LOSS_RATIO=0.10` 直接丢弃整个 buffer。

**修订建议**：双工具场景**不要合成 .bin**，改为在测试里直接 mock 一组合成事件 array 喂进 [generateContentStream](src/providers/claude/claude-kiro.js#L2595) 的事件处理分支（绕过 parser 层）。具体做法：把 [generateContentStream](src/providers/claude/claude-kiro.js#L2595) 内的 toolUse 处理逻辑抽成纯函数（输入：事件 array，输出：yield 序列 + toolCalls 状态），然后双工具场景直接构造事件 array 喂进去。这正好顺道改善 Fix A 的 `flushOrDropToolCall` 抽象的可测性——一个抽象，两个收益。

---

## 二、行号偏差（轻微，语义对应正确，但落地时按实际行号对照即可）

| 计划声称 | 实际位置 | 性质 |
|---|---|---|
| 切换工具时收尾旧调用 = 2920 | 2913-2935（`isIncompleteFileToolCall` 在 2923）| ±10 行，语义对应 |
| `tc.stop=true` 帧内闭环 = 2980 | 2974-3000（判据在 2984）| ±5 行 |
| 独立 toolUseStop 事件 = 3034 | 3027-3054（判据在 3039）| ±5 行 |
| 流自然结束兜底 = 3066 | 3060-3088（判据在 3070）| ±5 行 |
| 立即下发 `content_block_start` = 2940-2949 | 实际 2940-2949 ✓ | 准确 |
| 立即下发首帧 `input_json_delta` = 2960-2972 | 实际 2960-2972 ✓ | 准确 |
| 续传 `input_json_delta` = 3015-3025 | 实际 3017-3025 ✓ | 准确 |
| `stopReason` 决策 = 3203 | 实际 3203 ✓ | 准确 |
| `inflationDelta` = 3189-3197 | 实际 3189-3197 ✓ | 准确 |
| `message_delta` + `message_stop` = 3199-3223 | 实际 3199-3223 ✓ | 准确 |
| `KIRO_CAPTURE_RAW` = 2380-2390 | 实际 2380-2390 ✓ | 准确 |
| `hasMessageStop` 声明 = 648 | 实际 648 ✓ | 准确 |
| 写入循环判定 = 741-748 | 实际 741-748 ✓ | 准确 |
| finally 兜底 = 973-1003 | 实际 973-1003 ✓ | 准确 |
| `createStreamErrorResponse` Claude 分支 = 2106-2115 | 实际 2106-2115 ✓ | 准确 |
| `isIncompleteFileToolCall` = 398-403 | 实际 398-403 ✓ | 准确 |

**结论**：除"4 处终态触发点"外其他行号都准确；4 处触发点的偏差是因为计划引用的是 `repairToolInputJson` 调用行，而不是判据/yield 行——不影响修复本身的正确性，但实施时建议以"判据行"为锚点（2923 / 2984 / 3039 / 3070），便于和 `flushOrDropToolCall` 对齐。

---

## 三、值得讨论的盲点（不阻塞落地，但建议在 PR 描述中提及）

### 盲点 1：Fix B 的兜底有一层 `!isRetry` 保护，计划没说

[common.js:973](src/utils/common.js#L973) 的 finally 补发条件是 `if (!responseClosed && !clientDisconnected.value && !isRetry)`。也就是说，**重试路径**下即使 `hasMessageStop=false` 也不会兜底补发——这其实让 Fix B 在重试路径上"双发 message_stop + error"的风险天然不存在。

但这个事实**并不削弱**计划要求"在 741-748 加入 `chunk?.type === 'error'` 判定"——非重试首发路径下兜底仍然会补发，所以判定必须加。计划在这一点上结论正确，只是没引用到这层 `!isRetry` 保护。建议在 PR-2 描述里点一句，便于评审者理解判定追加的实际触发面。

### 盲点 2：fixture 目录有 4 个文件，计划只提了 3 个

[tests/fixtures/kiro-stream/](tests/fixtures/kiro-stream/) 实际包含：`pure-text.bin` / `single-tool.bin` / `multi-tool.bin` / **`reasoning-text.bin`**（82KB）。计划在多处引用 fixture 目录时只列了前三个。`reasoning-text.bin` 在 [claude-kiro-parser-fixture.test.js:27-29](tests/providers/claude-kiro-parser-fixture.test.js#L27-L29) 已被使用。

**建议**：Phase 3 验证段补一条 "回归 fixture 包含 reasoning-text，断言 Fix A 的 thinking-only 场景行为不变"——避免回归测试漏掉 reasoning 路径。

### 盲点 3：`inflationDelta` 与上游截断之间的关系未被讨论

`OUTPUT_RESERVE_CONTEXT_PRESSURE` 启用时，[claude-kiro.js:3189-3197](src/providers/claude/claude-kiro.js#L3189-L3197) 会把 `input_tokens` 膨胀上报。计划 Phase 2 的"实验性配置"小节说"本轮 capture 期间无 `OUTPUT_RESERVE_*` 启用证据"——但没解释这个 reserve 机制本身**是否就是为了**应对 Kiro 上游的截断风险。如果是，那么 Fix B 的"error 帧触发 SDK 重试"是事后补救，而 reserve 是事前预防，两者目标重叠。

这超出本计划的修复范围，但值得在 [docs/pending-plans/compress the inputs/Input Token (Context) 压缩 — 防截断实施计划.md](docs/pending-plans/compress the inputs/Input Token (Context) 压缩 — 防截断实施计划.md) 的关联段落里点一句"本计划与 reserve 机制属于不同层面，可叠加"。**不影响 PR-1/PR-2 落地。**

### 盲点 4：`existing parser 已有截断测试`

[claude-kiro-parser.test.js:64-65](tests/providers/claude-kiro-parser.test.js#L64-L65) 已经有"buffer 末尾截掉 5 字节"的测试模式（用 `parseAwsEventStreamFrames` 验证 `remaining` 字段非 0）。计划新增 `truncated-edit` 套件时**直接套这套现有模式**即可，无需重写测试基础设施——但计划描述里没引用这个先例，落地时实施方可能错过这个参考。

**建议**：PR-2 描述中明确引用 [claude-kiro-parser.test.js:60-70](tests/providers/claude-kiro-parser.test.js#L60-L70) 作为新增 fixture 测试的模式参考。

---

## 四、计划的优点（应肯定）

1. **方法论扎实**：先抓 capture（Phase 1）→ 离线 replay（Phase 2）→ 数据落定再修（Phase 3），不是一上来就改代码。Phase 2 的 8 份 capture（5 失败 + 3 成功）数据足以支撑结论。
2. **结论 A/B/C 三分支预设**：Phase 2 完成后能用数据排除 B、防御 C、坐实 A——决策路径清晰。
3. **`flushOrDropToolCall` 抽象正确**：把 4 处分散逻辑收敛到单一函数是消除"漏改一处导致路径不一致"的最佳手段。计划对 blockIndex 状态机的 5 条规则（[fix-write-failed.md:236-242](docs/pending-plans/fix-delay-emit/fix-write-failed.md#L236-L242)）覆盖了多 tool_use 序列的 index 衔接，思考相当细。
4. **Fix B 的"先 message_delta 后 error"方案**：保住 token 计费 + 触发 abort/retry 两个目标同时达成，备选方案（在 error 帧 payload 扩展 usage）的否决理由（SDK 不读 error 帧的非标字段）有协议依据。
5. **配置开关四组合矩阵 + 冲突组合自动降级**：把 `DEFER=false && TRUNCATION_ERROR=true` 互斥状态强制改写到"完全旧行为"——降级方向选得对（更小副作用）。
6. **PR 拆分（D → A+B → 附加任务）**：按风险递增分批，PR-1 单 commit revert 兜底、PR-2 双开关回退、PR-3 独立可关——每层都有应急通道。
7. **error type 实测要求**：[fix-write-failed.md:465-470](docs/pending-plans/fix-delay-emit/fix-write-failed.md#L465-L470) 把 `overloaded_error` / `api_error` / `invalid_request_error` 的 SDK 重试行为做实测后再选型，是落地前必做且容易被忽略的一步。

---

## 五、建议的修订动作

落地前按以下顺序处理：

1. **修订修复 D 单测**：删除 case 9 / case 10（或改为 `MultiEdit` 走 default 返回 `false` 的两个反向 case），与"PR-1 不为 MultiEdit 添加分支"决定一致。
2. **补充 Fix B 多协议处理**：在 Phase 3 验证段加入 OpenAI/Gemini 客户端的 error 帧兼容路径——最小修订是把 `chunk.type === 'error'` 在写入循环里映射到 [createStreamErrorResponse](src/utils/common.js#L2106-L2115) 已有的协议适配。
3. **改用事件 array mock 替代双工具 .bin 合成**：把 `flushOrDropToolCall` 的事件处理逻辑抽成纯函数，双工具场景用合成 array 测试，不动 fixture 目录。
4. **校准 4 处终态触发点行号**：以判据行为锚（2923 / 2984 / 3039 / 3070），便于和 `flushOrDropToolCall` 调用点对齐。
5. **fixture 引用补 `reasoning-text.bin`**：Phase 3 回归测试加入 thinking-only 场景。

完成 1-3 后，PR-1 / PR-2 可以按计划顺序落地。4-5 是落地友好度优化，不阻塞。

---

## 关键文件（审阅引用）

- [src/providers/claude/claude-kiro.js](src/providers/claude/claude-kiro.js)（3622 行）— `isIncompleteFileToolCall` (398-403)、`generateContentStream` (2595-)、4 处终态触发点 (2913 / 2974 / 3027 / 3060)、流末尾收尾 (3199-3223)
- [src/utils/common.js](src/utils/common.js)（2141 行）— `hasMessageStop` (648)、写入循环判定 (741-748)、finally 兜底 (973-1003)、`createStreamErrorResponse` Claude 分支 (2106-2115)
- [src/providers/claude/aws-event-stream-parser.js](src/providers/claude/aws-event-stream-parser.js) — `parseAwsEventStreamFrames` 暴露 `remaining`，可直接用于截断检测
- [tests/providers/claude-kiro-parser-fixture.test.js](tests/providers/claude-kiro-parser-fixture.test.js)、[tests/providers/claude-kiro-parser.test.js](tests/providers/claude-kiro-parser.test.js) — 现成测试模板
- [tests/fixtures/kiro-stream/](tests/fixtures/kiro-stream/) — 实际包含 4 个 fixture（计划只提了 3 个）
