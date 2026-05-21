# 第二轮评审 — Claude → Kiro additionalModelRequestFields 传递方案

被审计划: [/home/chris/.claude/plans/docs-pending-plans-compress-the-inputs-cozy-papert.md](../../../../.claude/plans/docs-pending-plans-compress-the-inputs-cozy-papert.md)

总评：v2 正确解决了 B2（并发安全）和 B3（budget_tokens 映射），B1 诚实承认未验证并给出了 fallback 策略。计划已接近可实施状态，但 `buildThinkingField` 的 budget 上限与现有 XML 路径严重不一致，且 adaptive 模式丢失 effort 字段。修正这两处后可直接进入实现。

---

## 阻断项

### B1. `buildThinkingField` 的 budget_tokens 上限与 XML 路径不一致（128000 vs 8192）

计划代码：
```js
const budget = Math.min(Math.max(thinking.budget_tokens || 10000, 1024), 128000);
```

现有 `_normalizeThinkingBudgetTokens`（line 1028-1035）：
```js
// MIN_BUDGET_TOKENS = 1024, MAX_BUDGET_TOKENS = 1024*8 = 8192
value = Math.min(value, KIRO_THINKING.MAX_BUDGET_TOKENS);  // cap at 8192
```

后果：保守方案下两者共存时，XML tag 发送 `<max_thinking_length>8192</max_thinking_length>`，而 `additionalModelRequestFields.thinking.budget_tokens = 128000`。如果 Kiro 优先使用 field，thinking 预算从 8192 暴涨到 128000——这会大幅增加 output token 消耗，可能加剧截断问题（thinking 占满 output budget，正文被截断）。

**要求**：`buildThinkingField` 应复用 `_normalizeThinkingBudgetTokens` 的逻辑（或直接调用它），确保两条路径的 budget 一致：

```js
function buildThinkingField(thinking) {
    if (!thinking || typeof thinking !== 'object') return null;
    const type = String(thinking.type || '').toLowerCase().trim();
    if (type === 'enabled') {
        // 复用现有常量，保持与 XML tag 路径一致
        let budget = Number(thinking.budget_tokens);
        if (!Number.isFinite(budget) || budget <= 0) budget = KIRO_THINKING.DEFAULT_BUDGET_TOKENS;
        budget = Math.floor(budget);
        budget = Math.max(budget, KIRO_THINKING.MIN_BUDGET_TOKENS);
        budget = Math.min(budget, KIRO_THINKING.MAX_BUDGET_TOKENS);
        return { type: 'enabled', budget_tokens: budget };
    }
    if (type === 'adaptive') return { type: 'adaptive' };
    return null;
}
```

注：`KIRO_THINKING.DEFAULT_BUDGET_TOKENS = 20000` 但 `MAX_BUDGET_TOKENS = 8192`，所以 default 实际被 clamp 到 8192。这是现有代码的设计（可能是故意限制 thinking 长度以留 output 空间），plan 不应绕过它。

---

### B2. adaptive 模式丢失 `effort` 字段

`_generateThinkingPrefix`（line 1047-1051）对 adaptive 模式提取并规范化 `thinking.effort`：
```js
if (type === 'adaptive') {
    const effortRaw = typeof thinking.effort === 'string' ? thinking.effort : '';
    const effort = effortRaw.toLowerCase().trim();
    const normalizedEffort = (effort === 'low' || effort === 'medium' || effort === 'high') ? effort : 'high';
    return `<thinking_mode>adaptive</thinking_mode><thinking_effort>${normalizedEffort}</thinking_effort>`;
}
```

但计划的 `buildThinkingField` 对 adaptive 只返回 `{ type: 'adaptive' }`，**完全丢失 effort**。

Claude Code 在发送 `thinking: {type: "adaptive"}` 时，effort 信息通过 `output_config.effort` 或 thinking 对象本身传递。如果 Kiro 的 `additionalModelRequestFields` schema 支持 thinking effort，丢失它意味着所有 adaptive 请求都按默认 effort 处理（可能是 high），即使客户端请求了 low effort。

**要求**：
```js
if (type === 'adaptive') {
    const field = { type: 'adaptive' };
    const effortRaw = typeof thinking.effort === 'string' ? thinking.effort.toLowerCase().trim() : '';
    if (effortRaw === 'low' || effortRaw === 'medium' || effortRaw === 'high') {
        field.effort = effortRaw;
    }
    return field;
}
```

---

## 应改项

### C1. 验证步骤 1 的判定条件不充分

计划：
> 发送带 `thinking: {type: "adaptive"}` 的请求，确认 Kiro 响应中出现 thinking block。如果没有 thinking block → 字段位置错误

