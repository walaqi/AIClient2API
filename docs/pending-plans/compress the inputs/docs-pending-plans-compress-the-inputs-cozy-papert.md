# Claude → Kiro additionalModelRequestFields 传递方案

## Context

当前 `buildCodewhispererRequest` 用 XML tag 注入 system prompt 来模拟 thinking（`<thinking_mode>adaptive</thinking_mode>`），且完全丢失 `output_config.effort` 和 `max_tokens`。Kiro 原生支持 `additionalModelRequestFields`，应直接传递这些字段。

## B1 解决：字段放置位置

**结论**：放在 `userInputMessageContext` 内。

依据：
- Kiro 请求结构中 `userInputMessageContext` 已承载 `toolResults` 和 `tools`——这些都是"请求级配置"
- `additionalModelRequestFields` 是 per-request 配置（不同轮次可能不同 effort），语义上属于 `currentMessage` 层级
- 抓包中未找到实际使用 `additionalModelRequestFields` 的 Kiro 请求（session 222 未使用 thinking），因此**实施后必须通过实际请求验证**（见验证步骤 1）
- 如果 `userInputMessageContext` 层级错误（静默失效），备选位置依次尝试：`currentMessage` 顶层 → `conversationState` 顶层

## B2 解决：参数传递（非实例变量）

改用函数参数，消除并发风险。

**修改签名**（[claude-kiro.js:1103](src/providers/claude/claude-kiro.js#L1103)）：
```js
async buildCodewhispererRequest(messages, model, tools = null, inSystemPrompt = null, thinking = null, { outputConfig, maxTokens } = {})
```

**两个调用点**统一改为：
```js
// line 1846 (callApi) 和 line 2309 (streamApiReal)
const requestData = await this.buildCodewhispererRequest(
    messages, model, body.tools, body.system, body.thinking,
    { outputConfig: body.output_config, maxTokens: body.max_tokens }
);
```

## B3 解决：完整 thinking 映射

对齐 `_generateThinkingPrefix`（line 1038-1055）的逻辑：

```js
function buildThinkingField(thinking) {
    if (!thinking || typeof thinking !== 'object') return null;
    const type = String(thinking.type || '').toLowerCase().trim();
    if (type === 'enabled') {
        const budget = Math.min(Math.max(thinking.budget_tokens || 10000, 1024), 128000);
        return { type: 'enabled', budget_tokens: budget };
    }
    if (type === 'adaptive') return { type: 'adaptive' };
    return null;
}
```

## 实施步骤

**文件**: [src/providers/claude/claude-kiro.js](src/providers/claude/claude-kiro.js)

### Step 1. 修改 `buildCodewhispererRequest` 签名

Line 1103: 追加 `{ outputConfig, maxTokens } = {}` 参数。

### Step 2. 在 `userInputMessageContext` 构建后、写入 `userInputMessage` 前插入

插入点：line 1666（`if (Object.keys(toolsContext)...` 之后，`if (Object.keys(userInputMessageContext).length > 0)` 之前）

```js
const additionalFields = {};
const thinkingField = buildThinkingField(thinking);
if (thinkingField) additionalFields.thinking = thinkingField;
if (outputConfig && typeof outputConfig === 'object' && outputConfig.effort) {
    additionalFields.output_config = { effort: outputConfig.effort };
}
if (maxTokens && maxTokens >= 1024) {
    additionalFields.max_tokens = maxTokens;
}
if (Object.keys(additionalFields).length > 0) {
    userInputMessageContext.additionalModelRequestFields = additionalFields;
}
```

### Step 3. 修改两个调用点

- Line 1846 (`callApi`): 追加 `{ outputConfig: body.output_config, maxTokens: body.max_tokens }`
- Line 2309 (`streamApiReal`): 同上

### Step 4. 保留 XML tag（保守方案）

不移除 `_generateThinkingPrefix` 和 XML tag 注入。对支持 `additionalModelRequestFields` 的模型，两者共存（XML tag 作为 fallback）。验证后如确认 field 优先，可在后续 PR 中移除 XML tag。

### 不做什么

- 不传 `metadata`、`context_management`
- 不改 tool/message 转换
- 不对 `max_tokens` 做 cap（直接透传原值，让 Kiro 自行拒绝非法值）

## C 项处理

- **C1 (output_config schema)**：无法预先验证 schema，直接透传。如 Kiro 忽略则无害。
- **C3 (双重 thinking)**：保守方案共存。验证步骤 2 会确认优先级。
- **C4 (两个调用点)**：已统一处理（Step 3）。

## 已知局限

- `additionalModelRequestFields` 的确切 JSON path 未经抓包验证（Kiro IDE 抓包中未使用该字段）。实施后必须通过实际请求验证。
- 对不支持 `additionalModelRequestFieldsSchema` 的模型（haiku-4.5, sonnet-4.5），该字段可能被忽略，XML tag fallback 仍有效。
- 双重 thinking 指令（XML + field）在支持 field 的模型上可能浪费少量 token（~50 chars），但不会产生冲突（Kiro 应优先使用结构化字段）。

## 验证

1. **字段位置验证**：发送带 `thinking: {type: "adaptive"}` 的请求，开启请求日志，确认 Kiro 响应中出现 thinking block。如果没有 thinking block → 字段位置错误，尝试移到 `currentMessage` 顶层。
2. **双重指令验证**：发送矛盾请求（XML: `enabled/budget=5000`, field: `adaptive`），观察 thinking 行为确认优先级。
3. **effort 验证**：发送 `output_config: {effort: "low"}`，确认响应明显更简短。
4. **回归验证**：对 haiku-4.5 发送带 thinking 的请求，确认 XML tag fallback 仍工作。

