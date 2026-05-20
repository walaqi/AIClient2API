# Kiro 输出截断缓解（参考 cursor2api v2.7.8）— v3

> v2 → v3 变更：消化第二轮评审 B1 / B2 / C1 / C2 / C3 / C4 / D1 / D2。
> 关键策略调整：
> - **膨胀作用域默认 `delta_only`**（仅 `message_delta`），`message_start` / 非流响应保留真值。新增 `OUTPUT_RESERVE_CONTEXT_PRESSURE_SCOPE` 开关。
> - **base64 检测改为白名单方向**：只判 `data:` 前缀，不再用字符集启发式（避免 ASCII 文本假阳性吞掉措施 ③）。
> - **自适应阈值改为线性插值**，**空 description 过滤合并到一次遍历**。

## Context

**问题**：Kiro 流式输出长中文回复时，末尾几乎稳定丢 4–5 个字。

**根因猜测**：Claude Code 客户端假设 200K 上下文窗口、~80%（160K）才触发自动压缩；Kiro 实际可用窗口对长输出更紧，导致客户端压缩过迟、留给输出的预算被挤压；再叠加 Kiro 工具结果原样长转发、长长的工具描述等输入侧浪费。

**目标**：把 cursor2api v2.7.8 的三条防截断策略迁移到 Kiro adapter，全部默认关闭、可配置开启。

