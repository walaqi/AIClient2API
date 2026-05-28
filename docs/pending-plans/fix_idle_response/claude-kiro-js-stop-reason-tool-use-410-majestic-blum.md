# Fix: 上游空响应（0 chunk / 0 byte）导致客户端任务停止

## Context

用户抓到两次明确的"工具调用后任务停止"事件，模式完全一致：

### 样本 1 — [logs/app-2026-05-28.log:39606-39651](logs/app-2026-05-28.log#L39606-L39651)（durMs=9144）

请求 `Req:e37bde15`（08:52:19 → 08:52:28），STREAM_SUMMARY：
```
stopReason=end_turn truncated=false bufferRemain=0 socketAborted=false
toolCalls=0 outTok=0 visibleText=false thinkingOnly=false
thinkingExtracted=false inThinkingAtEnd=false ctxPct=null durMs=9144
```

### 样本 2 — [logs/app-2026-05-28-2.log:2542-2548](logs/app-2026-05-28-2.log#L2542-L2548)（durMs=1653，**用户标记"从这里开始"**）

请求 `Req:f4400f78`（09:17:48.871 → 09:17:50.524），STREAM_SUMMARY：
```
stopReason=end_turn truncated=false bufferRemain=0 socketAborted=false
toolCalls=0 outTok=0 visibleText=false thinkingOnly=false
thinkingExtracted=false inThinkingAtEnd=false ctxPct=null durMs=1653
```

### 共同的不变量

