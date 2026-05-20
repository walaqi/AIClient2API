# 第二轮评审 — Kiro 输出截断缓解（v2 计划）

被审计划: [/home/chris/.claude/plans/https-github-com-7836246-cursor2api-rel-shiny-hearth.md](../../../../.claude/plans/https-github-com-7836246-cursor2api-rel-shiny-hearth.md)

总评：v1→v2 的 16 处改动覆盖了上一轮全部 B/C/D 项，**主要正确性陷阱都已避开**（cache 反算执行序、`buildClaudeResponse(isStream=true)` 死路径、未知工具 fallback、配置 clamp、Bash 白名单与自适应阈值的语义优先级）。计划已可进入实现阶段，但下面 4 项需要在动手前修正或重写小段，2 项需要补到"已知偏差"。

---

## 阻断项

### B1. `looksLikeBase64Block` 的判别表达式有 bug，并且启发式过于激进

```js
// 计划 v2，2.1 章
function looksLikeBase64Block(text) {
    if (text.startsWith('data:image/')) return true;
    const head = text.slice(0, 1024);
    const base64Chars = head.match(/[A-Za-z0-9+/=]/g)?.length || 0;
    return head.length > 1024 && base64Chars / head.length > 0.92;
}
```

两个问题：

1. **永远返回 false 的分支**：`text.slice(0, 1024)` 长度上限就是 1024，`head.length > 1024` 在所有情况下都为 `false`，第二条 `return` 实际上**等价于 `return false`**。意图应该是 `text.length > 1024`（用全文长度判定，而不是 head 长度）。
2. **真把它修对了，假阳性也会爆炸**：`[A-Za-z0-9+/=]` 在普通文本里命中率本来就 80%+。一段 git log、一段 JSON、一段 Python traceback 在前 1KB 都很容易拿到 92%（中文文本里包含的中文会拉低，但纯 ASCII 输出几乎一定中招）。命中后**跳过截断**，等于让长文本绕过截断，措施 ③ 失效。

**建议改写**为更可靠的判别（base64 的特征不是字符集，而是行长一致性 + 无空白）：

```js
function looksLikeBase64Block(text) {
    if (text.startsWith('data:image/') || text.startsWith('data:application/')) return true;
    if (text.length < 4096) return false;
    // base64 在文本里通常以长且齐整的连续行出现：抽 64KB 头，
    // 看是否存在 ≥10 行、每行 76 字符（标准换行）或全无换行的纯 base64 alphabet。
    const probe = text.slice(0, 65536);
    // 形态 1：单行无换行（行内嵌入），行长 ≥ 4096 且全部 base64 字符
    if (!probe.includes('\n')) {
        return probe.length >= 4096 && /^[A-Za-z0-9+/=]+$/.test(probe);
    }
    // 形态 2：多行 76 字符块
    const lines = probe.split('\n');
    let consecutive = 0, maxRun = 0;
    for (const line of lines) {
        if (line.length === 76 && /^[A-Za-z0-9+/=]+$/.test(line)) {
            consecutive++;
            maxRun = Math.max(maxRun, consecutive);
        } else {
            consecutive = 0;
        }
    }
    return maxRun >= 10;
}
```