**关键约束**（前两轮评审已确证）：
1. **cache 反算执行序**：`calculateCacheTokens`（[src/utils/model-pricing.js:121-168](src/utils/model-pricing.js#L121-L168)）以 `inputTokens` 为变量反推 cache_creation / cache_read。**先膨胀再反推 → cache_creation 归零、cache_read 爆炸**。膨胀只能在反推完成后、构造对外 usage 那一步施加。
2. **Kiro 没有 `max_tokens` 字段**。唯一杠杆是对外上报的 `input_tokens`。
3. **客户端阈值字段不可外部确证**：B2 评审建议的"延后到 `message_delta` 终态"是更稳的默认，因为 Anthropic 协议里 `message_delta.usage` 是这条消息的终态，几乎必然是 auto-compact 决策依据。
4. **`buildClaudeResponse(isStream=true)` 是死代码**（grep 唯一调用点 [claude-kiro.js:2154](src/providers/claude/claude-kiro.js#L2154) 用 `isStream=false`）。本次仅加 1 行注释，不维护。

---

## 方案概览

| 配置键 | 类型 | 默认 | 安全范围 | 作用 |
|---|---|---|---|---|
| `OUTPUT_RESERVE_CONTEXT_PRESSURE` | number | `1.0` | `[1.0, 2.0]` | 上报 `input_tokens` 的乘数。`1.0`=关闭。**推荐起步 1.2**。 |
| `OUTPUT_RESERVE_CONTEXT_PRESSURE_SCOPE` | string | `"delta_only"` | `"delta_only"` \| `"all"` | 膨胀作用域。默认仅 `message_delta`。`"all"` 同时膨胀 `message_start` 与非流响应。 |
| `OUTPUT_RESERVE_TOOL_RESULT_TRUNCATE` | boolean | `false` | — | 是否对 tool_result 内容按工具类型 head+tail 截断。 |
| `OUTPUT_RESERVE_TOOL_RESULT_MAX_CHARS` | number | `8192` | `≥ 1024` | 截断阈值。 |
| `OUTPUT_RESERVE_TOOL_DESC_ADAPTIVE` | boolean | `false` | — | 工具数多时按数量自动收紧 `MAX_DESCRIPTION_LENGTH`。 |

---

## 改动一：上下文压力膨胀（措施 ①）

**唯一改动文件**：[src/providers/claude/claude-kiro.js](src/providers/claude/claude-kiro.js)

### 1.1 顶部 helper（应对 B2 / B3）

```js
function getOutputReserveConfig(config) {
    const rawPressure = config?.OUTPUT_RESERVE_CONTEXT_PRESSURE;
    let pressureFactor = Number.parseFloat(rawPressure);
    if (!Number.isFinite(pressureFactor) || pressureFactor < 1.0) {
        pressureFactor = 1.0;
    } else if (pressureFactor > 2.0) {
        logger.warn(`[Kiro Pressure] OUTPUT_RESERVE_CONTEXT_PRESSURE=${rawPressure} clamped to 2.0`);
        pressureFactor = 2.0;
    }

    const rawScope = config?.OUTPUT_RESERVE_CONTEXT_PRESSURE_SCOPE;
    const pressureScope = rawScope === 'all' ? 'all' : 'delta_only';

    const truncateOn = config?.OUTPUT_RESERVE_TOOL_RESULT_TRUNCATE === true;
    let truncateMax = Number.parseInt(config?.OUTPUT_RESERVE_TOOL_RESULT_MAX_CHARS, 10);
    if (!Number.isFinite(truncateMax) || truncateMax < 1024) truncateMax = 8192;

    const adaptiveDesc = config?.OUTPUT_RESERVE_TOOL_DESC_ADAPTIVE === true;

    return { pressureFactor, pressureScope, truncateOn, truncateMax, adaptiveDesc };
}

function inflateInputTokens(realTokens, pressureFactor) {
    if (pressureFactor <= 1.0 || realTokens <= 0) return realTokens;
    return Math.round(realTokens * pressureFactor);
}
```

### 1.2 首次请求时的配置日志（应对 C1）

`initialize()` 是 lazy 的（首次 `generateContent` / `generateContentStream` 时执行），措辞改为 "(printed on first request)" 避免运维误解：

```js
// 在 initialize() 末尾：
const reserve = getOutputReserveConfig(this.config);
logger.info(`[Kiro] OUTPUT_RESERVE config (printed on first request): pressure=${reserve.pressureFactor} scope=${reserve.pressureScope} truncate=${reserve.truncateOn}(${reserve.truncateMax}) adaptiveDesc=${reserve.adaptiveDesc}`);
```

### 1.3 三处出口的膨胀点（应对 B1 / B2）

**默认行为**：仅 `message_delta` 膨胀（B2 评审建议）。`message_start` 与非流响应保留真值。

**改动点 A — 流模式 `message_start`**（[claude-kiro.js:2587-2602](src/providers/claude/claude-kiro.js#L2587-L2602)）

```js
const reserve = getOutputReserveConfig(this.config);
const estimatedInputTokens = this.estimateInputTokens(requestBody);

// scope=all 时才在 message_start 膨胀；默认 delta_only 维持真值
const reportedEstimated = reserve.pressureScope === 'all'
    ? inflateInputTokens(estimatedInputTokens, reserve.pressureFactor)
    : estimatedInputTokens;
if (reportedEstimated !== estimatedInputTokens) {
    logger.info(`[Kiro Pressure] message_start: real=${estimatedInputTokens} inflated=${reportedEstimated} factor=${reserve.pressureFactor} scope=all`);
}

yield {
    type: "message_start",
    message: {
        ...,
        usage: {
            input_tokens: reportedEstimated,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0
        },
        ...
    }
};
```

**改动点 B — 流模式 `message_delta`**（[claude-kiro.js:3006-3031](src/providers/claude/claude-kiro.js#L3006-L3031)，**默认即生效**）

严格执行序：先反推 cache → 再膨胀 nonCached：

```js
// 1) 用真值反推 cache（不动）
const { cacheCreationTokens, cacheReadTokens } =
    calculateCacheTokens(meteringCredits, inputTokens, outputTokens, model);
const realNonCached = Math.max(0, inputTokens - cacheCreationTokens - cacheReadTokens);

// 2) 膨胀仅作用于 nonCached；cache 字段保持真值
const inflationDelta = Math.max(0, Math.round(inputTokens * (reserve.pressureFactor - 1)));
const reportedNonCached = realNonCached + inflationDelta;

if (inflationDelta > 0) {
    logger.info(`[Kiro Pressure] message_delta: realInput=${inputTokens} realNonCached=${realNonCached} inflated=${reportedNonCached} delta=${inflationDelta} factor=${reserve.pressureFactor} cacheCreate=${cacheCreationTokens} cacheRead=${cacheReadTokens}`);
}

yield {
    type: "message_delta",
    delta: { stop_reason: stopReason },
    usage: {
        input_tokens: reportedNonCached,                  // 膨胀（加法）
        output_tokens: outputTokens,
        cache_creation_input_tokens: cacheCreationTokens, // 真值
        cache_read_input_tokens: cacheReadTokens          // 真值
    }
};
```

**改动点 C — 非流模式 `buildClaudeResponse(..., isStream=false)`**（[claude-kiro.js:3253-3258](src/providers/claude/claude-kiro.js#L3253-L3258)）

非流路径无 metering 反算，仅在 `scope=all` 时直接乘：

```js
const reserve = getOutputReserveConfig(this.config);
const reportedInput = reserve.pressureScope === 'all'
    ? inflateInputTokens(inputTokens, reserve.pressureFactor)
    : inputTokens;

return {
    ...,
    usage: {
        input_tokens: reportedInput,
        output_tokens: outputTokens
    },
    ...
};
```

**关于伪流分支**（[claude-kiro.js:3062-3182](src/providers/claude/claude-kiro.js#L3062-L3182), `isStream=true`）：唯一调用点 [claude-kiro.js:2154](src/providers/claude/claude-kiro.js#L2154) 用 `false`，分支死代码。仅在分支顶部加一行注释 `// dead path: see generateContentStream for real streaming. If revived, sync OUTPUT_RESERVE_CONTEXT_PRESSURE here.`。

---

## 改动二：tool_result 智能截断（措施 ③）

### 2.1 顶部 helper（应对 B1）

base64 检测**只判 `data:` 前缀**，承认 tool_result 文本里嵌 base64 是边缘情况：

```js
const TOOL_RESULT_RATIOS = {
    'Read':    0.50,
    'Bash':    0.25,   // 错误信息和最终输出在末尾
    'Glob':    0.80,
    'Grep':    0.80,
    '__default__': 0.60
};

function looksLikeDataUriBlock(text) {
    // 仅判已知 data URI 前缀。tool_result 内嵌 base64 image 是边缘情况
    // （image 走单独 type: 'image' 块），其它疑似 base64 的 ASCII 文本一律允许截断。
    return text.startsWith('data:image/') || text.startsWith('data:application/');
}

function truncateHeadTailByTool(text, maxLen, toolName) {
    if (!text || text.length <= maxLen) return { text, truncated: false };
    if (looksLikeDataUriBlock(text)) {
        return { text, truncated: false, skipped: 'data-uri' };
    }
    const headRatio = TOOL_RESULT_RATIOS[toolName] ?? TOOL_RESULT_RATIOS['__default__'];
    const placeholder = `\n\n…(中间已省略 ${text.length - maxLen} 字符, tool=${toolName ?? '__unknown__'})…\n\n`;
    const budget = Math.max(0, maxLen - placeholder.length);
    const headLen = Math.floor(budget * headRatio);
    const tailLen = budget - headLen;
    let head = text.slice(0, headLen);
    const lastNL = head.lastIndexOf('\n');
    if (lastNL > headLen * 0.8) head = head.slice(0, lastNL);
    let tail = text.slice(text.length - tailLen);
    const firstNL = tail.indexOf('\n');
    if (firstNL > 0 && firstNL < tailLen * 0.2) tail = tail.slice(firstNL + 1);
    return { text: head + placeholder + tail, truncated: true };
}
```

### 2.2 `tool_use_id → toolName` 映射（不变）

在 [claude-kiro.js:1310](src/providers/claude/claude-kiro.js#L1310) 主循环之前：

```js
// name 取自 Claude 侧原名（不经 toKiroName）
const toolUseIdToName = new Map();
for (const m of processedMessages) {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const part of m.content) {
        if (part?.type === 'tool_use' && part.id && part.name) {
            toolUseIdToName.set(part.id, part.name);
        }
    }
}
```

### 2.3 两处 tool_result 分支插入截断（不变）

[claude-kiro.js:1331-1336](src/providers/claude/claude-kiro.js#L1331-L1336) 与 [claude-kiro.js:1493-1498](src/providers/claude/claude-kiro.js#L1493-L1498)：

```js
} else if (part.type === 'tool_result') {
    let trText = this.getContentText(part.content);
    if (reserve.truncateOn) {
        const toolName = toolUseIdToName.get(part.tool_use_id) ?? '__unknown__';
        const r = truncateHeadTailByTool(trText, reserve.truncateMax, toolName);
        if (r.truncated) {
            logger.info(`[Kiro] Truncated tool_result (tool=${toolName}, ${trText.length} -> ${r.text.length} chars)`);
            trText = r.text;
        } else if (r.skipped) {
            logger.info(`[Kiro] Skipped tool_result truncation (tool=${toolName}, reason=${r.skipped}, len=${trText.length})`);
        }
    }
    toolResults.push({
        content: [{ text: trText }],
        status: 'success',
        toolUseId: part.tool_use_id
    });
}
```

`reserve = getOutputReserveConfig(this.config);` 在 `buildCodewhispererRequest` 入口算一次。

---

## 改动三：自适应工具描述阈值（Kiro 形变版）

### 3.1 表 + 线性插值（应对 C2）

```js
// 工具描述预算曲线。线性插值，避免阶跃。
const ADAPTIVE_DESC_TABLE = [
    [5,   8192],
    [40,  4096],
    [90,  2048],
    [160, 1024]
];

function pickAdaptiveDescBudget(n) {
    if (n <= ADAPTIVE_DESC_TABLE[0][0]) return ADAPTIVE_DESC_TABLE[0][1];
    const last = ADAPTIVE_DESC_TABLE[ADAPTIVE_DESC_TABLE.length - 1];
    if (n >= last[0]) return last[1];
    for (let i = 0; i < ADAPTIVE_DESC_TABLE.length - 1; i++) {
        const [n1, b1] = ADAPTIVE_DESC_TABLE[i];
        const [n2, b2] = ADAPTIVE_DESC_TABLE[i + 1];
        if (n >= n1 && n < n2) {
            const t = (n - n1) / (n2 - n1);
            return Math.round(b1 + t * (b2 - b1));
        }
    }
    return 8192;
}
```

效果：`n=40 → 4096`、`n=65 → 3072`、`n=90 → 2048`，过渡平滑。

### 3.2 合并空 description 过滤（应对 C3）

[claude-kiro.js:1183-1192](src/providers/claude/claude-kiro.js#L1183-L1192) 现在的 `.filter(...).map(...)` 链改为：

```js
// 单次过滤：空 description 移除（带原日志），同时拿到自适应阈值的 n
const effectiveTools = filteredTools.filter(t => {
    if (!t.description || t.description.trim() === '') {
        logger.info(`[Kiro] Ignoring tool with empty description: ${t.name}`);
        return false;
    }
    return true;
});
const n = effectiveTools.length;
const MAX_DESCRIPTION_LENGTH = reserve.adaptiveDesc ? pickAdaptiveDescBudget(n) : 8192;
if (reserve.adaptiveDesc) {
    logger.info(`[Kiro] Adaptive tool desc threshold: effectiveTools=${n} -> ${MAX_DESCRIPTION_LENGTH} chars/tool`);
}

// 注意：Bash 在 TRUNCATION_WHITELIST 中，不受 MAX_DESCRIPTION_LENGTH 缩小影响。
// 如果未来发现 Bash 描述本身（>10K）成为瓶颈，应单独引入 BASH_DESC_BUDGET 配置项，
// 而不是把 Bash 移出白名单。
let truncatedCount = 0;
let whitelistSkippedCount = 0;
const kiroTools = effectiveTools.map(tool => {
    let desc = tool.description || "";
    const originalLength = desc.length;
    const isWhitelisted = TRUNCATION_WHITELIST.has(tool.name);
    if (desc.length > MAX_DESCRIPTION_LENGTH && isWhitelisted) {
        whitelistSkippedCount++;
        logger.info(`[Kiro] Whitelist: keeping tool '${tool.name}' description in full (${originalLength} chars, would have been truncated)`);
    } else if (desc.length > MAX_DESCRIPTION_LENGTH) {
        // 现有 head+tail 截断逻辑保持不变（claude-kiro.js:1201-1216）
        ...
    }
    return { toolSpecification: { name: toolNameMaps.toKiroName(tool.name), description: desc, inputSchema: { json: tool.input_schema || {} } } };
});
```

只一次 O(n) 扫描，且空 description 过滤与 adaptive-desc 用同一个 `n`，避免未来维护出现"两个 n 不一致"。

---

## 关键文件清单

| 路径 | 改动范围 |
|---|---|
| [src/providers/claude/claude-kiro.js](src/providers/claude/claude-kiro.js) | 顶部 helper（4 个新函数）+ initialize 配置日志 + `buildCodewhispererRequest` 内合并过滤 + 两处 tool_result 截断 + `generateContentStream` 出口 A/B + `buildClaudeResponse` 出口 C + 死分支注释 |
| [configs/config.json.example](configs/config.json.example) | 追加 5 个配置键（含 SCOPE）的注释示例 |

**只读参考**：
- [src/utils/model-pricing.js:121-168](src/utils/model-pricing.js#L121-L168) — 反推契约
- [src/utils/token-utils.js](src/utils/token-utils.js) — `estimateInputTokens` 语义
- [src/handlers/request-handler.js](src/handlers/request-handler.js) — `currentConfig` 自动透传

---

## 不做什么

- 不修改 `calculateCacheTokens`、`estimateInputTokens` 内部语义。
- 不给 `OUTPUT_RESERVE_*` 加 UI 开关。
- 不动 `buildClaudeResponse(isStream=true)` 死分支（仅加 1 行警告注释）。
- 不引入计费/统计专用事件总线（D2 列入"未来增强项"）。
- 不解除 Bash 白名单。
- 不做用字符集启发式的 base64 检测（B1 已确认假阳性会爆炸）。

---

## 验证计划

### 静态校验
- 完全不写这 5 个键时：`[Kiro] OUTPUT_RESERVE config (printed on first request): pressure=1.0 scope=delta_only truncate=false(8192) adaptiveDesc=false`，行为等价改动前。

### 配置防御
- `"OUTPUT_RESERVE_CONTEXT_PRESSURE": "1.5"`（字符串）→ 日志显示 `pressure=1.5`。
- `0.5` → clamp 1.0。
- `5.0` → `clamped to 2.0` warning。
- `"abc"` → 静默回落 1.0。
- `"OUTPUT_RESERVE_CONTEXT_PRESSURE_SCOPE": "garbage"` → 回落 `delta_only`。
- `"OUTPUT_RESERVE_CONTEXT_PRESSURE_SCOPE": "all"` → 日志确认 `scope=all`。

### 单元行为
关闭三组开关 → `STREAM_SUMMARY` 与改动前完全一致。

仅开 `pressure=1.35`（默认 `scope=delta_only`）：
- 只看到 `[Kiro Pressure] message_delta: ...`，**不出现** `message_start: ...` 行。
- **关键回归**：同一 prompt 在 `pressure=1.0` / `1.35` 下的 `cacheCreate=` 与 `cacheRead=` 应**完全相等**。

开 `pressure=1.35` + `scope=all`：
- `[Kiro Pressure] message_start` 与 `message_delta` 两条均出现。
- 非流请求的 `usage.input_tokens` 也应膨胀。

`OUTPUT_RESERVE_TOOL_RESULT_TRUNCATE: true` + 长 Bash 输出：
- `[Kiro] Truncated tool_result (tool=Bash, ${original} -> ${truncated} chars)`。
- 喂入 `data:image/png;base64,...` 头的 tool_result → `Skipped tool_result truncation (...reason=data-uri)`。
- 未知 `tool_use_id` → `tool=__unknown__`，比例走 60/40。

`OUTPUT_RESERVE_TOOL_DESC_ADAPTIVE: true`：
- 工具数 30 → `... -> 8192 chars/tool`。
- 工具数 65 → `... -> 3072 chars/tool`（线性插值，非阶跃）。
- 工具数 100 → `... -> ~1864 chars/tool`。
- Bash（>10K）在工具数 100 时仍保留全文（白名单优先）。

### 端到端（应对 C4：确定性 prompt）

**标准复现集**（写进文档，便于他人复测）：

```
请把以下数字逐个用中文表达，按 1~50 顺序输出。每个数字单独一行。最后一行严格输出："总数：50。"
```

期望末尾 byte-exact = `总数：50。`（10 字节，含 U+3002 句号）。验证脚本只需 byte-compare 响应最后 12 字符，可量化"末尾损失字数"。

跑表（每档 5 次取均值）：

| pressure | scope | run | 末尾损失字数 (mean ± stdev) | STREAM_SUMMARY.outTok | message_delta.cacheCreate | message_delta.cacheRead |
|---|---|---|---|---|---|---|
| 1.0 | delta_only | 5 | … | … | … | … |
| 1.2 | delta_only | 5 | … | … | … | … |
| 1.35 | delta_only | 5 | … | … | … | … |
| 1.35 | all | 5 | … | … | … | … |

判定：
- **末尾损失字数**单调下降说明措施 ① 有效（主要指标）。
- **`cacheCreate` / `cacheRead` 在 `pressure` 不同档之间应几乎不变**（证明膨胀字段独立于计费反推，关键回归点）。
- `delta_only` vs `all` 的末尾损失差异，决定是否值得在文档里推荐 `all`（如无差异则保持 `delta_only` 默认）。

如有 `claude --debug` transcript，抓取 `context auto-compacted` 事件时间戳作为辅助证据；无则文档明示"非直接观测"。

---

## 已识别的取舍 / 已知偏差

1. **统计插件高估** + **D2**：`model-usage-stats` 等通过 SSE 流订阅 `input_tokens` 累计成本统计，会把膨胀部分计入。`[Kiro Pressure]` 日志只对人工事后对账有用，**对运行时插件不可见**。如未来需让插件正确计费，应引入独立的 `kiroRealUsage` 内部事件（不进 Anthropic 协议）。当前默认关闭膨胀，关闭时无影响。
2. **D1：膨胀在长 output 阶段会自动失效**。[claude-kiro.js:2998](src/providers/claude/claude-kiro.js#L2998) 算式 `inputTokens = max(0, totalTokens - outputTokens)`。当 `outputTokens` 接近 `totalTokens`（长输出占满窗口）时，反算 `inputTokens → 0`，`inflationDelta → 0`，膨胀完全消失。这意味着措施 ① 主要在"输入很多、还没怎么输出"的早期阶段起作用（提前压缩腾出输出空间），对"已经输出了很多、末尾在挣扎"的阶段没杠杆。如果 Kiro 截断主要发生在后者，措施 ① 实际效果会**弱于预期**——验证段应同时记录 `message_delta` 真值 `inputTokens`，判定膨胀是否实际生效。
3. **tool_result 截断会丢中部**：与现有工具描述截断同类型代价；按工具类型选 head/tail 已尽量减少损失。base64 仅判 `data:` 前缀，纯 ASCII base64（无 data URI 前缀）会被切刀——已知边缘情况，因为 `image` 在 Kiro 协议里走独立 `type: 'image'` 块，理论上不进 tool_result 文本。
4. **未知 `tool_use_id`** 走 60/40 + 日志 `tool=__unknown__`。常见来源：跨会话历史、用户手工拼接的请求。
5. **Bash 白名单优先于自适应阈值**：开启自适应不会缩短 Bash 描述。如 Bash 描述本身成瓶颈，未来引入 `BASH_DESC_BUDGET`，**不要解除白名单**。
6. **自适应曲线 n>160 平台**：表最大 n=160（1024 chars/tool）。超大工具集（>200）的进一步收紧需扩表。
7. **B2 默认 `delta_only` 的副作用兜底**：如果实测发现客户端只看 `message_start` 做判断（罕见但不能完全排除），运维可将 `OUTPUT_RESERVE_CONTEXT_PRESSURE_SCOPE` 切到 `"all"`，无需改代码。
8. **1.35 不必照搬 cursor2api**：cursor 是 ~150K vs 假设 200K（≈1.33）；Kiro 实际窗口未量化，**起步推荐 1.2**，按"末尾损失字数"迭代。
