# 第一轮评审 — Claude → Kiro additionalModelRequestFields 传递方案

被审计划: [/home/chris/.claude/plans/docs-pending-plans-compress-the-inputs-cozy-papert.md](../../../../.claude/plans/docs-pending-plans-compress-the-inputs-cozy-papert.md)

总评：方向正确——用 Kiro 原生 `additionalModelRequestFields` 替代 XML tag hack 是正解。但计划在**字段放置位置**、**并发安全**、**thinking 映射完整性**三个关键点上存在缺陷或未验证假设，需要在实施前解决。

---

## 阻断项

### B1. `additionalModelRequestFields` 的放置层级未经抓包验证

计划将 `additionalModelRequestFields` 放入 `userInputMessageContext`（~line 1650）。但从代码结构看：

- `userInputMessageContext` 目前只承载 `toolResults` 和 `tools`（line 1651-1664）
- Kiro 的 `ListAvailableModels` 返回的 `additionalModelRequestFieldsSchema` 是模型级别的 schema，暗示该字段可能在请求顶层或 `currentMessage` 层级，而非嵌套在 `userInputMessageContext` 内

计划声称"抓包对比"了 session 222，但**没有贴出 Kiro 侧请求中 `additionalModelRequestFields` 的实际位置**。如果放错层级，Kiro 会静默忽略，thinking/effort 全部失效但不报错——这是最危险的静默失败模式。

**要求**：贴出 Kiro session 222 中包含 `additionalModelRequestFields` 的请求片段（JSON path），或用 `KIRO_CAPTURE_RAW=true` 发一个带 thinking 的请求确认字段被正确消费（响应中出现 thinking block）。

---

### B2. `this._outputConfig` / `this._maxTokens` 实例变量造成并发污染

计划方案：
```js
// 在 generateContentStream 中
this._outputConfig = requestBody.output_config || null;
this._maxTokens = requestBody.max_tokens || null;
// 然后调用 buildCodewhispererRequest
```

问题：`claude-kiro.js` 的 provider 实例是**单例**（整个进程共享一个实例）。如果两个请求并发进入 `generateContentStream`：

1. 请求 A 设置 `this._outputConfig = {effort: "low"}`
2. 请求 B 设置 `this._outputConfig = null`（无 output_config）
3. 请求 A 的 `buildCodewhispererRequest` 读到 `this._outputConfig = null` ← 被 B 覆盖

这在 Claude Code 的 agent continuation 场景下完全可能发生（tool_result 回来后立即发下一轮，前一轮的流还没结束）。

**要求**：改为参数传递。`buildCodewhispererRequest` 签名已有 `thinking`，追加 `outputConfig` 和 `maxTokens` 参数：

```js
async buildCodewhispererRequest(messages, model, tools, inSystemPrompt, thinking, { outputConfig, maxTokens } = {})
```

调用处（line 1846, 2309）改为：
```js
await this.buildCodewhispererRequest(messages, model, body.tools, body.system, body.thinking, {
    outputConfig: body.output_config,
    maxTokens: body.max_tokens
});
```

---

### B3. `thinking` 字段映射不完整——丢失 `budget_tokens` 和 `effort`

计划代码：
```js
if (thinking && typeof thinking === 'object') {
    additionalFields.thinking = { type: thinking.type || 'adaptive' };
}
```

Claude API 的 thinking 对象有三种形态：

1. `{type: "enabled", budget_tokens: 10000}` — 强制开启，有预算上限
2. `{type: "adaptive"}` — 自适应（可选附带 effort）
3. `{type: "disabled"}` — 关闭

当前 `_generateThinkingPrefix`（line 1038-1051）已正确处理了 `budget_tokens` 和 effort（通过 XML tag）。但计划的 `additionalModelRequestFields.thinking` 只传了 `{type}` ，丢失了：
- `budget_tokens`（enabled 模式必须有）
- thinking 内部的 effort hint（如果 Kiro schema 支持）

**要求**：映射应与 XML tag 逻辑对齐：
```js
if (thinking && typeof thinking === 'object') {
    const thinkingField = { type: thinking.type || 'adaptive' };
    if (thinking.type === 'enabled' && thinking.budget_tokens) {
        thinkingField.budget_tokens = thinking.budget_tokens;
    }
    additionalFields.thinking = thinkingField;
}
```

---

## 应改项

### C1. `output_config.effort` 与 `thinking.effort` 的语义区分

Claude API 中：
- `output_config: {effort: "low"}` → 控制**推理深度**（整体响应质量/速度权衡）
- `thinking.type: "adaptive"` + 客户端在 system prompt 注入 `<thinking_effort>low</thinking_effort>` → 控制 thinking block 的详细程度

计划将 `output_config` 直接透传到 `additionalModelRequestFields.output_config`，但没有确认 Kiro 的 `additionalModelRequestFieldsSchema` 中是否存在 `output_config` 字段。从计划的"抓包对比"表看，Kiro 侧对应列写的是 `additionalModelRequestFields.output_config`，但这是**期望映射**还是**已验证的 schema 字段**？

