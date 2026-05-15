# 评审意见 — Round 1

**评审对象**：[stream-stream-event-stream-client-max-t-unified-clock.md](../../../../.claude/plans/stream-stream-event-stream-client-max-t-unified-clock.md)
**评审日期**：2026-05-15
**评审范围**：根因分析 + P0/P1/P2 修复方案的正确性、完备性与回归风险

---

## 总体结论

**通过条件性修订**。计划的链路梳理基本准确(已对照 [src/utils/common.js:604-970](../../../src/utils/common.js#L604-L970)、[src/providers/claude/claude-kiro.js:2092-2978](../../../src/providers/claude/claude-kiro.js#L2092-L2978) 实地核验过),P0-2(StringDecoder)与 P0-3(双计修复)定位精准、改动小且收益明确,可以直接落地。**P0-1(truncated → max_tokens)和 P1-2(remaining 偏移)需修订后再实施**,见下文。

---

## 逐项评审

### P0-1 把"被截断"信号传递到 stop_reason —— ⚠️ 信号选择不可靠

> 计划原文:"加 `streamEndedNormally` 标志(解析到 `metering` 事件时置 true,因为 `meteringEvent` 是 Kiro 流的实际收尾事件)"

**问题 1:`metering` 不一定是收尾事件,反过来说"无 metering"也不一定是截断**。

[claude-kiro.js:2202-2207](../../../src/providers/claude/claude-kiro.js#L2202-L2207) 仅以 `parsed.unit !== undefined && parsed.usage !== undefined` 识别 metering;[claude-kiro.js:2570-2571](../../../src/providers/claude/claude-kiro.js#L2570-L2571) 也只是把 credits 缓存起来。代码里**没有任何位置断言"metering 必为最后一条"**——这是计划作者的猜测。如果某次 Kiro 没回 metering(比如错误恢复路径、命中本地缓存的早返回路径),会被误判为"截断"并回 `max_tokens`,导致**正常完成被错报为截断**(假阳性)。

**问题 2:作为"是否截断"的真值,信号本来就在调用栈里更可靠的位置**:

- axios 抛错 → `streamApiReal` catch 走重试或 throw,本身就是"非正常结束"
- `for await` 自然退出但 `buffer.length > 0`(就是日志那行)→ 强信号
- HTTP `response.data.complete === false` / underlying socket `aborted` → Node stream 自带

**修订建议**:把"截断信号"建模为**多源 OR**,由 `streamApiReal` 判断后通过专门事件传出:

```js
// streamApiReal 末尾
let truncated = false;
if (buffer.length > 0) {
    truncated = true;
    logger.warn(`[Kiro Stream] Truncated: remaining buffer ${buffer.length} bytes`);
}
// 也可监听 stream.on('aborted'/'error') 设置 truncated
yield { type: '__streamEnd', truncated };
```

`generateContentStream` 用一个 `wasTruncated` 局部变量收集,在 [L2961-2970](../../../src/providers/claude/claude-kiro.js#L2961-L2970) 计算 stop_reason:

```js
const stopReason = toolCalls.length > 0 ? 'tool_use'
                 : wasTruncated ? 'max_tokens'
                 : emittedOnlyThinking ? 'max_tokens'
                 : 'end_turn';
```

**问题 3:跨协议下游不止 Claude**。

下游是 OpenAI / Gemini 时,`max_tokens` 需要走 [src/utils/common.js:724-733](../../../src/utils/common.js#L724-L733) 同款转换器映射(OpenAI: `length`, Gemini: `MAX_TOKENS`)。计划只提到 Claude,需要在评审里显式补一句:**确保转换器对 `stop_reason: 'max_tokens'` 有正确映射**(查 [src/convert/convert-old.js:56](../../../src/convert/convert-old.js#L56) 已有 `MAX_TOKENS: "max_tokens"`,Claude→OpenAI 方向需要核 [convert-old.js:496](../../../src/convert/convert-old.js#L496) 没把 `max_tokens` 改成 `length` 之外的值)。

---

### P0-2 用 StringDecoder 安全解码 chunk —— ✅ 同意,补一处遗漏

定位准确,改动小,收益清晰。`Buffer#toString('utf8')` 不维持跨 chunk 状态确实会在中文/Emoji 边界产生 `U+FFFD`,这点已经是 Node.js 社区共识。

**补充**:计划只改了 [claude-kiro.js:2280-2323](../../../src/providers/claude/claude-kiro.js#L2280-L2323) 一处,但项目里其他 provider 的流式解析(claude-openai / gemini-cli 等)若也用了 `chunk.toString()`,有同样隐患。建议在 P0-2 落地后用 `grep -rn "chunk.toString" src/providers/` 扫一遍,作为 P1.5 一并清理(本次可不做,但要在评审里登记)。

**注意**:`decoder.end()` 在 finally 里调用更安全——异常路径也能拿到剩余字节,避免最后那段被吞:

```js
try {
    for await (const chunk of stream) { buffer += decoder.write(chunk); ... }
    buffer += decoder.end();
    // 截断判断要用 end() 之后的 buffer
} catch (e) {
    buffer += decoder.end();  // 即使报错也尽量榨干
    throw e;
}
```

---

### P0-3 output_tokens 不再双计 —— ✅ 同意方案 B,但 60000 上限值得再讨论

**方案 B(保留 totalContent 累加,删 [L2937-2939](../../../src/providers/claude/claude-kiro.js#L2937-L2939) 二次累加)** 改动最小、回归面最窄,赞同。

**质疑"60000 上限"这条保险**:

> 计划原文:"emit `message_delta` 前加保险:`outputTokens = Math.min(outputTokens, 60000)`,留 4K 余量避开客户端硬限。"

这是**用谎言掩盖真相**,不是修复。问题:

1. 如果上游真的回了 70K tokens 的内容,客户端根本接不下(64K 硬限是客户端解析侧的拒收,不是 token 报告侧),`output_tokens=60000` 报告也救不了;
2. 反过来,如果实际是 30K 但本项目错估成 70K,正确做法是**修估算**,不是夹紧上限;
3. **更隐蔽的副作用**:夹紧后下游算账(成本核算 / 配额)会以 60K 为准,长期会低估开销。

**修订建议**:
- 删掉 `Math.min(60000)`;
- 真要做防御,放在 `logger.warn` 里:`if (outputTokens > 60000) logger.warn('output_tokens=N exceeds Claude Code soft limit')`,只观测不修改;
- 如果观察到估算确实偏高,再单独定位 `countTextTokens` 系数问题。

---

### P1-1 axios 超时可配置 —— ✅ 同意,但默认值太激进

把 120s → 600s(10 分钟)做默认值,会让"上游真的卡死"的请求一直占着并发槽 10 分钟。建议:

- 默认值改成 **300000 (5 分钟)**,与多数云厂商网关上限对齐;
- 流式请求用 **socket inactivity timeout**(配 axios 的 `signal` + `setTimeout`),而不是请求总时长——只要每 30s 内有字节就续命,真静默才超时。Node `http.Agent` 的 `keepAlive` 配合 `socket.setTimeout()` 是标准做法。
- `0`(无超时)不要作为可选项暴露——容易因为下游异常退出 / 客户端 close 一起卡住整个并发池。

---

### P1-2 parseAwsEventStreamBuffer 末尾 remaining 计算 —— ⚠️ 计划描述与代码不符,需重审

**核对原文实际行为**(再读 [claude-kiro.js:2092-2230](../../../src/providers/claude/claude-kiro.js#L2092-L2230)):

- L2140-2143:**未闭合 JSON** → `remaining = remaining.substring(jsonStart)` `break` —— **正确**,保留了从未闭合 `{` 起的完整字节,等下一轮拼接;
- L2212-2215:**JSON 解析失败** → `searchStart = jsonStart + 1; continue` —— 跳过这个 `{` 继续找;
- L2225-2228:**循环结束兜底** → `if (searchStart > 0 && remaining.length > 0) remaining = remaining.substring(searchStart)`。

计划质疑的是 L2225-2228 这一块:"已被推进过的字节就回不来了"。

**重新审视:这一段在哪些路径会被执行?**

- 路径 A:`jsonEnd >= 0` 解析成功 → `searchStart = jsonEnd+1`,`searchStart >= remaining.length` 时 [L2219-2222](../../../src/providers/claude/claude-kiro.js#L2219-L2222) 已经把 `remaining = ''` 并 break;否则继续 while。所以**正常退出 while 时若 searchStart < length,意味着后面还有 `{` 但 [L2100](../../../src/providers/claude/claude-kiro.js#L2100) `indexOf('{', searchStart)` 没找到** —— 此时 [L2100-2101](../../../src/providers/claude/claude-kiro.js#L2100-L2101) `break`。这条路径下,`searchStart` 后面的字节是"二进制头/无 JSON 区",丢掉**没问题**;
- 路径 B:`jsonEnd < 0` 未闭合 → [L2142](../../../src/providers/claude/claude-kiro.js#L2142) `remaining = remaining.substring(jsonStart); break` —— **此时 `searchStart` 还停在更早的位置(可能 0 或之前的 jsonEnd+1),L2226 的 `substring(searchStart)` 会从 `remaining`(已重置过的字符串)上再切一次,这是一个 bug,但方向是把字节扔得更多**,而不是计划说的"吞失败 JSON 前缀字节"。

**结论**:计划描述的根因路径不准确,但**确实存在 bug**——路径 B 下 `remaining` 已被重写过,L2226 的 `substring(searchStart)` 是基于旧 searchStart 在新 remaining 上切,语义错乱。

**修订建议**:重写为单一退出点,显式区分两条路径:

```js
// 替换 L2140-2143 与 L2225-2228
if (jsonEnd < 0) {
    return { events, remaining: remaining.substring(jsonStart) };
}
// ... 解析成功路径 ...
return { events, remaining: remaining.substring(searchStart) };
```

**P1-2 不要按计划的"在 break 时记录最后未消费 `{` 起点"实施**——那个改法没有命中真实 bug。

---

### P2 单元测试 —— ✅ 同意,补两个

计划列的三个 case 是必需的。补充建议:

1. **emoji 在 chunk 边界** —— 4 字节的 emoji(如 `🎉` U+1F389)切两半,验 StringDecoder 修复;
2. **JSON 解析失败导致 `searchStart` 推进** + **下一 chunk 让前面的失败 JSON 变完整** —— 这是计划质疑 P1-2 的真实场景,应作为回归测试。

测试位置:[test/](../../../test/)(如已有该目录)或新建 [test/providers/claude/claude-kiro-stream.test.js](../../../test/providers/claude/claude-kiro-stream.test.js)。

---

## 计划遗漏 / 未涉及的风险

### 遗漏 1:`for await` 中途客户端断开 → `streamApiReal` 不会知道

[utils/common.js:701-704](../../../src/utils/common.js#L701-L704) 检测到 `clientDisconnected` 后只是 `break` 外层循环,但**不向 service 层发取消信号**。`generateContentStream` 还在跑、`streamApiReal` 还在拉上游字节、还占着 axios slot。会和 P1-1 的 socket inactivity 配合更糟(超长卡住)。

**建议**:`handleStreamRequest` 客户端断开时,通过 AbortController 关掉 service 侧的 stream。本轮可不做,但应进入 backlog。

### 遗漏 2:metering 双源(`unit + usage` 同时存在的工具响应)误识别

[claude-kiro.js:2184](../../../src/providers/claude/claude-kiro.js#L2184) 工具结束事件判断 `parsed.stop !== undefined && parsed.contextUsagePercentage === undefined`——但**没排除 `unit/usage`**。如果 Kiro 某天给 toolUseStop 也加上 unit 字段,就会被识别成 metering。这是潜在脆弱点,与本次截断问题不直接相关,但 P0-1 用 metering 做信号会放大此风险——**这也是反对 P0-1 用 metering 的一个理由**。

### 遗漏 3:重复 content 过滤可能丢真实重复内容

[claude-kiro.js:2293-2299](../../../src/providers/claude/claude-kiro.js#L2293-L2299) `if (lastContentEvent === event.data) continue;` —— 用户原文里如果有"哈哈哈"被 Kiro 切成两个相同 chunk,会被吞一次。属于久存 bug,本次可不修,但需登记。

---

## 优先级与风险矩阵

| 项 | 计划评级 | 修订评级 | 改动复杂度 | 回归风险 | 备注 |
|---|---|---|---|---|---|
| P0-1 截断信号 | P0 | P0 | 中 | 中 | **不要**用 metering 做信号,改用 `truncated` 多源 OR;补跨协议映射 |
| P0-2 StringDecoder | P0 | P0 | 低 | 低 | 同意;`decoder.end()` 放 finally |
| P0-3 双计 | P0 | P0 | 低 | 低 | 同意方案 B;**删 `Math.min(60000)`** |
| P1-1 超时可配 | P1 | P1 | 低 | 低 | 默认改 5 分钟,流式用 socket inactivity |
| P1-2 remaining 偏移 | P1 | P1 | 低 | 中 | **重写**为单一退出点,而非"记录最后 `{` 起点" |
| P2 测试 | P2 | P1 | 中 | — | 提级到 P1,与 P0 同步落地;补 emoji 切边、失败 JSON 续传两 case |

---

## 落地顺序建议

1. P0-2 + P0-3(改动小、隔离、收益明确)→ 先发一版观察日志;
2. P1-2 重写(代码更清晰,顺手修真 bug);
3. 同步加 P2 单测(此时被测代码已稳定);
4. P0-1 最后做(信号源选择最复杂,需要在前几步稳定后再观察日志判断 truncated 的真实条件);
5. P1-1 单独做(配置项变更,需要文档同步)。

---

## 待澄清问题(给作者)

1. P0-1 是否接受改用"多源 truncated 信号"而非 metering 收尾标记?如不接受,请说明 metering 必为收尾的依据(代码注释 / 协议文档 / 实测日志)。
2. P0-3 的 `Math.min(60000, outputTokens)` 是否还要保留?如保留,接受"长期低估开销"的副作用吗?
3. P1-1 默认值 600s vs 300s,是否有具体场景需要 10 分钟(如带 thinking 的长 reasoning)?有的话默认走 socket inactivity 更合适。