- **没有** `Last raw chunk diagnostic` 行 → `chunkCount=0`、`totalRawBytes=0`（[src/providers/claude/claude-kiro.js:3263-3269](src/providers/claude/claude-kiro.js#L3263-L3269) 仅在 `lastRawChunk.length > 0` 时打印）
- `bufferRemain=0 socketAborted=false truncated=false` — 流被上游**正常 close**，不是 socket abort、不是 4xx/5xx
- 整个流体里**0 字节、0 chunk** — 上游 Kiro 返回空响应
- 两次样本时长差 5 倍（1.6s vs 9.1s）：duration 不是有效信号，**`chunkCount===0` 才是不变量**

### 客户端行为

样本 1 的客户端日志 [logs/app-2026-05-28.log:39727-39730](logs/app-2026-05-28.log#L39727-L39730)：08:52:28.524 收到首字节后 **12ms 内**把 session state 切到 `idle`。SSE 流里只有 `message_start → message_delta(stop_reason=end_turn) → message_stop` 而无任何 content，客户端把它当成"模型回了一句空话，对话结束"，停止任务。

### 候选 A/C 已被排除

诊断日志（已部署但未提交）发挥作用：`STREAM_SUMMARY` 行的 `inThinkingAtEnd=false thinkingExtracted=false` 直接坐实**不是** thinking 状态机问题（候选 A）；没有 `Tool input JSON parse failed` 记录排除候选 C。

### 可能的触发因素（仅相关性，非修复依赖）

样本 2 还有两条额外信号：
- token 临近过期（[L2508-2511](logs/app-2026-05-28-2.log#L2508-L2511) `Is near expiry: true`），但 ProviderPoolManager 拒绝刷新（"refreshed recently 1s ago, ignoring"）。空流之后强制刷新（[L2569-2573](logs/app-2026-05-28-2.log#L2569-L2573)），下一请求立刻恢复正常 → token 边缘状态可能是触发因素之一
- 两次空流之前的请求间隔均 < 1 秒（样本 1：0.9s；样本 2：0.8s）→ 软限速也可能是触发因素

这两条相关性**不进入修复条件**，因为重试一次自然规避所有触发因素（样本 2 已示范：强制刷新 token 后立即恢复）。

## 根因

Kiro 上游对一个合法请求**偶发返回 0 字节流**（HTTP 200、连接正常 close、9 秒内毫无动静）。本仓库当前会照样发 `end_turn` + 空 `message_delta`，让客户端误以为对话自然结束。

间歇性 + `contextUsagePercentage=null` 的相关性也得到解释：上游空响应自然没 `contextUsage` 事件。

## 改动方案

**核心思路**：在 `streamApiReal` 流式拉取结束时检测"完全空流"，作为可重试错误**抛出**——直接复用现有 `isNetworkError && retryCount < maxRetries` 重试通道（[src/providers/claude/claude-kiro.js:3349-3356](src/providers/claude/claude-kiro.js#L3349-L3356)）。

为什么抛错而不是兜底"补一个 end_turn 文本"？空流是上游异常，重试一次往往能拿到正常响应；伪造内容会污染对话历史。

为什么这样安全？上一轮（[`b55db7a` "fix(kiro): 延迟 message_start yield"](.git)）已经把 `message_start` 推迟到第一个非 `__kiroStreamEnd` 事件之后。空流场景下 `messageStartEmitted` 还是 false，generateContentStream 重新走一次 streamApiReal 不会撞 `Cannot retry: data already sent to client` 闸门。

### 改动 1：streamApiReal 检测空流并抛错

文件：[src/providers/claude/claude-kiro.js](src/providers/claude/claude-kiro.js)

位置：[L3263-3269](src/providers/claude/claude-kiro.js#L3263-L3269) 的 `Last raw chunk diagnostic` 块紧后、`yield { type: '__kiroStreamEnd' ... }`（[L3276](src/providers/claude/claude-kiro.js#L3276)）之前。

```js
// 上游偶发空响应(HTTP 200 + 0 byte + 正常 close):
// 当作可重试错误抛出, 走下方 isNetworkError 通道. 避免向客户端发空 end_turn
// 让任务被误认为自然结束.
if (chunkCount === 0 && !socketAborted) {
    logger.warn(`[Kiro Stream] Empty stream detected (chunkCount=0, totalRawBytes=0, durMs=${Date.now() - streamStartMs}), throwing as KIRO_EMPTY_STREAM for retry`);
    const emptyErr = new Error('Kiro upstream returned empty stream (0 chunks, 0 bytes)');
    emptyErr.code = 'KIRO_EMPTY_STREAM';
    emptyErr.isKiroEmptyStream = true;
    throw emptyErr;
}
```

注意是**抛**而不是 `yield error`，让 generator 走到下方 catch (L3277)，被 `isRetryableNetworkError` / 自定义条件捕获。独立 warn 行让未来 grep `Empty stream detected` 即可拿到所有空流事件与各次 durMs 分布。

注：streamApiReal 此处需要能拿到 `streamStartMs`。当前该变量定义在 generateContentStream（[L3552](src/providers/claude/claude-kiro.js#L3552)）作用域，streamApiReal 看不到。需要在 streamApiReal 内独立定义 `const streamStartMs = Date.now();`，靠近 [L3118](src/providers/claude/claude-kiro.js#L3118) `try {` 入口处即可（小改动，零副作用）。

### 改动 2：把 KIRO_EMPTY_STREAM 接进重试通道

位置：[src/providers/claude/claude-kiro.js:3349](src/providers/claude/claude-kiro.js#L3349) 的网络错误重试条件。

把：
```js
if (isNetworkError && retryCount < maxRetries) {
```
扩展为：
```js
if ((isNetworkError || error?.isKiroEmptyStream) && retryCount < maxRetries) {
```

并在 logger.info 里打出区分标记，让排查更清晰：
```js
const errorIdentifier = error?.isKiroEmptyStream ? 'EMPTY_STREAM' : (errorCode || errorMessage.substring(0, 50));
```

### 改动 3：达到 maxRetries 仍空时 — 无需新代码

[src/providers/claude/claude-kiro.js:4058-4061](src/providers/claude/claude-kiro.js#L4058-L4061) 已有 `generateContentStream` 顶层 `catch + logger.error + throw`，错误自然传播到上层 common.js 的 SSE 错误处理。极罕见的"3 次都空"情形下，让客户端原生重试机制处理。

### 改动 4：测试

在 [tests/providers/](tests/providers/) 同目录新增 `tests/providers/claude-kiro-empty-stream.test.js`：

测试用例（mock `axiosInstance.request` 让它返回 mock stream）：

1. **首次空流后重试成功**：第一次 mock `Readable.from([])`（显式空数组，for-await 直接结束），第二次 mock 一段正常 AWS event-stream 帧（含 content + toolUse）。断言 generateContentStream 最终输出有 text_delta + tool_use，`message_delta.delta.stop_reason === 'tool_use'`。

2. **连续 3 次空流耗尽重试**：3 次都 mock `Readable.from([])`。断言会向上抛出 `KIRO_EMPTY_STREAM` 错误，**不**发空的 end_turn message_delta。

3. **空 chunk 也算空流**（覆盖 [L3204](src/providers/claude/claude-kiro.js#L3204) `chunkBuf.length > 0` 守卫真实生效）：mock 一个推一个 `Buffer.alloc(0)` 然后 end 的流，断言识别为空流并触发重试。

4. **socketAborted=true 时不算空流**（守住边界）：mock 流 emit `aborted` 事件后立即 end，断言**不**抛 `KIRO_EMPTY_STREAM`，而是走 truncated 路径正常 yield `__kiroStreamEnd` 让流末尾兜底逻辑处理。

> 用 `Readable.from([])` 而非 `Readable.from(Buffer.alloc(0))`，避免不同 Node 版本对 0 长度 Buffer 行为不一致。

## 关键改动文件

- [src/providers/claude/claude-kiro.js](src/providers/claude/claude-kiro.js)：改动 1 / 2 / (3 视 read 结果)
- [tests/providers/claude-kiro-empty-stream.test.js](tests/providers/claude-kiro-empty-stream.test.js)：新增

## 复用的现有机制

- `isRetryableNetworkError` ([src/utils/common.js](src/utils/common.js))：网络错误判定
- streamApiReal 的 catch + exponential backoff 重试 ([src/providers/claude/claude-kiro.js:3349-3356](src/providers/claude/claude-kiro.js#L3349-L3356))
- `messageStartEmitted` 延迟 yield 机制（commit `b55db7a`）：保证空流重试不会撞 "Cannot retry"

## 验证

1. `node --check src/providers/claude/claude-kiro.js`
2. `npx jest tests/providers/claude-kiro-empty-stream.test.js tests/providers/claude-kiro-text-tool-boundary.test.js tests/providers/claude-kiro-parser.test.js`
3. 部署后用户继续观察日志：
   - 应该看到偶发的 `[Kiro Stream] Empty stream detected (chunkCount=0, totalRawBytes=0, durMs=...)` 紧跟 `[Kiro] Network error (EMPTY_STREAM) in stream. Retrying in ...`
   - "工具后停住"现象消失 / 显著减少
   - 极罕见情形下 3 次都空，会有 `Stream API call failed (Status: undefined, Code: KIRO_EMPTY_STREAM)`，让客户端原生重试

## 未来观察项（本轮不做）

- **连续空流切凭证**：若部署后日志显示 `EMPTY_STREAM` 重试 ≥2 次仍失败的事件 > 1%/天，再加 `error.shouldSwitchCredential = true` 切凭证逻辑。本轮重试一次足以 cover token near-expiry / 软限速类瞬时触发因素（样本 2 强制刷新 token 后立刻恢复正常已示范这点）。
- **重试退避时序**：最差情形（首次 9s 空流 + 1+2+4=7s 退避 + 第二次正常响应 ≈ 16s）可能让用户主观感受到延迟。本轮**不**调整 baseDelay；若用户报告"工具后等待时间"明显恶化，下轮把 EMPTY_STREAM 的 baseDelay 单独压到 200-500ms。

---

## 已完成的前几轮（仅供参考，不再修改）

- 上一轮（commit `7d82b48`）：toolUse 边界 flush 残留 buffer，修复"工具调用前文本丢字"。
- 本会话已部署的诊断日志（未提交）：toolUse 入口 thinking-open warn、STREAM_SUMMARY 扩展字段、4 处 tool input JSON parse-fail warn。这次正是靠 STREAM_SUMMARY 的新字段才能 30 秒内排除候选 A/C 而锁定上游空流。

诊断日志保留——它们零开销且对未来排查有用。
