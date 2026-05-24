# Kiro 0.12 流式: "Cannot retry: data already sent to client" 修复

## Context

升级 Kiro API 到 0.12 之后, 用户期望"上游 axios 抛错时还能切换凭证重试"。但生产仍然在打:

```
[Stream Retry] Cannot retry: data already sent to client
```

来自 [src/utils/common.js:803](src/utils/common.js#L803)。这条日志的触发条件是 `handleStreamRequest` 在 `try` 块抛错时 `anyDataSent === true`, 进入 [L801-816](src/utils/common.js#L801-L816) 的早退分支, 不再调用切凭证重试链路。

### 根因（已用 Phase 1 探索定位）

**`anyDataSent` 仅在 `res.write('event: ...')` / `res.write('data: ...')` 时被置 true** ([common.js:756, 771](src/utils/common.js#L756))。

但 [`src/providers/claude/claude-kiro.js`](src/providers/claude/claude-kiro.js) 的 `generateContentStream` 在进入 `for await (const event of streamApiReal(...))` 循环之**前** ([claude-kiro.js:3523-3539](src/providers/claude/claude-kiro.js#L3523-L3539)) 就主动 `yield` 了一个 `message_start` 事件。这条事件在 `streamApiReal` 真正调用 `await this.axiosInstance.request(axiosConfig)` ([claude-kiro.js:3137](src/providers/claude/claude-kiro.js#L3137)) **之前**就被消费方 `handleStreamRequest` 的 `for await` 拿到, 进而 `res.write` 写入下游, `anyDataSent=true`。

之后 axios 才发起请求, 若上游返回 403/429/5xx 进入 [streamApiReal catch L3277-3360](src/providers/claude/claude-kiro.js#L3277-L3360) 重抛异常, 错误冒到 [common.js:791 catch](src/utils/common.js#L791), 命中 L802 早退 → "Cannot retry"。

**额外确认事项**:
- 0.11→0.12 迁移文档（[docs/pending-plans/migration-from-0-11-to-0-12/](docs/pending-plans/migration-from-0-11-to-0-12/)）只承诺协议字节通道、解析器、缓存与思考链, 没有承诺过 message_start 延迟发送。git log 反而有 commit `e612a66`（2026-01-09 leonai）主动改成"立即发送 message_start"。也就是说 0.12 升级并未修这个。
- 其他 provider（Gemini / Grok / Anthropic 直连）都是直接 `for await (const chunk of stream)`, 无此 anti-pattern, 仅 Kiro 一例。
- `streamApiReal` 自身在 axios.request 抛错时不会 yield 任何东西 → 它的"首次 yield"必然在 axios 200 OK 之后, 这正是延迟 message_start 的天然信号。

## 修改清单

文件: [src/providers/claude/claude-kiro.js](src/providers/claude/claude-kiro.js), 三处 ~13 行改动。

### 改动 1 — L3521-3539: 不再立即 yield, 改为构造 + 标记

```diff
             const estimatedInputTokens = this.estimateInputTokens(requestBody);

-            // 1. 先发送 message_start 事件
-            yield {
+            // 1. 构造 message_start, 但延迟到上游 axios 200 OK + streamApiReal 推出
+            //    第一个非 __kiroStreamEnd 事件后再 yield。这样 axios.request 阶段
+            //    抛出的 401/403/429/5xx 不会让 common.js 的 anyDataSent 变 true,
+            //    L802 "Cannot retry" 闸门不再卡住凭证切换重试。
+            const messageStartEvent = {
                 type: "message_start",
                 message: {
                     id: messageId,
                     type: "message",
                     role: "assistant",
                     model: model,
                     usage: {
                         input_tokens: estimatedInputTokens,
                         output_tokens: 0,
                         cache_creation_input_tokens: 0,
                         cache_read_input_tokens: 0
                     },
                     content: []
                 }
             };
+            let messageStartEmitted = false;
```

### 改动 2 — L3542-3548: 首个非 `__kiroStreamEnd` 事件触发 yield

```diff
             // 2. 流式接收并发送每个 content_block_delta
             for await (const event of this.streamApiReal('', finalModel, requestBody)) {
                 if (event.type === '__kiroStreamEnd') {
                     wasTruncated = wasTruncated || !!event.truncated;
                     streamEndInfo = { bufferRemain: event.bufferRemain || 0, socketAborted: !!event.socketAborted };
                     continue;
                 }
+                if (!messageStartEmitted) {
+                    yield messageStartEvent;
+                    messageStartEmitted = true;
+                }
                 if (event.type === 'contextUsage' && event.contextUsagePercentage) {
```

**设计说明** (回应评审 §1): 这里把 `contextUsage` / `metering` 这类自身不产生下游输出的事件也算作"首个真实事件"——因为它们出现意味着 axios 已 200 OK、上游已开始推帧, 凭证级问题已经过关, 此时 yield message_start 不影响协议且不再有重试空间。**判定信号选 streamApiReal 的"首次非 __kiroStreamEnd yield", 而不是"首个 content/reasoning 事件"**, 实现简单且与"axios 已建立连接"语义对齐。

### 改动 3 — 兜底位置: 紧邻 message_delta yield 之前 ([claude-kiro.js:3998](src/providers/claude/claude-kiro.js#L3998))

```diff
             logger.info(`[Kiro Stream] STREAM_SUMMARY model=...`);
+            if (!messageStartEmitted) {
+                yield messageStartEvent;
+                messageStartEmitted = true;
+            }
             yield {
                 type: "message_delta",
                 delta: { stop_reason: stopReason },
                 usage: { ... }
             };
```

**位置选择** (回应评审 §2): 不放在 for-await 闭合后立刻 (3845-3846) 而是放在 message_delta yield **之前**, 把"协议序章必须有 message_start"这个不变量收紧到协议要求的最近邻位置。这样 currentToolCall / streamState 残余处理里任意分支若 yield 任何 content_block_* 事件, 也都已经被前面"首个非 __kiroStreamEnd 事件触发 yield" 路径覆盖, 兜底纯粹为"完全空流"准备。代码中**不写注释**, 严格按代码风格规范。

## 不需要改的地方

- [src/utils/common.js](src/utils/common.js) 全部不动: L802 anyDataSent 闸门、L854/L922 递归调用、L644 `handleUnifiedResponse` 头写入。修复后这些路径自动行为正确。
- [src/providers/claude/claude-kiro.js](src/providers/claude/claude-kiro.js) `streamApiReal` (3078-3367) 不动: 它的"axios 抛错走 catch 不先 yield"特性是延迟方案依赖的不变量。
- 其他 provider (Gemini / Grok / Anthropic 直连) 不动, 它们没这个 anti-pattern。
- `estimatedInputTokens` (L3521) 和 `messageId` (L3406) 计算位置不动, 复用现值即可。
- 502 代理回退 ([claude-kiro.js:3338-3341](src/providers/claude/claude-kiro.js#L3338-L3341) `yield* proxyRetry`) 与网络错误重试 ([claude-kiro.js:3354](src/providers/claude/claude-kiro.js#L3354) `yield* this.streamApiReal(...)`) 不动, 递归调用沿用同一不变量。

## 风险点

1. **axios 200 OK 但上游永远不发任何事件**: 不是新增风险。streamApiReal 已配置 `streamTotalTimeout` ([L3115](src/providers/claude/claude-kiro.js#L3115)) 与 `streamInactivityTimeout` ([L3117](src/providers/claude/claude-kiro.js#L3117)), 超时后 axios 抛 ECONNABORTED 走 catch 触发网络错误重试或上抛切凭证。下游 SSE 头 (200 + Content-Type) 已经在 [common.js:644](src/utils/common.js#L644) 发出, 客户端 (Claude Code / curl / OpenAI 兼容 SDK) 通过 TCP 等待是可接受的。

2. **空流 (axios 200 + 立刻 EOF)**: 改动 3 的兜底确保仍发送完整的 message_start → (no content) → message_delta → message_stop 序列, 协议合法。

3. **流中途 socket abort**: 若已 yield message_start 行为与今天一致 (anyDataSent=true 不能重试, 直接发错误 chunk); 若 socket 在解析首事件前就断, messageStartEmitted=false, 错误冒到 common.js, anyDataSent=false → 可以切凭证重试。**反而是改进**。

4. **重试递归 anyDataSent 状态**: [common.js:854/L922](src/utils/common.js#L854) 把 `anyDataSent` 透传给递归调用。修复后第一次 try 块在 yield 前就抛 → 闭包 `anyDataSent` 仍为 false → 递归 `handleStreamRequest` 是 fresh 状态, 切凭证路径完整。

5. **客户端首字节延迟感知**: 修复前后 SSE 头都在循环开始前发出, 客户端只是从"看到 message_start 即认为流已开始"变成"等首个真实事件"。Kiro 冷启动通常 < 2s, 远低于客户端默认 idle timeout (30s+), 无感知。

6. **axios 200 OK + 上游字节解析异常** (回应评审 §3): 例如 `parseAwsEventStreamFrames` 抛错, streamApiReal 在没 yield 任何事件前就走到 catch 默认 throw, 修复后 messageStartEmitted=false → 错误冒到 common.js → anyDataSent=false → 切凭证重试。**切凭证不会修上游字节解析错误**, 只是浪费一次重试次数。可接受 (修复后不会更糟, 仅与现状一致表现为最终失败), 不专门处理。

## 关键文件

| 文件 | 行号 | 用途 |
|---|---|---|
| [src/providers/claude/claude-kiro.js](src/providers/claude/claude-kiro.js) | 3521-3539 | 改动 1 — 构造 messageStartEvent + 标记 |
| [src/providers/claude/claude-kiro.js](src/providers/claude/claude-kiro.js) | 3542-3548 | 改动 2 — 首个非 `__kiroStreamEnd` 事件触发 yield |
| [src/providers/claude/claude-kiro.js](src/providers/claude/claude-kiro.js) | ~3998 (message_delta 之前) | 改动 3 — 协议兜底, 完全空流时仍发 message_start |
| [src/utils/common.js](src/utils/common.js) | 791-816 | 验证: anyDataSent 闸门保留, 仅触发条件不再被误置 |

## 验证方案

1. **自动化单测** (回应评审 §4, 列为最高优先级——不依赖号池状态, 回归保护比手动 curl 强):

   ```js
   it('axios 403 before any yield → no message_start, error propagates for credential switch', async () => {
       const svc = new ClaudeKiroApi(...);
       svc.axiosInstance = mockAxios403();
       const gen = svc.generateContentStream(model, body);
       await expect(gen.next()).rejects.toMatchObject({ shouldSwitchCredential: true });
       // 关键断言: throw 之前 gen 没 yield 任何事件
   });

   it('empty upstream stream → still emits valid message_start → message_delta → message_stop', async () => {
       const svc = new ClaudeKiroApi(...);
       svc.streamApiReal = async function*() { yield { type: '__kiroStreamEnd', truncated: false, bufferRemain: 0, socketAborted: false }; };
       const gen = svc.generateContentStream(model, body);
       const events = [];
       for await (const ev of gen) events.push(ev.type);
       expect(events[0]).toBe('message_start');
       expect(events).toContain('message_delta');
       expect(events[events.length - 1]).toBe('message_stop');
   });
   ```

2. **手动 curl 触发 403/429**: 在号池里放一个故意失效的 Kiro 凭证作为首选, 一个有效凭证作为 fallback。发 `/v1/messages` 流式请求, 检查日志:
   - 修复前: `[Stream Retry] Cannot retry: data already sent to client` + 客户端立即收到错误。
   - 修复后: `[Stream Retry] ... Switching credential ...` + 客户端收到完整响应。

3. **STREAM_SUMMARY 日志比对**: happy path 跑一次, 确认 [claude-kiro.js:~3997](src/providers/claude/claude-kiro.js#L3997) 的 `STREAM_SUMMARY` 字段 (`stopReason / outTok / visibleText / durMs`) 与修复前一致, 仅首字节延迟略增。

4. **5xx 切换**: 在 [docs/pending-plans/migration-from-0-11-to-0-12/](docs/pending-plans/migration-from-0-11-to-0-12/) 已建立的测试脚手架基础上, 注入 502, 观察 `_tryRotateProxyAndRetryOn502` 仍能透明切代理, 所有代理 502 时 common.js 切凭证。

5. **回归**: 跑 `npm test`, 确认现有 [tests/](tests/) 套件通过 (尤其 claude-kiro stream / fixture 相关用例)。