**要求**：确认 `ListAvailableModels` 返回的 schema 中 `output_config` 的确切结构。如果 schema 中不存在该字段，Kiro 可能静默忽略。

---

### C2. `max_tokens` 的 128000 上限缺乏依据

```js
if (this._maxTokens && this._maxTokens >= 1024) {
    additionalFields.max_tokens = Math.min(this._maxTokens, 128000);
}
```

为什么 cap 在 128000？Claude Code 通常发送 `max_tokens: 16384` 或 `max_tokens: 10000`。Kiro 模型的实际 max output token 限制是多少？如果 Kiro 本身有更低的上限（如 Kiro 抓包中观察到的输出截断问题），这个 cap 可能需要下调。

**要求**：
- 说明 128000 的来源（schema constraint? 经验值?）
- 考虑是否应该直接透传原值不做 cap（让 Kiro 自己拒绝非法值）

---

### C3. 双重 thinking 指令的风险未量化

计划建议"保守方案——同时保留 XML tag 和 additionalModelRequestFields"。理由是部分模型不支持 `additionalModelRequestFields`。

问题：对于**支持**该字段的模型（opus-4.7/4.6, sonnet-4.6），同时收到：
- system prompt 中的 `<thinking_mode>adaptive</thinking_mode>`
- `additionalModelRequestFields.thinking: {type: "adaptive"}`

**可能的后果**：
1. Kiro 优先使用 `additionalModelRequestFields`，XML tag 被当作普通 system prompt 文本 → 浪费 token 但无害
2. Kiro 两者都处理 → 可能产生冲突（如 XML 说 enabled + budget=50000，field 说 adaptive）
3. Kiro 以 XML tag 为准，忽略 field → `additionalModelRequestFields` 完全无效

**要求**：用一次实际请求验证。发送一个同时包含 XML tag（`<thinking_mode>enabled</thinking_mode><max_thinking_length>5000</max_thinking_length>`）和 `additionalModelRequestFields.thinking: {type: "adaptive"}` 的**矛盾**请求，观察响应中 thinking block 的行为：
- 如果 thinking block 很短且无 budget 限制 → field 优先
- 如果 thinking block 被 5000 token 截断 → XML 优先
- 如果报错 → 冲突

---

### C4. 两个调用点（line 1846 和 line 2309）行为应一致

`buildCodewhispererRequest` 有两个调用点：
- line 1846：非流式路径
- line 2309：另一个路径（需确认是流式还是重试）

计划只在 `generateContentStream` 中提取 `output_config`/`max_tokens`，但 line 1846 在不同的方法中。如果走 line 1846 路径的请求也携带了这些字段，会被丢弃。

**要求**：确认 line 2309 的调用上下文，确保两个路径都能正确传递新字段。

---

## 应澄清项

### D1. "不做什么"段中 `metadata` 的处置可以更明确

计划说"不传 metadata — Kiro 不需要"。但 `metadata.user_id` 在 Anthropic 协议中用于 abuse tracking。如果 Kiro 内部有类似需求（如 rate limiting per user），将来可能需要。

建议在计划中加一句："如未来 Kiro API 出现 per-user quota 问题，可考虑将 `metadata.user_id` 映射到请求 header 或独立字段。"

### D2. `_hasThinkingPrefix` 的防重复注入逻辑（line 1138）在新方案下的角色

当 `additionalModelRequestFields.thinking` 生效时，XML tag 作为 fallback 仍会被注入 system prompt（保守方案）。`_hasThinkingPrefix` 检查防止重复注入 XML tag——这个逻辑在新方案下仍然需要，但计划没有提及是否修改它。

如果未来决定移除 XML tag（非保守方案），需要同时移除 `_hasThinkingPrefix` 检查和 `_generateThinkingPrefix` 调用。建议在计划的"移除 XML tag（可选）"段落中列出完整的删除清单。

---

## 已正确处理（无需改动）

- 抓包对比表覆盖全面，明确标注了哪些字段"已正确"、哪些需要优化
- 不改 tool/message 转换的决定正确——这些已经工作良好
- 不传 `context_management` 的判断正确——Kiro 无此功能
- 对"哪些模型支持 `additionalModelRequestFields`"的风险识别（opus-4.7/4.6, sonnet-4.6 有 schema，其他没有）准确
- 保守方案的方向（先加不删）符合"默认不回归"原则

---

## 第二轮交付建议

优先级排序：

1. **B1**（阻断）：贴出 Kiro 真实请求中 `additionalModelRequestFields` 的 JSON path。这是整个方案的前提。
2. **B2**（阻断）：改用参数传递，消除并发风险。给出修改后的函数签名和调用代码。
3. **B3**（阻断）：补全 thinking 映射（`budget_tokens`）。
4. **C3**（重要）：做一次矛盾请求实验，确认 XML tag 与 field 的优先级关系，据此决定是否在支持 field 的模型上跳过 XML tag 注入。
5. **C4**（重要）：确认两个调用点的对齐方案。

B1 如果确认位置错误，整个方案需要重写插入点；如果位置正确，其余改动量很小（~20 行）。建议先做 B1 验证再处理其余项。