问题：当前 XML tag 注入（保守方案保留）**本身就能触发 thinking block**。即使 `additionalModelRequestFields` 放错位置被忽略，XML tag 仍会让 Kiro 返回 thinking block。所以"有 thinking block"不能证明 field 生效。

**正确的验证方法**：
1. **移除 XML tag 注入**（临时），只保留 `additionalModelRequestFields`，发送请求
2. 如果有 thinking block → field 位置正确
3. 如果没有 → field 被忽略，位置错误

或者用计划已有的验证步骤 2（矛盾请求），但需要先确认 XML tag 和 field 的优先级。

**要求**：修改验证步骤 1 为"临时注释掉 `_generateThinkingPrefix` 调用，仅依赖 `additionalModelRequestFields` 发送 thinking 请求"。

---

### C2. fallback 位置策略缺少具体代码路径

计划说"备选位置依次尝试：`currentMessage` 顶层 → `conversationState` 顶层"，但没有给出这两个备选位置的代码。

`currentMessage` 顶层意味着：
```js
request.conversationState.currentMessage.additionalModelRequestFields = additionalFields;
```

`conversationState` 顶层意味着：
```js
request.conversationState.additionalModelRequestFields = additionalFields;
```

**要求**：在计划中写出这两个备选的具体代码行（各一行），方便验证失败时快速切换，不需要重新理解请求结构。

---

### C3. `maxTokens` 的下限检查 `>= 1024` 可能过滤合法值

```js
if (maxTokens && maxTokens >= 1024) {
    additionalFields.max_tokens = maxTokens;
}
```

Claude Code 在某些场景（如 quick edit、inline completion）可能发送 `max_tokens: 512` 或更小的值。`>= 1024` 的门槛会静默丢弃这些值，导致 Kiro 使用默认 max_tokens（可能更大），浪费 token 或产生过长响应。

**建议**：去掉下限检查，或降到 `>= 1`：
```js
if (typeof maxTokens === 'number' && maxTokens >= 1) {
    additionalFields.max_tokens = maxTokens;
}
```

---

## 应澄清项

### D1. Step 2 插入点描述与实际行号有偏差

计划说"插入点：line 1666"，描述为"`if (Object.keys(toolsContext)...` 之后"。实际代码：
- line 1663: `if (Object.keys(toolsContext).length > 0 && toolsContext.tools)`
- line 1665: `}`（该 if 的闭合括号）
- line 1667: `// 只有当 userInputMessageContext 有内容时才添加`
- line 1668: `if (Object.keys(userInputMessageContext).length > 0)`

所以插入点应该是 **line 1665 之后、line 1667 之前**。这不影响正确性，但精确的行号能避免实施时插错位置。

### D2. `output_config` 与 `thinking.effort` 的关系需要文档化

Claude API 中：
- `output_config: {effort: "low"}` → 控制整体推理深度（Claude Code 用这个）
- `thinking.effort` → 在 thinking 对象内部（较少见）

两者可能同时存在。计划分别处理了 `additionalFields.output_config` 和 `buildThinkingField` 中的 effort，这是正确的。但应在计划中加一句说明："两个 effort 字段语义不同：`output_config.effort` 控制整体响应深度，`thinking.effort` 控制 thinking block 详细程度。两者独立传递，不互相覆盖。"

---

## 已正确处理（相比 v1 的改进）

- B2 并发问题：改用解构参数 `{ outputConfig, maxTokens } = {}` 传递，签名向后兼容，两个调用点统一修改——正确
- B3 budget_tokens：`buildThinkingField` 独立为纯函数，逻辑清晰——方向正确（但上限需修正，见 B1）
- "不做什么"段明确不 cap max_tokens——合理（让 Kiro 自行拒绝）
- 保守方案（XML + field 共存）的风险已写入"已知局限"——透明
- 验证步骤 2（矛盾请求）设计合理——能确定优先级
- 两个调用点（line 1846 + 2309）统一处理——消除了 C4 问题

---

## 第三轮交付建议（或直接实施）

只剩 2 个阻断项需要修正：

1. **B1**：`buildThinkingField` 的 budget clamp 改为复用 `KIRO_THINKING` 常量（3 行改动）
2. **B2**：adaptive 分支加上 effort 字段（4 行改动）

加上 1 个应改项：

3. **C1**：验证步骤 1 改为"临时禁用 XML tag 注入"方式验证

这三处都是小改动（总计 ~10 行），可以直接在实施时修正，不需要再出一轮计划。建议直接进入实现。
