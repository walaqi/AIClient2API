# 第一轮评审 — Kiro 输出截断缓解（参考 cursor2api v2.7.8）

被审计划: [/home/chris/.claude/plans/https-github-com-7836246-cursor2api-rel-shiny-hearth.md](../../../../.claude/plans/https-github-com-7836246-cursor2api-rel-shiny-hearth.md)

锚点核对：所有引用的行号 / 函数（[claude-kiro.js:1170](../../../src/providers/claude/claude-kiro.js#L1170)、[1192-1216](../../../src/providers/claude/claude-kiro.js#L1192-L1216)、[1331-1336](../../../src/providers/claude/claude-kiro.js#L1331-L1336)、[1493-1498](../../../src/providers/claude/claude-kiro.js#L1493-L1498)、[2587-2602](../../../src/providers/claude/claude-kiro.js#L2587-L2602)、[3006-3031](../../../src/providers/claude/claude-kiro.js#L3006-L3031)、[3253-3256](../../../src/providers/claude/claude-kiro.js#L3253-L3256)、[model-pricing.js:121-168](../../../src/utils/model-pricing.js#L121-L168)）已逐一对应原码核对，准确。计划整体正确性可靠，最大风险点（"必须在 `calculateCacheTokens` 之后膨胀"）已在文档中明确并给了正确的插入位置。下面是需要在第二轮处理的**阻断项 / 应改项 / 应澄清项**。

---

## 阻断项（必须解决后才进入实施）

### B1. `usage.input_tokens` 字段语义与"客户端阈值算式"未确证

计划在 [B 改动点](../../../.claude/plans/https-github-com-7836246-cursor2api-rel-shiny-hearth.md) 把膨胀加到 `nonCachedInputTokens`（即对外的 `input_tokens`），并保持 `cache_creation_input_tokens` / `cache_read_input_tokens` 不变。语义上 Anthropic 协议里这三者本就是 **加和** 关系，所以"客户端看到的总用量 = `inputTokens × pressureFactor`"成立。

但**触发 Claude Code 自动压缩的实际算式**没有在计划里被引用确证：客户端是用 `input_tokens` 单字段、还是 `input + cache_create + cache_read` 之和、还是看 `message_start.usage` vs `message_delta.usage`，都直接决定膨胀杠杆是否落在正确的字段上。如果客户端只看 `message_start`、或只看三者之和的某个子集，这次实施有可能完全无效但日志看起来都对。

**要求**：第二轮在计划里补一段"已验证客户端的判定路径"，至少给出来源（Claude Code 源码 / SSE 抓包 / 已知行为日志）；或在改动 A、B、C 三处**同时**膨胀（包括 `message_start`、`message_delta`、非流响应），把不确定性消化在实现侧。

---

### B2. `message_start` 与 `message_delta` 的输入数值不同源，膨胀应用方式应明确同步

- `message_start` 用的是 `estimatedInputTokens`（[claude-kiro.js:2584](../../../src/providers/claude/claude-kiro.js#L2584)，请求体本地分词器估算）。
- `message_delta` 用的是 `inputTokens`（[claude-kiro.js:2995-2998](../../../src/providers/claude/claude-kiro.js#L2995-L2998)，由上游 `contextUsagePercentage` 反算，含历史窗口）。

两者通常**不一致**且 `message_delta` 的数值通常更大。计划改动 A 仅对 `estimatedInputTokens` 乘 `pressureFactor`，改动 B 对 `inputTokens` 算 `inflationDelta` 后并入 `nonCachedInputTokens`。两边一致用乘法，没问题；但**计划里没有要求两个数值口径一致地暴露**：

- 如果客户端在 `message_start` 阶段就提前做"context usage estimate"决定是否压缩，A 处的小估值会让客户端压一次；之后 B 处的大值再来一次→可能让客户端二次压缩或抛出 `cumulative_usage` 异常。
- 如果客户端只看 `message_delta`（最终 usage），A 处的膨胀其实是冗余的，但也没坏处。

**要求**：在计划里明示"A、B 两处采用同一 `pressureFactor`、同一公式（乘法），都只在出口膨胀，不会被重复累积"，并加一行"如果客户端把 message_start 与 message_delta 的 usage 视作累积，需要在 message_delta 里仅膨胀差值"——给出二选一策略以及现在选的那一种的理由。

---

### B3. 配置项类型与上下界保护缺失

计划仅写"`OUTPUT_RESERVE_CONTEXT_PRESSURE` number 默认 1.0"，但实现细节没说明：
- 用户在 `configs/config.json` 写 `"1.35"`（字符串）时如何处理；
- 负数 / `0` / `NaN` / `Infinity` 如何兜底；
- 上界是否 clamp（设 `5.0` 时若真实输入已 50K，膨胀到 250K 超过 [`MODEL_CONTEXT_TOKENS`](../../../src/providers/claude/claude-kiro.js#L53) 的 200K 假设，可能反而触发客户端"超窗口"硬错误）。

**要求**：第二轮明确以下伪代码实现并写入计划：

```js
const raw = this.config?.OUTPUT_RESERVE_CONTEXT_PRESSURE;
let pressureFactor = Number.parseFloat(raw);
if (!Number.isFinite(pressureFactor) || pressureFactor < 1.0) pressureFactor = 1.0;
if (pressureFactor > 2.0) {
    logger.warn(`[Kiro Pressure] factor=${pressureFactor} clamped to 2.0`);
    pressureFactor = 2.0;
}
```

并在 `OUTPUT_RESERVE_TOOL_RESULT_MAX_CHARS` 上做相似的 `Number.parseInt + 下限` 防御。

---

## 应改项

### C1. 工具名映射方向 — `tool_use_id → 工具名` 用的是哪一个名字

计划在两处 tool_result 截断分支都需要"按工具类型选 head/tail 比例"。预扫的源是 `processedMessages` 中的 `assistant.content[].tool_use`，此时 `name` 是**Claude 侧名字**（`Read` / `Bash` / ...），与下游 `toolNameMaps.toKiroName(...)` 转换出的 Kiro 内部名不同。截断的判断必须落在**Claude 侧名字**上（因为 ratio 表是按 `Read`/`Bash`/`Glob`/`Grep` 写的）。

计划没有写"name 取自上游而非 Kiro 化后"的明示。第二轮请加一行明确："构 map 时使用 `assistant.content[i].name`（Claude 侧原名），不经过 `toKiroName` 转换。"

另外，`Glob` 在 Claude Code 里实际叫 `Glob`，但计划里写 "Glob/Grep"——确认现行 SDK 的工具名规范化是大小写敏感的（计划已指出工具描述截断白名单是大小写敏感）；如果客户端用的是小写名（如自定义 OpenAI 工具集），ratio 默认走 60/40 也是可接受的，但此时记录的 `tool=...` 日志会暴露这个 fallback——把它写进计划的"已识别取舍"里。

---

### C2. tool_result 截断之后 `getContentText` 的多块拼接顺序

[claude-kiro.js:1333](../../../src/providers/claude/claude-kiro.js#L1333) 与 [1495](../../../src/providers/claude/claude-kiro.js#L1495) 都是 `this.getContentText(part.content)`。截断必须发生在拿到这个 string 之后、写入 `toolResults` 之前；计划描述如此，没问题。

但需要补一行"文本类 tool_result 之外的形态（如 Anthropic 协议允许 tool_result 内嵌 image block）走原路径，不进截断"。当前 `getContentText` 把多块拍平成字符串，截断函数对 base64 图片字符串切刀会把图片切碎。建议：
- 在截断函数入口先判定 `text.length > maxLen && !looksLikeBase64(text)`，对疑似 base64 的整段保留或直接换占位符。
- 或者，截断仅作用于 `part.content[i].type === 'text'` 的文本块再用 `\n` 拼接前的纯文本，绕开图片。

最低限度：计划里写明"如发现头部出现 `data:image/...` 或 base64 模式则跳过截断"。

---

### C3. tool_use_id → tool_name 映射缺失 / 异常 fallback

如果 `tool_use_id` 在 map 里查不到（旧历史、跨会话、用户手工拼接的请求），按计划应当**走默认比例 60/40**而不是抛错。计划没明说默认行为，第二轮请加："`map.get(tool_use_id) ?? '__default__'`，未知工具一律走 60/40，并在日志加 `tool=__unknown__` 便于排查。"

---

### C4. 自适应描述阈值的输入计数边界

计划公式 `scale = max(0.25, min(1.0, (90 - n) / 85 + 0.25))` 中：
- `n` 取自 `filteredTools.length`，但该变量来自 [claude-kiro.js:1183](../../../src/providers/claude/claude-kiro.js#L1183) **`.filter(...).map(...)` 之前**，仍含"空 description"的工具。因此真实描述工具数会比 `n` 小。在低 n 区差别可忽略，在高 n 区会让阈值收得偏紧。
- `n=5` 时 `scale=1.297` → clamp 到 1.0 → 8K，正确。
- `n=90` → 0.25 → 2K，正确。
- 但 `n=170` → -0.694 → clamp 0.25 → 2K，**与 n=90 一样**，曲线在 90 之后是平的。Kiro 在大量 plugin 工具场景下（>120）需要进一步收紧的话，曲线得改。

**要求**：第二轮把 n 的口径明确（"过滤空 description 之后"），并把曲线写成可调表（哪怕只是常量 `[5,1.0],[40,0.6],[90,0.25],[160,0.15]`），便于实测后单点调整。

---

### C5. Bash 白名单与自适应阈值的语义交互

Bash 已在 [TRUNCATION_WHITELIST](../../../src/providers/claude/claude-kiro.js#L1177-L1179) 内绕过截断。自适应阈值的全局 `MAX_DESCRIPTION_LENGTH` 缩小，对 Bash **没有任何效果**（白名单先于截断判断生效）。这是 OK 的，但**必须写进计划**——否则未来读者可能会误以为"为什么开了自适应，工具列表 token 还没怎么省下来"。

第二轮在"改动三"末尾加一行说明，并指出"如发现 Bash 描述本身就是大头（>10K），单独引入 `BASH_DESC_BUDGET` 配置项，**不要解除白名单**"。

---

### C6. 非流模式 `buildClaudeResponse` 的 `if (isStream)` 旧路径

[buildClaudeResponse](../../../src/providers/claude/claude-kiro.js#L3059-L3258) 内部既有 `isStream === true` 的伪流分支（[3062-...](../../../src/providers/claude/claude-kiro.js#L3062)），也有最末的 `return { ... usage: { input_tokens, output_tokens } }`（[3253-3258](../../../src/providers/claude/claude-kiro.js#L3253-L3258)）。计划只点了后者。需要确认：
- `isStream` 那条路径目前是死代码（外部都改用 [claude-kiro.js:2587 及之后的真流](../../../src/providers/claude/claude-kiro.js#L2587)）吗？
- 如果还在被调用，需要在那条路径的 `message_start.usage.input_tokens`（[3076](../../../src/providers/claude/claude-kiro.js#L3076)）也乘上 `pressureFactor`，否则伪流场景下膨胀失效。

第二轮请用 `git grep` 调用图确认 `isStream=true` 路径是否还在被走，再决定是删除该分支还是同步修改。

---

## 应澄清项

### D1. cursor2api 1.35 数值不必照搬

参考文档解释 1.35 来自 cursor 实际窗口 ~150K vs 客户端假设 200K（200/150 ≈ 1.33）。Kiro 现在 [`TOTAL_CONTEXT_TOKENS = 200000`](../../../src/providers/claude/claude-kiro.js#L53)，与客户端假设一致；我们怀疑的"实际更紧"还没有量化证据。建议：

- 推荐起步值改为 **1.2**，加备注"先小后大，按末尾完整度迭代"。
- 计划在"验证"段加一步：开 1.0/1.2/1.35 三档对同一长中文 prompt 各跑一次，记录末尾 5 字是否完整、`STREAM_SUMMARY` 行的 `outTok` 是否落差明显。

### D2. `model-usage-stats` 高估问题的处置

计划在"已识别取舍"提了"开启时统计高估"。第二轮请加一句具体处置：在 `[Kiro Pressure]` 日志里同时打印 `real` 与 `inflated`，让运维 / 用户能从日志后处理时按真值做对账；或在膨胀时多发一个**仅计费用**的内部事件供统计插件订阅（建议先不做，但写进"未来增强项"）。

### D3. 措施 ② 与 cursor2api 的口径差异

参考文档里 v2.7.8 的"自适应历史预算"是从 `max_tokens`（输出预算）里**预留**给输出空间，不是收紧工具描述。Kiro 没有 `max_tokens` 字段（计划已指出），所以"压缩工具描述"是一个**功能等价但机制不同**的替代。计划标题用"措施 ②"容易让读者以为是 1:1 移植——建议改名为"措施 ②（Kiro 形变版）：自适应工具描述阈值"，并在概述里点出"与 cursor2api 同名机制非同义"。

### D4. 验证段对"自动压缩是否被触发"缺乏可观测信号

"用 Claude Code 客户端连接，请求一段长中文回复"只能检验末尾是否完整，但无法判别**末尾完整是因为 auto-compact 被提前触发，还是仅仅因为这次输入恰好不长**。建议：
- 在客户端侧抓取 `claude` CLI 的 transcript 日志（如有 `--debug`），找出 "context auto-compacted" 事件的时间戳。
- 或者构造一个**可重复**的复现 prompt：固定 system prompt + 固定 history + 固定提问，量化 `OUTPUT_RESERVE_CONTEXT_PRESSURE` 取 1.0/1.2/1.35 时的 `STREAM_SUMMARY.outTok` 与"末尾是否带句号"。

### D5. 配置发现性

计划"不动" `configs/config.json`，但默认关闭的开关如果没有可发现的入口，三个月后没人记得它存在。第二轮请至少：
- 在 `configs/config.example.json` 或等价 README 里追加一段被注释的示例（`// "OUTPUT_RESERVE_CONTEXT_PRESSURE": 1.2`）；
- 在 `[Kiro]` 启动日志（[claude-kiro.js:760 附近](../../../src/providers/claude/claude-kiro.js#L760)）里打印一行"`OUTPUT_RESERVE_*` 当前值"，让运维能从日志确认开关状态。

---

## 没问题的部分（无需改动，仅记录）

- **改动序：膨胀必须在 `calculateCacheTokens` 之后** —— 计划明确，[model-pricing.js:121-168](../../../src/utils/model-pricing.js#L121-L168) 反推公式如果以膨胀后的 `inputTokens` 为输入，`cache_creation` 会被压成 0、`cache_read` 会爆炸，这是最大的正确性陷阱，被避开。
- **不进 `estimateInputTokens`** —— 计划明示膨胀只发生在出口，不污染 retry / 内部诊断逻辑，决策正确。
- **`tool_use_id → tool_name` 预扫窗口** —— 取 `i < processedMessages.length - 1` 时正好覆盖到上一个 assistant 回合，能配上当前用户消息里的 tool_result。映射构造逻辑无问题。
- **head+tail helper 风格统一** —— 沿用 [1192-1216](../../../src/providers/claude/claude-kiro.js#L1192-L1216) 已有风格，可读性与一致性都好。
- **默认全关** —— 默认行为等价于改动前，不会回归现有用户。

---

## 第二轮交付建议

把 B1–B3 解决（最重要的是 B1：客户端阈值算式来源）、把 C1–C6 改进、把 D1–D5 澄清，然后：

1. 用 5–10 行代码片段写出 `pressureFactor` 取值、clamp、应用三处的最终代码雏形（不要进入实现，只是证明计划完备）。
2. 把"截断函数 + ratio 表 + 未知工具 fallback"做成单元化的模块伪码（约 20 行）。
3. 把验证段从"观察末尾丢字"升级为"观察 auto-compact 触发时机"，给出可重复 prompt。

完成后再进入实现。
