# Input Token (Context) 压缩 — 防截断实施计划

## Context

Kiro API 的 output token 预算有限。当 input_tokens 过大（如 41636），API 在生成 Write 工具的 `content` 字段前就耗尽 output budget 并截断。根因已通过 KIRO_CAPTURE_RAW 确认：API 自身停止发送，非代理端问题。

**目标**：通过三个独立措施减少实际 input token 消耗 + 让客户端提前触发自动压缩，给 output 留更多空间。

**前次失败教训**：commit 53b365f 回退了上一次实施，原因是"严重影响了tool的执行"。本次策略：三个措施完全独立、默认全部关闭、不修改 tool 解析/执行路径。

---

## 措施 1：上下文压力膨胀

**配置**：`OUTPUT_RESERVE_CONTEXT_PRESSURE`（默认 `1.0` = 关闭，推荐 `1.2`，clamp `[1.0, 2.0]`）

**插入点**：`generateContentStream` 的 `message_delta` yield 处（`calculateCacheTokens` 之后）

```js
// 在 const nonCachedInputTokens = ... 之后：
const reserve = getOutputReserveConfig(this.config);
const inflationDelta = reserve.pressureFactor > 1.0
    ? Math.max(1000, Math.round(inputTokens * (reserve.pressureFactor - 1)))
    : 0;
const reportedNonCached = nonCachedInputTokens + inflationDelta;
if (inflationDelta > 0) {
    logger.info(`[Kiro Pressure] message_delta: realInput=${inputTokens} nonCached=${nonCachedInputTokens} reported=${reportedNonCached} delta=${inflationDelta}`);
}
// yield 中用 reportedNonCached 替代 nonCachedInputTokens
```

**已知局限**：当 `inputTokens` 反算值极小（长输出占满窗口时 → 0），膨胀自动失效。此时截断已不可避免，措施 1 主要在"输入多、输出刚开始"阶段起作用（提前压缩腾出空间）。

---

## 措施 2：tool_result 智能截断

**配置**：`OUTPUT_RESERVE_TOOL_RESULT_TRUNCATE`（默认 `false`），`OUTPUT_RESERVE_TOOL_RESULT_MAX_CHARS`（默认 `8192`，下限 `1024`）

**toolUseIdToName 映射构建**（在 `buildCodewhispererRequest` 入口、遍历 messages 之前）：
```js
const toolUseIdToName = new Map();
for (const m of messages) {  // 原始 messages 参数，未经 toKiroName 转换
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const part of m.content) {
        if (part?.type === 'tool_use' && part.id && part.name) {
            toolUseIdToName.set(part.id, part.name);  // Claude 侧原名
        }
    }
}
```

**截断调用位置**（两处 tool_result 分支，~line 1346 和 ~line 1508）：
```js
} else if (part.type === 'tool_result') {
    let trText = this.getContentText(part.content);
    if (reserve.truncateOn && trText.length > reserve.truncateMax) {
        const toolName = toolUseIdToName.get(part.tool_use_id) || '';
        const result = truncateHeadTailByTool(trText, reserve.truncateMax, toolName);
        if (result.truncated) {
            logger.info(`[Kiro] Truncated tool_result (tool=${toolName}, ${trText.length} -> ${result.text.length})`);
            trText = result.text;
        }
    }
    toolResults.push({ content: [{ text: trText }], status: 'success', toolUseId: part.tool_use_id });
}
```

**截断函数**（`looksLikeDataUri` 判定在函数内部）：
```js
const TOOL_RESULT_RATIOS = { Read: 0.5, Bash: 0.25, Grep: 0.8, Glob: 0.8 };

function truncateHeadTailByTool(text, maxLen, toolName) {
    if (!text || text.length <= maxLen) return { text, truncated: false };
    if (text.startsWith('data:image/') || text.startsWith('data:application/')) {
        return { text, truncated: false };
    }
    const headRatio = TOOL_RESULT_RATIOS[toolName] ?? 0.6;  // case-sensitive, Claude 侧名
    const placeholder = `\n\n…(省略 ${text.length - maxLen} 字符)…\n\n`;
    const budget = Math.max(0, maxLen - placeholder.length);
    const headLen = Math.floor(budget * headRatio);
    const tailLen = budget - headLen;
    return { text: text.slice(0, headLen) + placeholder + text.slice(-tailLen), truncated: true };
}
```

