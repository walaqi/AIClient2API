# 第一轮评审 — Input Token 压缩防截断实施计划 (cozy-papert)

被审计划: [/home/chris/.claude/plans/docs-pending-plans-compress-the-inputs-cozy-papert.md](../../../../.claude/plans/docs-pending-plans-compress-the-inputs-cozy-papert.md)

## 总评

本计划是对前两轮评审（review-1, review-2）反馈的精简重写版。结构清晰、措施独立、默认关闭的设计正确。与 v1/v2 相比，关键改进：
- 膨胀作用域收窄为仅 `message_delta`（解决了 review-2 B2）
- base64 跳过采用简单前缀判定（解决了 review-2 B1）
- 自适应描述用线性插值表（解决了 review-2 C2）
- 配置防御明确写了 parseFloat + clamp（解决了 review-1 B3）

但精简过程中丢失了部分关键细节，下面按优先级列出。

---

## 阻断项（必须解决后才进入实施）

### B1. tool_result 截断的插入点时序与 `getContentText` 的关系未明确

计划说"插入点：`buildCodewhispererRequest` 中两处 `tool_result` 处理（~line 1346, ~line 1508）"。

实际代码（line 1348, 1510）的模式是：
```js
content: [{ text: this.getContentText(part.content) }],
```

截断必须发生在 `getContentText()` 返回之后、写入 push 之前。但计划没有明确：
1. 截断函数的**调用位置**是包裹 `getContentText` 的返回值，还是替换整个 content 构造？
2. 如果 `part.content` 包含多个 block（text + image 混合），`getContentText` 会把它们拼成一个 string——此时截断可能切到图片 base64 的尾部。计划虽说"跳过 `data:image/` 或 `data:application/` 前缀"，但这只覆盖**整段**是 base64 的情况，不覆盖**拼接后中间出现** base64 片段的情况。

**要求**：明确截断的伪代码调用形式，例如：
```js
const rawText = this.getContentText(part.content);
const text = shouldTruncate ? truncateHeadTailByTool(rawText, toolName, maxChars) : rawText;
toolResults.push({ content: [{ text }], ... });
```
并说明 `looksLikeDataUri(rawText)` 判定在截断函数内部还是外部。

---

### B2. `toolUseIdToName` 映射的构建时机与作用域不清

计划说"需要先构建 `toolUseIdToName` 映射（从 assistant 消息的 tool_use 块提取）"，但没有说明：

