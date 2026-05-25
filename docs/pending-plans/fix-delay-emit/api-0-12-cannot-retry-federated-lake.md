# Kiro 流式后续: Cloudflare 524 → SSE comment keep-alive

## Context

上一轮已落地 [src/providers/claude/claude-kiro.js](src/providers/claude/claude-kiro.js) 的 message_start 延迟方案 (commit `b55db7a`), 解决"axios 抛错时 Cannot retry: data already sent to client"。**修复正确, 但暴露出另一个隐藏问题**:

修复前, 立即 yield message_start 顺带充当了 SSE keep-alive — 客户端到本服务、本服务到 Cloudflare 之间的连接都因为有字节流过而保持活跃。修复后首字节延迟到 axios 200 OK, 而 Kiro 上游冷启动 / 排队偶尔会超过 **120 秒 Cloudflare Proxy Read Timeout**, 命中:

```
[ERROR] [Kiro][kiro-7] Stream API call failed (Status: undefined, Code: ECONNRESET): socket hang up
[Cloudflare] API Error: 524 — origin web server did not return a complete response within the 120-second Proxy Read Timeout window
```

这不是 Kiro 上游故障, 也不是凭证故障 — 是中间代理 (cc.atai8.cc 的 Cloudflare 边缘) 看不到任何字节流出, 主动 RST 了与本服务的连接。需要的修复是: **在等待 axios 首字节期间持续写 SSE 注释 ("keep-alive heartbeat") 到客户端**, 让 Cloudflare 看到字节流动, 同时不破坏 `anyDataSent=false` 闸门 (上一轮修复的核心不变量)。

### 关键事实 (Phase 1 已核验)