**说明**：`TRUNCATION_WHITELIST`（Bash）仅作用于措施 3（工具描述截断），与措施 2 无关。措施 2 对所有工具的 tool_result 都生效，只是 head/tail 比例不同。

---

## 措施 3：自适应工具描述阈值

**配置**：`OUTPUT_RESERVE_TOOL_DESC_ADAPTIVE`（默认 `false`）

**线性插值**（相邻两点之间连续内插，非阶跃）：
```js
const ADAPTIVE_DESC_TABLE = [[5, 8192], [40, 4096], [90, 2048], [160, 1024]];

function pickAdaptiveDescBudget(n) {
    if (n <= ADAPTIVE_DESC_TABLE[0][0]) return ADAPTIVE_DESC_TABLE[0][1];
    const last = ADAPTIVE_DESC_TABLE[ADAPTIVE_DESC_TABLE.length - 1];
    if (n >= last[0]) return last[1];
    for (let i = 0; i < ADAPTIVE_DESC_TABLE.length - 1; i++) {
        const [n1, b1] = ADAPTIVE_DESC_TABLE[i];
        const [n2, b2] = ADAPTIVE_DESC_TABLE[i + 1];
        if (n >= n1 && n < n2) return Math.round(b1 + (n - n1) / (n2 - n1) * (b2 - b1));
    }
    return 8192;
}
```

**插入点**：现有 `const MAX_DESCRIPTION_LENGTH = 1024*8` 处改为动态：
```js
const effectiveTools = filteredTools.filter(t => t.description?.trim());
const MAX_DESCRIPTION_LENGTH = reserve.adaptiveDesc
    ? pickAdaptiveDescBudget(effectiveTools.length)
    : 8192;
```

`TRUNCATION_WHITELIST`（Bash）中的工具描述不受自适应阈值截断。

---

## Helper 函数（顶部，~line 389 后）

```js
function getOutputReserveConfig(config) {
    let pressureFactor = Number.parseFloat(config?.OUTPUT_RESERVE_CONTEXT_PRESSURE);
    if (!Number.isFinite(pressureFactor) || pressureFactor < 1.0) pressureFactor = 1.0;
    else if (pressureFactor > 2.0) { pressureFactor = 2.0; }
    const truncateOn = config?.OUTPUT_RESERVE_TOOL_RESULT_TRUNCATE === true;
    let truncateMax = Number.parseInt(config?.OUTPUT_RESERVE_TOOL_RESULT_MAX_CHARS, 10);
    if (!Number.isFinite(truncateMax) || truncateMax < 1024) truncateMax = 8192;
    const adaptiveDesc = config?.OUTPUT_RESERVE_TOOL_DESC_ADAPTIVE === true;
    return { pressureFactor, truncateOn, truncateMax, adaptiveDesc };
}
```

---

## 修改文件

| 文件 | 改动 |
|------|------|
| [src/providers/claude/claude-kiro.js](src/providers/claude/claude-kiro.js) | helpers + message_delta 膨胀 + tool_result 截断 + 自适应描述 |
| [configs/config.json.example](configs/config.json.example) | 已存在，无需修改 |

---

## 验证

1. 不设任何 `OUTPUT_RESERVE_*` → 行为与改动前完全一致
2. `OUTPUT_RESERVE_CONTEXT_PRESSURE: 1.2` → 日志 `[Kiro Pressure] message_delta`
3. `OUTPUT_RESERVE_TOOL_RESULT_TRUNCATE: true` → 长 tool_result 被截断
4. `OUTPUT_RESERVE_TOOL_DESC_ADAPTIVE: true` → 日志 `Adaptive tool desc`
5. 构造含 3+ 轮 tool_use/tool_result 的请求，开启措施 2 后验证 tool 调用格式正确