如果觉得太啰嗦也可以更激进地选 **白名单方向**：只判 `data:` 前缀，其它任何疑似都允许截断——理由是当前 [claude-kiro.js:1337-1349](../../../src/providers/claude/claude-kiro.js#L1337-L1349) 路径下，image 是单独 `type: 'image'` 块，不会进 tool_result 文本路径，理论上 tool_result 内嵌 base64 image 是边缘情况。

---

### B2. "三处同步膨胀"会让 `message_start` / `message_delta` 出现非自然跳变

计划 1.3 改动点 A 把 `message_start.usage.input_tokens` 从真值 `estimatedInputTokens`（本地 tokenizer 估）换成 `estimatedInputTokens × factor`；改动点 B 让 `message_delta.usage.input_tokens = realNonCached + delta`，其中 `delta = round(inputTokens × (factor-1))`，`inputTokens` 是从 [contextUsagePercentage 反算](../../../src/providers/claude/claude-kiro.js#L2995-L2998) 而来。

两个数值口径**完全不同源**：
- `estimatedInputTokens`：仅当前请求体的 tokenizer 估算（不含历史压缩状态）。
- `inputTokens`（反算）：上游服务端口径，含整个会话窗口在它那边的占用。

通常 `inputTokens (反算) >> estimatedInputTokens (本地)`。开启 `factor=1.35` 时，客户端会先看到 message_start = `est × 1.35`，再看到 message_delta = `realNonCached + delta`。**跳变方向偶尔会反向**（如反算 inputTokens 因 cache 抵扣后非常小），从客户端观测的"已用上下文"序列就不再单调；如果客户端把这两个事件视作时间序列做趋势判断（少见但不能排除），可能误触发回滚。

更稳妥的做法（建议合并到 v3）：**只在 `message_delta` 上膨胀**，`message_start` 维持真值。

理由：
- Anthropic 协议里 `message_delta.usage` 是这条消息的**终态**（包括 `output_tokens` 累计值），不是增量。客户端做"下一轮要不要 auto-compact"的决策几乎必然依据终态，而不是流中的早期 hint。
- v2 计划自己在"已识别取舍 #6"里也写了"如果实测出现客户端报'上下文超限'硬错误，应只在 message_delta 处膨胀，回滚 A/C 两处的乘法"——既然 A/C 的回滚预案已存在，**不如默认就只在 B 实施**，把 A、C 当作未来开关式扩展。

如果坚持三处同步，至少把这条预案升级为可配置（例如 `OUTPUT_RESERVE_CONTEXT_PRESSURE_SCOPE = "delta_only" | "all"`，默认 `"delta_only"`），别让运维等线上炸了再改代码回滚。

---

## 应改项

### C1. 启动日志的语义描述不准确

计划 1.2 写的是"在 `initialize()` 末尾打一行启动日志"。但 `initialize()` 是 lazy 的——首次调用 `generateContent` / `generateContentStream` 时才执行（[claude-kiro.js:2121](../../../src/providers/claude/claude-kiro.js#L2121)、[2447 附近](../../../src/providers/claude/claude-kiro.js#L2445)），不是服务进程启动时。文档与日志措辞应改为"`[Kiro] OUTPUT_RESERVE config: ... (printed on first request)`"，避免运维排查时找不到这一行而误以为没生效。

如果想要"真启动时"打印，应放在 `request-handler.js` 加载 config 之后、第一次 dispatch 前，或者 `loadConfig` 工具的统一启动日志里——但这要跨文件改，**不必为这件事改架构**，把日志措辞改清楚即可。

---

### C2. `ADAPTIVE_DESC_TABLE` 的阶跃曲线在阈值边界处不稳定

```js
const ADAPTIVE_DESC_TABLE = [
    [5,   8192],
    [40,  4096],
    [90,  2048],
    [160, 1024]
];
```

实现读法是"`n >= threshold` 取最后一行"。后果：
- `n=39` → `8192`，`n=40` → `4096`，**多 1 个工具描述预算腰斩**。
- `n=89` vs `n=90` 同样腰斩 50%。

不会导致功能问题，但会让运维感到"为什么我加一个工具，全部工具描述都被砍了一半"，调参体验差。

**建议**改成对数/线性插值（仍然是表驱动，便于调）：

```js
function pickAdaptiveDescBudget(n) {
    if (n <= ADAPTIVE_DESC_TABLE[0][0]) return ADAPTIVE_DESC_TABLE[0][1];
    if (n >= ADAPTIVE_DESC_TABLE[ADAPTIVE_DESC_TABLE.length - 1][0]) {
        return ADAPTIVE_DESC_TABLE[ADAPTIVE_DESC_TABLE.length - 1][1];
    }
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

这样 `n=40 → ~4093`、`n=65 → ~3072`、`n=90 → 2048`，过渡平滑。

---

### C3. `effectiveTools` 在 adaptive-desc 路径里被算了，但下游 `.filter().map()` 还是重新过滤

计划 3.1 段：
```js
const effectiveTools = filteredTools.filter(t => t.description && t.description.trim() !== '');
MAX_DESCRIPTION_LENGTH = pickAdaptiveDescBudget(effectiveTools.length);
```

后续 [claude-kiro.js:1183-1192](../../../src/providers/claude/claude-kiro.js#L1183-L1192) 的 `.filter(...).map(...)` 链仍然包含同样的"空 description 过滤"。两次过滤遍历语义重复但结果一致——没有正确性问题，只是多一次 O(n) 扫描。

**建议**：把 `effectiveTools` 提到 `.filter().map()` 链之外作为唯一筛选源：

```js
const effectiveTools = filteredTools.filter(t => {
    if (!t.description || t.description.trim() === '') {
        logger.info(`[Kiro] Ignoring tool with empty description: ${t.name}`);
        return false;
    }
    return true;
});
const n = effectiveTools.length;
const MAX_DESCRIPTION_LENGTH = reserve.adaptiveDesc ? pickAdaptiveDescBudget(n) : 8192;
const kiroTools = effectiveTools.map(tool => { ... });
```

更易读、少一次遍历，并且把"空 description 过滤"和"自适应阈值计算"绑定在同一个 n 上，避免未来维护时出现"两个 n 不一致"的 bug。

---

### C4. 验证段的"末尾完整度"判定方式仍是主观

v2 已升级到三档对比表，但"末尾 5 字是否完整 + 句号"仍然依赖人眼判读，难以重复且无法自动化。

**建议**用一个**确定性 prompt**：

```
请把以下数字逐个用中文表达，按 1~50 顺序输出。每个数字单独一行。最后一行严格输出："总数：50。"
```

这种 prompt 期望末尾必然是 `总数：50。`（10 个 byte，含句号）。验证脚本只需 byte-compare 响应最后 12 字符。如果末尾是 `总数：50` 或 `总数：5` 等，可量化"末尾损失字数"。把这个 prompt 写进 v3 的"端到端验证"作为标准复现集，三档跑各 5 次，记录"末尾损失字数 mean ± stdev"。

---

## 应澄清项（不阻塞实施，但要写进"已知偏差"）

### D1. 膨胀杠杆在长 output 时自动失效

[claude-kiro.js:2998](../../../src/providers/claude/claude-kiro.js#L2998) 的算式 `inputTokens = max(0, totalTokens - outputTokens)`。当 `outputTokens` 接近 `totalTokens`（即长输出占满窗口）时，反算的 `inputTokens` → 0，`inflationDelta = round(0 × 0.35) = 0`，**膨胀完全消失**。

这是一个有意思的反直觉性质：膨胀对"输入很多、还没怎么输出"的早期阶段有效（提前压缩腾出输出空间），但对"已经输出了很多、末尾在挣扎"的阶段没杠杆。如果 Kiro 的截断主要发生在后者，措施 ① 的实际效果会**弱于预期**。

写入"已知偏差"，并在 v3 的验证段建议同时记录"`message_delta.input_tokens` 的真值"以判定膨胀是否在该次请求里实际生效。

### D2. `[Kiro Pressure]` 日志对插件无效

计划 1.4 的处置是"在日志里打印 real/inflated 供事后对账"。但 `model-usage-stats` 一般通过 SSE 流事件订阅（不是 grep 日志），插件只看到 `input_tokens = inflated`，无从修正。

写入"已知偏差"明示一行：**"任何监听 SSE 流的本地统计都会高估输入用量。日志只对人工事后对账有用，不对运行时插件可见；如未来需要让插件正确计费，应引入独立的 `kiroRealUsage` 内部事件（不进协议）"**。

---

## 已正确处理（无需再改，仅记录）

- 计划 v2 在 1.3-B 显式给出"先反算 cache → 再膨胀"的代码序，与 [model-pricing.js:121-168](../../../src/utils/model-pricing.js#L121-L168) 反推契约一致。膨胀只走加法、cache 字段保持真值——计费反推不会被污染。
- C6 死代码判定经过 grep 确认（`buildClaudeResponse` 唯一调用点 [2154](../../../src/providers/claude/claude-kiro.js#L2154) 用 `isStream=false`）。仅加注释不改代码的做法克制且正确。
- B3 配置防御已落到 `getOutputReserveConfig` helper：类型转换、NaN/Infinity 拒绝、上界 clamp 都覆盖，配置防御段验证用例完备。
- 未知 `tool_use_id` 走 `__default__` 60/40 + 日志暴露 `tool=__unknown__`，C3 行为已闭合。
- Bash 白名单优先级写进代码注释，避免未来误删。
- 自适应表口径（"过滤空 description 之后的有效工具数"）已确认。

---

## 第三轮交付建议

只剩 4 件事必须在动手前定：

1. **B1**：`looksLikeBase64Block` 改写或换成"仅判 `data:` 前缀"白名单方向，给出最终 ~10 行代码。
2. **B2**：决定"三处同步膨胀"还是"仅 message_delta 膨胀"。如果保留三处，就把 `OUTPUT_RESERVE_CONTEXT_PRESSURE_SCOPE` 配置项加上，默认 `"delta_only"`。
3. **C2**：`pickAdaptiveDescBudget` 改为线性插值版（10 行）。
4. **C3**：把"空 description 过滤"提到 `.filter().map()` 链之外，与 adaptive-desc 共享同一个 n。

C1 / C4 / D1 / D2 是**文档措辞**改动，可以与 v3 合并提交。

完成上述 4 处后，计划可直接进入实现，预估单文件改动 ~150 行（含注释和日志）。