| 事实 | 验证 |
|---|---|
| `anyDataSent` 仅在 `res.write('event: ...')` ([common.js:756](src/utils/common.js#L756)) 与 `res.write('data: ...')` ([common.js:771](src/utils/common.js#L771)) 处置 true | ✅ 全文仅这两处赋值。**写 SSE comment (`: ...\n\n`) 不会触发 anyDataSent**, 凭证切换重试链路完整保留 |
| SSE 注释行规范: 以 `:` 开头到 `\n\n` 的内容被客户端忽略 | ✅ Claude Code / OpenAI SDK / curl / 浏览器 EventSource 都遵守 |
| 现成参考实现 | ✅ [src/ui-modules/event-broadcast.js:53-66](src/ui-modules/event-broadcast.js#L53-L66) 已有 `setInterval(() => res.write(':\n\n'), 30000)` 模式, 复用其结构 |
| `handleUnifiedResponse` ([common.js:644](src/utils/common.js#L644)) 在 try 块开始时写 SSE 头 (200 + `Content-Type: text/event-stream` + `Connection: keep-alive`) — 这是 keep-alive 启动时机 | ✅ 头写完即可 `res.write(': ...\n\n')`, TCP 上有字节流动 → Cloudflare 看到活跃 |
| `clientDisconnected.value` ([common.js:620-640](src/utils/common.js#L620-L640)) 已经在 `res.on('close')` / `res.on('error')` 时翻 true | ✅ keep-alive 写入前检查这个 + `res.writableEnded` + `res.destroyed`, 与 event-broadcast.js 同模式 |

### 为什么放在 common.js 而不是 claude-kiro.js

考虑过三种方案:

1. **(否) 在 `claude-kiro.js generateContentStream` 里 `setInterval`**: 生成器拿不到 `res` 句柄, 需要新增 yield 一种 `__keepalive` 控制事件让 common.js 翻译 — 多一层抽象, 而且只为 Kiro 一家服务。
2. **(否) 让 `common.js` 通过回调注入 keep-alive 函数到 service**: 改动跨 provider 协议接口, 风险与回报不匹配。
3. **(选) 在 `common.js handleStreamRequest` 里直接 `setInterval`**: common.js 本来就拥有 `res` / `clientDisconnected` / `anyDataSent` 全部状态, 是天然位置; 而且其他 provider (Gemini / Grok / Anthropic 直连) 走代理时同样受 Cloudflare/Cloudfront 等中间层超时影响, 这套 keep-alive 是 provider 无关的传输层关怀, 放在 common.js 自动惠及全部。

## 修改清单

文件: [src/utils/common.js](src/utils/common.js), 单点改动 ~25 行 (新增 keep-alive 启停 + finally 清理)。

### 改动 — `handleStreamRequest` 内增加 SSE comment heartbeat

**位置 1**: [common.js:644](src/utils/common.js#L644) `handleUnifiedResponse(res, '', true)` 之后, try 块之前 — 启动 keep-alive。

```diff
     // 只在首次请求时发送响应头，重试时跳过（响应头已发送）
     if (!isRetry) {
         await handleUnifiedResponse(res, '', true);
     }

+    // SSE keep-alive: 在等待 service.generateContentStream 首字节期间写注释行,
+    // 防止 Cloudflare/Cloudfront 等中间代理因 120s 无字节而 524。注释行以 `:` 开头,
+    // 客户端按 SSE 规范忽略, 也不会触发 anyDataSent (仍可在 axios 抛错时切凭证重试)。
+    const keepaliveIntervalMs = Number(CONFIG?.STREAM_KEEPALIVE_INTERVAL_MS) || 25000;
+    let keepaliveStopped = false;
+    const keepaliveTimer = setInterval(() => {
+        if (keepaliveStopped || anyDataSent || clientDisconnected.value || res.writableEnded || res.destroyed) {
+            clearInterval(keepaliveTimer);
+            keepaliveStopped = true;
+            return;
+        }
+        try {
+            res.write(`: keepalive ${Date.now()}\n\n`);
+        } catch (e) {
+            clearInterval(keepaliveTimer);
+            keepaliveStopped = true;
+        }
+    }, keepaliveIntervalMs);
+    const stopKeepalive = () => {
+        if (!keepaliveStopped) {
+            clearInterval(keepaliveTimer);
+            keepaliveStopped = true;
+        }
+    };
+
     let hasToolCall = false;
```

**位置 2**: [common.js:753](src/utils/common.js#L753) — 写第一个真实 event/data 前关停 keep-alive。

```diff
                 if (addEvent) {
                     if (!clientDisconnected.value && !res.writableEnded) {
                         try {
+                            stopKeepalive();
                             res.write(`event: ${chunk.type}\n`);
                             anyDataSent = true;
                         } catch (writeErr) {
```

并在写 `data:` 行处 ([common.js:768](src/utils/common.js#L768)) 同步关停 (覆盖 `addEvent=false` 路径):

```diff
                 if (!clientDisconnected.value && !res.writableEnded) {
                     try {
+                        stopKeepalive();
                         res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                         anyDataSent = true;
                     } catch (writeErr) {
```

**位置 3**: catch 块 ([common.js:791](src/utils/common.js#L791)) 进入即关 — 错误路径无论是否触发凭证切换, 重试都会复用同一个 `res`, 由递归调用重新启动 keep-alive (因 `isRetry=true` 跳过 `handleUnifiedResponse` 但不影响 keep-alive 启动: 我们把 keep-alive 启动放在 `isRetry` 检查**之外**, 每次进入 handleStreamRequest 都重启新 timer)。

```diff
     }  catch (error) {
+        stopKeepalive();
         logger.error('\n[Server] Error during stream processing:', error.stack);
```

**位置 4**: 流正常完成路径 — 在 try 块末尾 (L780 for-await 退出后) 也补一次, 防御 keep-alive 漏关:

```diff
         }

+        stopKeepalive();
+
         // 流式请求成功完成，统计使用次数
         if (providerPoolManager && pooluuid) {
```

**位置 5**: client disconnect 监听器 — `onClientClose` / `onClientError` 设置 `clientDisconnected.value = true` 后, 下次 timer tick 自然停; 但为减少 25s 内多写一次注释的可能, 可顺手停掉:

```diff
     const onClientClose = () => {
         clientDisconnected.value = true;
+        stopKeepalive();
         logger.info('[Stream] Client disconnected, stopping stream processing');
     };

     const onClientError = (err) => {
         clientDisconnected.value = true;
+        stopKeepalive();
         logger.error('[Stream] Response stream error:', err.message);
     };
```

(注: `stopKeepalive` 必须**先声明再被监听器闭包引用**, 因此 keep-alive 启动代码块要放在 `onClientClose` / `onClientError` 函数定义**之前**, 或把这俩监听器函数改在启动代码后定义。下面的实施顺序按"先 keep-alive 启动 + stopKeepalive 函数定义 → 再两个监听器" 排列, 避免 TDZ。)

### 配置项

新增可选配置 `STREAM_KEEPALIVE_INTERVAL_MS` (毫秒), 默认 25000:

- 25s 留出 ~95s 余量给 Cloudflare 100s/120s 默认 Proxy Read Timeout
- 用户可在 [configs/config.json](configs/config.json) 顶层覆盖
- 设为 0 / 负数 / 非数字 → 走默认 25s; **不提供"完全禁用 keep-alive"**, 因为现网证据表明它是必需的, 配置错误时仍走默认值更安全

## 不需要改的地方

- [src/providers/claude/claude-kiro.js](src/providers/claude/claude-kiro.js) 不动: 上一轮 message_start 延迟修复保持原样, 这次 keep-alive 是传输层补丁, 与 provider 无关。
- 其他 provider 文件不动, 它们自动受益。
- [src/utils/common.js:802 `anyDataSent` 闸门](src/utils/common.js#L802) 不动: SSE 注释行不触发该标志, 上一轮的"切凭证重试"路径完整保留。
- [src/utils/common.js:644 handleUnifiedResponse](src/utils/common.js#L644) 不动: SSE 头里 `Connection: keep-alive` + `Transfer-Encoding: chunked` 已经正确, keep-alive 注释只是补字节流。
- 重试递归 ([common.js:854/L922](src/utils/common.js#L854)): 递归进入 `handleStreamRequest` 时启动新 timer, 旧 timer 已在 catch 里 stopKeepalive 关停, 不泄漏。

## 风险点

1. **keep-alive 写在 axios 抛错前后的微小竞态**: 25s tick 与 catch 之间可能存在 ms 级窗口, timer 回调里的 `anyDataSent` 检查保证 — 即使 catch 已置 `clientDisconnected` 之前 timer 触发, 写的也只是注释行, 不会污染 anyDataSent, 不影响重试。可接受。
2. **多次重试累积 timer**: 每次 `handleStreamRequest` (含递归) 都创建新 timer, 都在 catch / for-await 退出 / 监听器回调里 stopKeepalive。最多同一时刻一个活动 timer, 不会 leak。验证项: `setInterval` 闭包引用的是当次 invocation 的 `keepaliveStopped` / `keepaliveTimer`, 递归调用是新栈帧, 互不干扰。
3. **client 已断但 timer 仍在 tick 25s 内**: 写 `res.write` 在 `res.destroyed=true` 时会抛, try/catch 已包住; 也已经检查 `clientDisconnected.value`。最多一次无害的 try/catch 命中。
4. **极小流量浪费**: 每 25s ~30 字节, 客户端 / 中间代理 / 服务端三方都不在意。Cloudflare 不计入用量。
5. **客户端误解析 keep-alive 注释**: SSE 规范明确 `:` 开头为注释。验证过的客户端: Claude Code (`@anthropic-ai/sdk`), OpenAI Node SDK (`openai`), curl (`-N`), 浏览器 EventSource — 都正确忽略。
6. **keep-alive 不能延长 Kiro 自身的 `streamTotalTimeout`** ([claude-kiro.js:3115](src/providers/claude/claude-kiro.js#L3115) 默认 KIRO_CONSTANTS.STREAM_TOTAL_TIMEOUT): keep-alive 解决的是"中间代理超时关连接"; Kiro 自家 axios 超时仍由 `KIRO_STREAM_TIMEOUT_MS` 配置控制, 两个超时是独立维度。如果 Kiro 上游 > 该超时, axios 会 ECONNABORTED 走 catch → keep-alive 在 catch 里被 stopKeepalive 关停 → 错误冒到 common.js → 由于 anyDataSent=false → 切凭证重试。**这正是上一轮修复期望的行为**, 与 keep-alive 完全兼容。
7. **生产已部署上一轮修复**: 单独打 keep-alive 即可, 无需回退既有改动。

## 关键文件

| 文件 | 行号 | 用途 |
|---|---|---|
| [src/utils/common.js](src/utils/common.js) | 644 之后 | 启动 keep-alive timer (25s 默认), 定义 stopKeepalive |
| [src/utils/common.js](src/utils/common.js) | 626-640 (监听器) | onClientClose / onClientError 中追加 stopKeepalive |
| [src/utils/common.js](src/utils/common.js) | 753-756 / 768-771 | 首次写 event/data 前调用 stopKeepalive |
| [src/utils/common.js](src/utils/common.js) | 780 (for-await 退出后) | 防御性 stopKeepalive |
| [src/utils/common.js](src/utils/common.js) | 791 (catch 入口) | catch 立即 stopKeepalive |
| [src/ui-modules/event-broadcast.js](src/ui-modules/event-broadcast.js) | 53-66 | 现有 keep-alive 参考实现, 不改 |
| [src/providers/claude/claude-kiro.js](src/providers/claude/claude-kiro.js) | 3526-3554 (上一轮已改) | 不动, 与 keep-alive 互相独立兼容 |

## 验证方案

### 1. 模拟 Cloudflare 524 (最关键)

构造一个本地反向代理 (Caddy / nginx / 自写 Node `http.createServer`) 充当"Cloudflare", 设置 60s `proxy_read_timeout`, 上游配置一个故意 sleep 90s 的 Kiro mock。

- **修复前**: 60s 时代理 RST, 客户端收 ECONNRESET, 服务端日志 `socket hang up`。
- **修复后**: keep-alive 每 25s 写注释, 代理看到字节流不触发超时; 90s 时 mock 返回 200 + 真实首字节, keep-alive 关停, 客户端正常收到完整 SSE。

### 2. 自动化单测 (jest)

```js
it('keep-alive heartbeat fires while waiting for first byte', async () => {
    const res = mockSseResponse();
    const slowStream = (async function*() {
        await new Promise(r => setTimeout(r, 60000)); // 60s silence
        yield { type: 'message_start', ... };
        yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {...} };
        yield { type: 'message_stop' };
    })();
    const svc = { generateContentStream: () => slowStream };
    handleStreamRequest(res, svc, model, body, fromP, toP, ...);
    await sleep(30000);
    // 30s 时应至少写过 1 条 ': keepalive ...\n\n'
    expect(res.writes.filter(w => w.startsWith(': keepalive')).length).toBeGreaterThanOrEqual(1);
    // 且 anyDataSent 仍未置 true (内部状态难以观察, 用反证: 若此刻 service 抛错, 仍能切凭证)
});

it('keep-alive stops on first real chunk', async () => {
    const res = mockSseResponse();
    const fastStream = (async function*() { yield { type: 'message_start', ... }; ... })();
    handleStreamRequest(res, svc, ...);
    await sleep(30000);
    expect(res.writes.filter(w => w.startsWith(': keepalive')).length).toBe(0);
});

it('keep-alive does not set anyDataSent (axios 403 still triggers credential switch)', async () => {
    // 与上一轮修复的回归测试合并: keep-alive 写过 N 次, axios 抛 403 后仍能进入切凭证分支
});
```

(jest/babel 配置上一轮报过 `import.meta.url` 问题, 若此处复现同样症结 → 仍走手动测试路径, 不强求自动化覆盖。)

### 3. 生产灰度

部署到 1/N 实例, 观察 24h 内 ECONNRESET / 524 计数:

- 修复前 baseline (上一轮 commit b55db7a 后): X 次/天
- 修复后预期: 趋近 0
- STREAM_SUMMARY 日志的 `durMs` 分布前后对比 — keep-alive 不应改变 happy path 时延, 仅救活慢启动尾部

### 4. 回归

- 跑 `npm test` 确认现有套件通过
- 手动 curl 走 happy path / 触发 403/429 切凭证 — 上一轮验证流程复用一遍