1. **构建位置**：是在 `buildCodewhispererRequest` 入口处一次性扫描全部 `messages`，还是在每个 user message 处理前向上回溯最近的 assistant message？
2. **name 来源**：assistant 消息中的 `tool_use.name` 是 Claude 侧原名（`Read`/`Bash`）还是经过 `toKiroName()` 转换后的名字？截断比例表用的是 Claude 侧名字（Read/Bash/Grep），所以映射必须取 Claude 侧原名。但 [claude-kiro.js:1517](src/providers/claude/claude-kiro.js#L1517) 显示 tool_use 在构建请求时已经被 `toKiroName()` 转换了——如果映射从已构建的 processed messages 中提取，拿到的是 Kiro 名而非 Claude 名。
3. **跨消息边界**：第一处 tool_result（~line 1346）处理的是"首条 user message"，此时 assistant 消息可能还没被遍历到。映射必须在遍历开始前预扫全部消息。

**要求**：明确映射构建的伪代码和位置（建议在 `buildCodewhispererRequest` 入口、遍历 messages 之前做一次全量预扫）。

---

### B3. 膨胀公式中 `inputTokens` 的来源与 edge case

计划写"膨胀公式：`inflationDelta = Math.round(inputTokens * (pressureFactor - 1))`，加到 `nonCachedInputTokens`"。

实际代码 [claude-kiro.js:3078](src/providers/claude/claude-kiro.js#L3078)：
```js
const nonCachedInputTokens = Math.max(0, inputTokens - cacheCreationTokens - cacheReadTokens);
```

如果膨胀加到 `nonCachedInputTokens` 上，最终 `message_delta.usage.input_tokens` = `nonCachedInputTokens + inflationDelta`。但 Anthropic 协议语义是 `total_input = input_tokens + cache_creation + cache_read`。客户端计算总用量时会把三者相加，所以膨胀后的"客户端感知总输入" = `(nonCached + delta) + cacheCreation + cacheRead` = `inputTokens + delta`。这是正确的。

但 edge case：当 `inputTokens` 来自 `contextUsagePercentage` 反算（line 3065-3069）且反算值异常小（如上游返回 percentage=0.01），`inflationDelta` 也会很小，膨胀几乎无效。而当 `inputTokens` fallback 到 `estimatedInputTokens`（line 3072，上游未返回 percentage 时），估算值通常偏小，膨胀效果也打折。

**要求**：在计划中补充"膨胀下限"策略——当 `inflationDelta < 某阈值`（如 1000 tokens）时，是否仍然应用？或者设一个最小膨胀量？至少写进"已知偏差"。

---

## 应改项

### C1. 截断比例表的工具名大小写敏感性

计划写"截断比例按工具类型：Read 50/50, Bash 25/75, Grep/Search 80/20, 默认 60/40"。

需要明确：
- `Grep` 还是 `grep`？`Search` 还是 `search`？Claude Code 工具名是首字母大写（`Read`, `Bash`, `Grep`, `Glob`），但如果映射取自 Kiro 转换后的名字，可能是不同格式。
- 建议在截断函数内部做 case-insensitive 匹配，或者在 ratio 表中统一用小写 key + `toolName.toLowerCase()` 查找。

---

### C2. `pickAdaptiveDescBudget` 的 "线性插值" 需要明确是阶跃还是连续

计划写"线性插值表：5 工具→8192, 40→4096, 90→2048, 160→1024"。

review-2 C2 已经指出阶跃曲线的问题并给出了线性插值代码。但本计划只写了"线性插值表"四个字，没有给出实现方式。如果实施者理解为"查表取最近的阈值"（阶跃），就会重蹈 review-2 指出的问题。

**要求**：在计划中明确写出插值方式为"相邻两点之间线性内插"，或直接给出 5 行伪代码。

---

### C3. `TRUNCATION_WHITELIST` 与自适应阈值的交互未说明

计划提到"`TRUNCATION_WHITELIST`（当前只有 Bash）中的工具不受影响"，但没有说明这是指：
- (a) Bash 的 description 不被自适应阈值截断（白名单绕过），还是
- (b) Bash 的 tool_result 不被措施 2 截断

从上下文看应该是 (a)，但措施 2 和措施 3 都涉及"截断"概念，容易混淆。

**要求**：明确 `TRUNCATION_WHITELIST` 只作用于措施 3（工具描述截断），与措施 2（tool_result 截断）无关。措施 2 对所有工具的 tool_result 都生效（包括 Bash），只是比例不同。

---

### C4. 验证段缺乏可重复的定量测试方法

验证第 5 条"正常对话中 tool 调用（Write/Read/Bash）仍能正确执行"是主观判断。review-2 C4 建议了确定性 prompt 方案（数字序列输出，检查末尾完整性），本计划未采纳。

**建议**：至少补充一个可重复的回归测试场景：
- 构造一个包含 3+ 轮 tool_use/tool_result 历史的固定请求
- 开启措施 2 后发送，验证响应中的 tool_use 调用格式正确、参数完整
- 这比"正常对话"更可控

---

### C5. 配置项命名与 `config.json.example` 的同步

计划列了 5 个配置项但只说"更新 `configs/config.json.example`"。从 explore 结果看，config.json.example 中**已经存在**这 5 个配置项（来自之前被 revert 的实现）。需要确认：
- 这些配置项是否在 revert 时被一并删除了？
- 如果还在，是否需要更新默认值或注释？

---

## 应澄清项

### D1. 膨胀在长输出场景下自动失效（继承自 review-2 D1）

当 `outputTokens` 接近 `totalTokens` 时，反算的 `inputTokens → 0`，`inflationDelta = 0`。这意味着措施 1 对"已经输出很多、末尾挣扎"的场景无效——而这恰恰是截断最常发生的场景。

本计划未提及这个已知限制。应写入"已知偏差"或"局限性"段落。

### D2. 三个措施的预期效果量级缺乏估算

计划没有给出任何量化预期：
- 措施 1（压力膨胀 1.2x）：预期让客户端提前多少轮触发 auto-compact？
- 措施 2（tool_result 截断 8192 字符）：典型场景下能省多少 token？（一个 Read 大文件的 tool_result 可能 20K+ 字符 ≈ 5K+ tokens）
- 措施 3（自适应描述）：90 个工具从 8192→2048 字符，预期省多少 token？

即使是粗略估算也有助于判断优先级和验证效果。

### D3. `OUTPUT_RESERVE_CONTEXT_PRESSURE_SCOPE` 配置项去向

review-2 B2 建议增加 `OUTPUT_RESERVE_CONTEXT_PRESSURE_SCOPE = "delta_only" | "all"` 配置项。本计划选择了"仅 message_delta"的方案（正确），但没有保留这个配置项。如果未来需要扩展到 message_start，是否需要预留这个开关？

建议：当前不需要，但在代码注释中标注"如需扩展到 message_start，参考 review-2 B2"。

---

## 没问题的部分（无需改动）

- **膨胀在 `calculateCacheTokens` 之后**：计划明确，执行序正确
- **默认全关**：不设配置 → 行为不变，零回归风险
- **三措施独立**：任一关闭不影响其他，可逐步开启验证
- **不动 tool 解析路径**：`parseEventStreamChunk`、`streamApiReal` 不修改，避免重蹈 53b365f 覆辙
- **仅 `message_delta` 膨胀**：比三处同步更安全，避免 message_start/delta 跳变
- **base64 跳过用前缀判定**：简单可靠，避免 review-2 B1 的 `looksLikeBase64Block` 假阳性问题

---

## 总结与建议

| 优先级 | 项目 | 工作量 |
|--------|------|--------|
| 阻断 | B1: 截断调用位置伪代码 | 5 行 |
| 阻断 | B2: toolUseIdToName 构建时机与 name 来源 | 10 行 |
| 阻断 | B3: 膨胀 edge case / 下限策略 | 3 行说明 |
| 应改 | C1: 工具名大小写 | 1 行说明 |
| 应改 | C2: 插值方式明确 | 5 行伪代码 |
| 应改 | C3: 白名单作用域澄清 | 2 行说明 |
| 应改 | C4: 可重复验证场景 | 5 行 |
| 应改 | C5: config.json.example 现状确认 | 确认即可 |
| 澄清 | D1-D3 | 写入"已知偏差"段 |

建议解决 B1-B3 后即可进入实施。C 项和 D 项可在实施过程中同步完善。
