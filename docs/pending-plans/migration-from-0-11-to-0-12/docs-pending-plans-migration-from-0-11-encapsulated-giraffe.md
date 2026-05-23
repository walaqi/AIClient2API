# Plan: Kiro 0.12.x 迁移 — Phase 1 手工测试执行规划

## Context

`src/providers/claude/claude-kiro.js` 已合入 Phase 1/2/3 全部代码改动 ——
`KIRO_VERSION='0.12.155'`、三端点表 `KIRO_ENDPOINTS`、`getSortedEndpoints`、
`applyPayloadOrigin`、`getKiroUserAgent`、`amz-sdk-invocation-id`/`amz-sdk-request`
header、`awsParseEventStreamFrames` 接管非流式解析等都已落地
([claude-kiro.js:48](src/providers/claude/claude-kiro.js#L48)、
[claude-kiro.js:60-130](src/providers/claude/claude-kiro.js#L60-L130)、
[claude-kiro.js:1394-1413](src/providers/claude/claude-kiro.js#L1394-L1413)、
[claude-kiro.js:2462-2510](src/providers/claude/claude-kiro.js#L2462-L2510)、
[claude-kiro.js:2980-3036](src/providers/claude/claude-kiro.js#L2980-L3036))。

用户要按 [docs/pending-plans/migration-from-0-11-to-0-12/test-guide.md](docs/pending-plans/migration-from-0-11-to-0-12/test-guide.md)
跑 Phase 1 手工测试。本规划的产物是一份**测试执行手册**:每个用例对应可 grep 的
日志字符串、通过/失败判据、以及当 app log 不够用时的替代验证手段。

服务已在跑(端口 3010,见 [logs/app-2026-05-23.log:44](logs/app-2026-05-23.log#L44)),
TLS sidecar 也在跑(127.0.0.1:9090,见 [logs/app-2026-05-23.log:2](logs/app-2026-05-23.log#L2))。
SOCIAL OAuth 凭证 `3950825e` 已可用。

---

## 起跑前的关键发现

### A. 现有日志里那条 400 是 Phase 3.2 的 bug,会挡住 §1.1 冒烟

[logs/app-2026-05-23.log:107](logs/app-2026-05-23.log#L107) 显示:

```
400 Response body: {"message":"Invalid additionalModelRequestFields:
does not have a value in the enumeration [\"adaptive\", \"disabled\"]",
"reason":"REQUEST_BODY_INVALID"}
```

根因在 [claude-kiro.js:2195-2199](src/providers/claude/claude-kiro.js#L2195-L2199):
对 `thinking.type === 'enabled'` 直接下发 `{ type: 'enabled', budget_tokens }`,
但 Kiro 0.12 服务端只接受 `adaptive` / `disabled`。迁移计划文档
[migration plan §3.2](docs/pending-plans/migration-from-0-11-to-0-12/home-chris-projects-kiro-account-manage-valiant-cake.md#L340-L355)
规定只发 `{ type: 'adaptive' }`,这一分支与计划不一致。

**这是 Phase 3 范围,但任何带 `thinking: { type: 'enabled' }` 的 Anthropic Claude
API 请求都会立即 400,进而把 §1.1 / §1.6 / §2.x 的冒烟全部带垮。**

**已决定走路线 A:一行临时修复**。具体改动:把
[claude-kiro.js:2195](src/providers/claude/claude-kiro.js#L2195) 的 `if (ttype === 'enabled')`
分支临时合并到 `adaptive` 分支(让 `enabled` 也下发 `{ type: 'adaptive' }`)。

```js
// 临时改法(Phase 1 sign-off 后回滚):
if (ttype === 'enabled' || ttype === 'adaptive') {
    request.additionalModelRequestFields = { thinking: { type: 'adaptive' } };
}
```

回滚动作: Phase 1 全部用例跑完后立即 `git checkout -- src/providers/claude/claude-kiro.js`
该处恢复原状,**不要**把这一行混进任何 Phase 1 的 commit。Phase 3.2 真正的修复
单独立 PR。

### B. App log 不会出 outbound headers — §1.2 用 logger.debug 临时打点

**已决定**: 在 [claude-kiro.js:2485](src/providers/claude/claude-kiro.js#L2485)
和 [claude-kiro.js:3013](src/providers/claude/claude-kiro.js#L3013) 各加一行
`logger.debug('[Kiro] outbound headers (callApi/streamApiReal):', JSON.stringify(axiosConfig.headers))`。

为什么用 `debug` 而不是 `info`:
1.  默认 logLevel 是 `info`,debug 行平时**不写盘**,即使 §1.2 跑完忘记移除也不会
    污染线上日志或泄漏 invocation-id 等敏感字段。
2.  §1.2 测试期间临时把 logLevel 调成 `debug`(配置文件或环境变量),抓完关回
    `info`。打点行可以放心遗留。
3.  与 [claude-kiro.js:2275](src/providers/claude/claude-kiro.js#L2275) 既有的
    `logger.debug('falling back to legacy regex parser ...')` 风格一致。

**抓取流程**:
1.  改 `configs/config.json` 把 `LOG_LEVEL` (或对应字段) 设为 `debug` → 重启服务。
2.  发非流式 + 流式各一发 → `grep "outbound headers" logs/app-2026-05-23.log`。
3.  改回 `info`、重启。打点行无需移除(debug 级,沉默)。

> 备选(不走): TLS sidecar verbose 模式需先查可用 flag,工作量大于一行 logger.debug;
> mitmproxy 拦截属于 Phase 1 外重武器。两者都先搁置。

### C. AI Monitor 的 payload dump 是 `applyPayloadOrigin` **之前** 的快照

[logs/app-2026-05-23.log:105](logs/app-2026-05-23.log#L105) 已经显示:

```
[AI Monitor][...] >>> Internal Req Converted [buildCodewhispererRequest]: {...}
```

这个 dump 是在 `buildCodewhispererRequest` 返回处取的,**早于**
`applyPayloadOrigin(requestData, endpoint.origin)`(它在
[claude-kiro.js:2480](src/providers/claude/claude-kiro.js#L2480) /
[claude-kiro.js:3008](src/providers/claude/claude-kiro.js#L3008) 才发生)。
所以这个 dump 看到的永远是源 origin (`AI_EDITOR`) 和带
`agentContinuationId`/`agentTaskType` 的形态。

→ 这意味着 §1.5 (AmazonQCLI 模式剥字段) **不能**仅靠 AI Monitor 日志验证,需要在
`applyPayloadOrigin` 后或 axios 请求前加一行临时 log。

→ §2.4 / §2.5 (modelId 仅在 currentMessage、system prompt 形态) **可以**直接读
AI Monitor dump,因为这些字段在 build 阶段就定好,不会被 `applyPayloadOrigin` 改。

---

## 测试执行手册

> 通用前提
> 1.  服务已在 3010 跑、TLS sidecar 已在 9090 跑(见 [logs/app-2026-05-23.log](logs/app-2026-05-23.log))。
> 2.  日志固定路径 `/home/chris/projects/AIClient2API/logs/app-YYYY-MM-DD.log`,日切。
> 3.  每跑完一条测试,先记一下当前日志行数(`wc -l logs/app-2026-05-23.log`),发请求后只 grep 增量。
> 4.  AI Monitor 已开,出站 payload 通过 `[AI Monitor]` 前缀进日志。

### §1.1 单轮冒烟 (非流式)

**前置**: 按"起跑前的关键发现 A"二选一处理 thinking 字段。

**操作**: 用任一 HTTP 客户端打 `/v1/messages`:
```
curl -X POST http://localhost:3010/v1/messages \
  -H 'Authorization: Bearer 1234****'  \
  -H 'content-type: application/json' \
  -d '{"model":"claude-sonnet-4-6","max_tokens":256,"stream":false,
       "messages":[{"role":"user","content":"写一句话介绍一下你自己"}]}'
```
(注意 `max_tokens` 设小一点便于快速看完整响应)

**通过判据**(全部满足):
- HTTP 200,响应体含非空 `content[].text`。
- `grep "[Kiro] Calling generateContent" logs/app-2026-05-23.log | tail -1` 命中。
- `grep "ERROR" logs/app-2026-05-23.log | tail -5` **不**出现新的 400/500。
- `grep "falling back to legacy regex parser" logs/app-2026-05-23.log` 输出空
  (即 [claude-kiro.js:2275](src/providers/claude/claude-kiro.js#L2275) 的 debug
  分支没触发)。
   - 该日志在 debug 级别,如果默认 logLevel 不到 debug 看不到——这等同"未触发"。
- `grep "AWS event-stream parser produced 0 events" logs/app-2026-05-23.log` 也是空。

**失败迹象**:
- 仍有 `additionalModelRequestFields: does not have a value in the enumeration` 400
  → 路线 A/B 没生效,回头看起跑前的 A。
- `Endpoint CodeWhisperer quota exhausted` 立即出现 → 账号已限额,先换号或等冷却。
- **HTTP 200 但 `content:[]` + `output_tokens:0`** → 不是网络/凭证问题,是解析器与
  Kiro 0.12 响应格式不兼容,详见下面的"§1.1 In-Progress 调查"小节。

### §1.1 ✅ 主目标已通过 — 字节通道 + dispatcher unwrap 修复确认有效

**当前状态 (2026-05-23 18:52 验证)**:
- HTTP 200,`content[].text` 非空(用户带 thinking 跑了"写一篇关于人工智能的文章",
  返回完整文章 ~1300 output_tokens)。
- DIAG 行 `[Kiro DIAG] non-stream events: count=520, types=[...]`,主体是 `content`,
  开头 ~10 个 `reasoning`(因为请求带了 `thinking: enabled`,服务端正确回了思考链),
  结尾依次 `contextUsage`、`metering`。
- `grep "Kiro Parse" logs/app-2026-05-23.log` 空 —— 没有 sync-loss / Recovered frame
  警告,帧边界正确。

**已落地的修复**:
1.  [claude-kiro.js:2489-2495](src/providers/claude/claude-kiro.js#L2489-L2495):
    axios `responseType: 'arraybuffer'`,避免 axios 默认文本解码把高字节替换为 U+FFFD。
2.  [claude-kiro.js:2868-2879](src/providers/claude/claude-kiro.js#L2868-L2879):
    `_processApiResponse` 把 raw Buffer 透传给 `parseEventStreamChunk`,文本视图仅
    用于 ASCII bracket-tool 扫描。
3.  [claude-kiro.js:2597](src/providers/claude/claude-kiro.js#L2597):
    400 错误体走 `_getErrorResponseText` 处理 Buffer。
4.  [aws-event-stream-parser.js:71](src/providers/claude/aws-event-stream-parser.js#L71):
    `emitEventFromParsed` 入口加 unwrap,兼容 Kiro 0.12 的
    `{assistantResponseEvent:{...}}` / `{toolUseEvent:{...}}` /
    `{reasoningContentEvent:{...}}` 包装形态。

**P3 根因复盘**(取代原 P1/P2 假设): axios 不设 `responseType: 'arraybuffer'`
时会自作主张做 utf8 解码,二进制帧里的高字节(0x80+)被替换为 U+FFFD。然后
`_processApiResponse` 对响应文本再做 `.toString('utf8')` 一次,U+FFFD 重新编码
成 3 字节 `ef bf bd`,每个原本 1 字节的高字节膨胀为 3 字节,把 12 字节
prelude / totalLen 字段彻底打乱。修法是从源头不做文本解码 —— 与
[kiroApi.ts](../../Kiro-account-manager/Kiro-account-manager/src/main/proxy/kiroApi.ts)
用 undici `ReadableStream<Uint8Array>` 直读字节是同一思路,只是换个 transport 实现。

---

### §1.1 二级 bug — 非流式 thinking pipeline 缺口 (新发现,**阻塞 thinking 启用场景**)

**症状**: 主目标通过后,用户跑了一发带 `thinking: { type: 'enabled', budget_tokens: 500 }`
的 curl。响应 HTTP 200、article 文本完整,但**响应里没有 `content[].type: 'thinking'`
块** —— 服务端实际回了 ~10 个 reasoning 事件(从 DIAG 的 `types` 数组开头一段连续
`"reasoning"` 可见),但客户端只看到 text。

**根因链路**:
1.  解析器 [aws-event-stream-parser.js:73-74](src/providers/claude/aws-event-stream-parser.js#L73-L74)
    把 `{text:"..."}` reasoning payload 正确归类为 `'reasoning'` 事件 ✓
2.  非流式聚合循环 [claude-kiro.js:2287-2320](src/providers/claude/claude-kiro.js#L2287-L2320)
    line 2320 注释明写"reasoning / metering / contextUsage: 非流式聚合路径静默丢弃,
    与旧实现行为一致"—— **这条"与旧实现行为一致"的假设在 0.12 下不再成立**。0.11
    时代思考链通过内联 `<thinking>...</thinking>` 标签嵌在 content 文本里,丢
    reasoning 事件没问题(那时也没有这种事件);0.12 把思考链拆到独立的
    `reasoningContentEvent` 帧,丢就真的丢了。
3.  `_processApiResponse` 返回的 `responseText` 不含思考链。
4.  `generateContent` ([claude-kiro.js:2952-2954](src/providers/claude/claude-kiro.js#L2952-L2954))
    在 `thinkingRequested` 时调用 `_toClaudeContentBlocksFromKiroText(responseText)`,
    但该函数 ([claude-kiro.js:1794-1830](src/providers/claude/claude-kiro.js#L1794-L1830))
    只能解析**内联 `<thinking>...</thinking>` 标签**,Kiro 0.12 不再发内联标签,
    所以函数只能返回 `[{type:'text', text: <article>}]`。
5.  最终响应 `content` 数组缺 thinking 块。

**对照: 流式路径已经正确** ——
[claude-kiro.js:3560-3574](src/providers/claude/claude-kiro.js#L3560-L3574)
对 `event.type === 'reasoning'` 在 `thinkingRequested=true` 时直接路由到
`createThinkingDeltaEvents`。所以**只需要补齐非流式路径,流式不动**。

**最小侵入修法**(单文件 [claude-kiro.js](src/providers/claude/claude-kiro.js)):

1.  **`parseEventStreamChunk`** ([line 2243](src/providers/claude/claude-kiro.js#L2243)):
    返回 shape 从 `{content, toolCalls}` 扩展为 `{content, toolCalls, thinking}`。
    在聚合循环里 ([line 2287](src/providers/claude/claude-kiro.js#L2287)) 新增
    `let thinking = ''`,处理 `event.type === 'reasoning'` 的分支累加
    `thinking += event.data || ''`。删除 line 2320 的"静默丢弃"注释。

2.  **`_parseEventStreamChunkLegacy`** ([line 2345](src/providers/claude/claude-kiro.js#L2345)):
    返回 shape 同步加 `thinking: ''`(legacy 路径不会看到 reasoning 事件,空串
    占位即可,保证形状一致避免下游 undefined)。

3.  **`_processApiResponse`** ([line 2868](src/providers/claude/claude-kiro.js#L2868)):
    propagate `thinking` 字段。返回 `{responseText, toolCalls, thinking}`。

4.  **`generateContent`** ([line 2948-2955](src/providers/claude/claude-kiro.js#L2948-L2955)):
    `thinkingRequested` 路径改为直接构造 content blocks
    `[{type:'thinking', thinking}, {type:'text', text}]`(`thinking` 为空时跳过
    thinking 块),不再依赖 `_toClaudeContentBlocksFromKiroText`。
    `_toClaudeContentBlocksFromKiroText` 保留不删 —— 万一某些边路或 legacy 服务
    端仍内联 `<thinking>` 标签,可以作为 fallback 二次扫描 `responseText`(把
    内联 thinking 合并到上一步的 thinking 块尾部);也可以更简单地不再调用、
    只看事件流的 thinking。**推荐先采取最简方案: 完全不用
    `_toClaudeContentBlocksFromKiroText`,纯靠事件流的 thinking 字段**,理由是
    Kiro 0.12 服务端不再内联,内联只在历史回放或特殊 worker 路径中可能出现,
    Phase 1 范围内不必兼容。

**不在本次范围**(Phase 3.x 单独立项):
- `:event-type` header 分发(架构性重写,会顺带覆盖 wrapped/flat 兼容、未识别
  事件类型的优雅静默)。
- `messageMetadataEvent` 提取 cache token (`cacheReadInputTokens` /
  `cacheWriteInputTokens` / `uncachedInputTokens`),改善计费观测。
- `meteringEvent` / `usageEvent` 标准化。
- 其余 10+ 种事件类型(`supplementaryWebLinksEvent`、`codeReferenceEvent`、
  `followupPromptEvent`、`invalidStateEvent` 等)。
- 流式路径不动 —— 已经走对了。

**验证步骤**(代码改完后):
1.  重启服务。
2.  跑用户原命令(带 `thinking: enabled`,prompt "写一篇关于人工智能的文章"):
    响应 `content` 数组应包含 `[{type:'thinking', thinking: <思考链>}, {type:'text', text: <文章>}]`。
3.  跑 §1.1 原始无 thinking 的简单 prompt: 响应 `content` 应只有
    `[{type:'text', ...}]`,不应出现空 thinking 块(回归保护)。
4.  DIAG 行 `count=520` 量级不变,types 分布同前(reasoning 头部 + content 主体
    + contextUsage + metering)。
5.  `grep "Kiro Parse" logs/app-2026-05-23.log` 仍为空。

---

### §1.1 历史调查记录(已解决,留档参考)

> 以下为字节通道 bug 修复前的诊断笔记,内容已被上面"主目标已通过"覆盖,
> 保留是为了让 Phase 3.x 的 dispatcher 重写有上下文参考。

#### 旧症状(已解决)

**症状**: 路线 A 修完 thinking 枚举后,§1.1 的 curl 已不再 400,但
[logs/app-2026-05-23.log:93](logs/app-2026-05-23.log#L93) 显示
```
{ id: "acb37998-...", content: [], usage: { input_tokens: 38, output_tokens: 0 } }
```
即 HTTP 200、响应空、token 计 0。

**已抓到的诊断**: 在 [claude-kiro.js:2270](src/providers/claude/claude-kiro.js#L2270)
`awsParseEventStreamFrames(buf)` 之后临时插了一行 `logger.info '[Kiro DIAG] ...'`,
非流式那一发跑出来:
```
[Kiro DIAG] non-stream events: bufLen=82717, count=1, types=["reasoning"],
  sample=[{"type":"reasoning","dataPreview":"The"}]
```
**关键事实**:
- 服务端确实回了 82KB 数据(不是空响应)。
- 解析器只产出 **1** 个 event,且被分类为 `'reasoning'`、`data="The"`。
- **没有**任何 `[Kiro Parse] Sync loss exceeded budget` 或 `[Kiro Parse] Recovered
  frame after skipping ...` 警告 —— 即 [aws-event-stream-parser.js:33-35](src/providers/claude/aws-event-stream-parser.js#L33-L35)
  和 [aws-event-stream-parser.js:43-44](src/providers/claude/aws-event-stream-parser.js#L43-L44)
  没触发。
- [claude-kiro.js:2279-2313](src/providers/claude/claude-kiro.js#L2279-L2313)
  的非流式聚合循环对 `event.type === 'reasoning'` **静默丢弃**(line 2312 注释明
  写 "reasoning / metering / contextUsage: 非流式聚合路径静默丢弃, 与旧实现行为
  一致"),所以这 1 个 event 既没进 `fullContent` 也没进 `toolCalls`,最终响应
  自然是 `content:[]`。

**两个并存的 bug**:

1. **解析器只吐了 1 个 event** —— 82KB 的非流式响应正常应该出几十~上百个
   `'content'` 帧。可能性:
   - **(P1)** Kiro 0.12 非流式响应**不再是 AWS event-stream 二进制帧**,而是普通
     JSON / SSE 文本 / HTTP/2 framing。82KB 里只有 1 块字节序列恰好通过了
     [aws-event-stream-parser.js:29-30](src/providers/claude/aws-event-stream-parser.js#L29-L30)
     的 prelude 健全性检查(totalLen ∈ [16, 16MB] 且 headersLen ≤ totalLen-16),
     payload `JSON.parse` 出 `{text: "The"}`,然后 [aws-event-stream-parser.js:40](src/providers/claude/aws-event-stream-parser.js#L40)
     `if (pos + totalLen > bufLen) break;` 在下一帧静默退出。这条不触发 sync-loss
     警告也不触发 recovered 警告,与现观察一致。
   - **(P2)** 帧格式还是二进制,但 totalLen 读法变了(big-endian → 别的、或加了
     额外 framing 头)。第 1 帧因为巧合解出来,后续全部因为 `pos += totalLen` 跳
     到错误位置而靠运气符合 break 条件。这也能不触发警告。
   - **P1 与 P2 单凭 DIAG log 区分不了,必须 dump 原始字节判断。**

2. **dispatcher 把 `{text: "..."}` 路由到 `'reasoning'`** ——
   [aws-event-stream-parser.js:72-73](src/providers/claude/aws-event-stream-parser.js#L72-L73):
   ```js
   } else if (typeof parsed.text === 'string' && !parsed.name && !parsed.toolUseId
              && parsed.content === undefined) {
       events.push({ type: 'reasoning', data: parsed.text });
   }
   ```
   这条启发式把任何裸 `{text: "..."}` 当成 reasoning。如果 Kiro 0.12 把正文 chunk
   从 `{content: "..."}` 改成了 `{text: "..."}`(P1/P2 都包含这种可能),那即使 bug
   #1 修好,所有内容也会被 line 2312 的非流式聚合路径丢弃。
   - 这条 bug **必然存在**(从 DIAG 已经能看出这一帧确实被分到 reasoning 了),但
     需要先解决 bug #1 才能完整观察其影响范围。
   - [aws-event-stream-parser.js:69](src/providers/claude/aws-event-stream-parser.js#L69)
     的 TODO 注释也提示这块该改成按 `:event-type` header 派发,而非 payload shape
     启发式。

**下一步调查 (P1 vs P2 二选一)**:

把 [claude-kiro.js:2270](src/providers/claude/claude-kiro.js#L2270) 那行 DIAG 升级
为 raw buffer dump:
```js
// 临时,跑完移除
const fs = require('fs');
const dumpPath = `/tmp/kiro-raw-${Date.now()}.bin`;
fs.writeFileSync(dumpPath, buf);
logger.info(`[Kiro DIAG] dumped raw response: ${dumpPath} (bufLen=${buf.length})`);
const { events } = awsParseEventStreamFrames(buf);
logger.info(`[Kiro DIAG] non-stream events: count=${events.length}, types=${JSON.stringify(events.map(e => e.type))}`);
```
重启 → 跑同一发 curl → `xxd /tmp/kiro-raw-*.bin | head -40` 看头几个字节。判别表:

| 头部观察 | 推断 | 修法 |
|--------|----|----|
| 前 4 字节是合理 totalLen (~ 几百到几千),且每隔 totalLen 字节都能找到下一个看起来合理的 prelude | 还是 AWS event-stream 二进制,是 dispatcher 漏分类 | 走 **修法 A** |
| 看到 `data: ` / `event: ` 等 SSE 文本前缀,或纯 JSON `{...}\n{...}` | 改成了文本协议 | 走 **修法 B** |
| 看到 HTTP/2 帧头 (`0x00 0x00 0xXX 0x00`) 或别的二进制 framing | 协议层换了 | 走 **修法 C** |

**候选修法**(等 dump 落地后再敲定):

- **修法 A — dispatcher 把 `{text}` 视为 content**:
  在 [aws-event-stream-parser.js:72-73](src/providers/claude/aws-event-stream-parser.js#L72-L73)
  之前/之中加一条:对 Kiro 0.12,把无 `name`/`toolUseId` 的 `{text: "..."}` 当
  `'content'` 派发。同时把 [claude-kiro.js:2312](src/providers/claude/claude-kiro.js#L2312)
  的 reasoning 静默丢弃改成 thinking block 累加(对应 Anthropic API 的
  `content[].type='thinking'`),而不是直接丢。
  - 风险:legacy `{content}` payload 还在用,需要做并存兼容。
  - 这是最小侵入修复。

- **修法 B — 增加 SSE/JSON 解析路径**:
  在 [claude-kiro.js:2270](src/providers/claude/claude-kiro.js#L2270)
  `awsParseEventStreamFrames` 调用前加个嗅探:用前 16 字节判 binary vs text,
  走对应 parser。streaming 路径 [claude-kiro.js:3008+](src/providers/claude/claude-kiro.js#L3008)
  也要同步。

- **修法 C — 拆 HTTP/2 framing**:
  视具体 framing 而定,大概率需要换底层 transport 或加额外解码层。Phase 1
  scope 之外,要单独立项。

**插入这块调查到测试规划里的意义**:
§1.1 当前是阻塞状态。在 P1/P2 判别 + 对应修法落地之前,§1.6(非流式 vs 流式
parity)、§1.3 / §1.4 (在 fallback 链上跑相同 curl 验证)都没法判通过 —— 因为
正常路径本身就是空响应。**§1.2 (header parity) 与 §1.5 (AmazonQCLI payload 形态)
不依赖响应正文,可以在调查期间并行推进**,跑完即可读到 outbound headers /
endpointPayload JSON,与 §1.1 解耦。

### §1.2 Header parity (IDE 拟态)

按"起跑前的关键发现 B",用 `logger.debug` 临时打点:

1.  在 [claude-kiro.js:2485](src/providers/claude/claude-kiro.js#L2485)
    `headers` 构造完后、`this._applySidecar(axiosConfig)` 之前插
    `logger.debug('[Kiro] outbound headers (callApi):', JSON.stringify(axiosConfig.headers))`。
2.  对 [claude-kiro.js:3013](src/providers/claude/claude-kiro.js#L3013) 同样处理一份,
    日志 prefix 用 `(streamApiReal)` 区分。
3.  把 logLevel 调成 `debug`,重启服务 → 跑一个非流式 + 一个流式请求 →
    `grep "outbound headers" logs/app-2026-05-23.log`。
4.  抓完改回 `info` 并重启。**打点行不必移除**(debug 级,沉默)。

**通过判据**(SOCIAL OAuth 账号):
- `x-amzn-kiro-agent-mode: spec`(由 [claude-kiro.js:1400](src/providers/claude/claude-kiro.js#L1400) 决定 —— 当前节点
  `3950825e` 是 SOCIAL,所以 `agentMode = AGENT_MODE_SPEC`)。
- `user-agent` 含 `KiroIDE-0.12.155-${machineId}`,即 [getKiroUserAgent](src/providers/claude/claude-kiro.js#L964) 的输出。
- 每条 `[Kiro] outbound headers` 行的 `amz-sdk-invocation-id` 都是新的 uuid
  (用 `awk` 抓出来去重计数 `wc -l` vs `sort -u | wc -l` 应一致)。
- `amz-sdk-request` 字面值为 `attempt=1; max=3`(callApi 路径,
  [claude-kiro.js:2467](src/providers/claude/claude-kiro.js#L2467)、
  [claude-kiro.js:2988](src/providers/claude/claude-kiro.js#L2988))。
  > Refresh 路径是 `attempt=1; max=1`([claude-kiro.js:4233](src/providers/claude/claude-kiro.js#L4233)),
  > 这是 token 刷新独立通道,与本测试无关。

**IDC 账号验证**(可跳过,如果手上没有 IDC 凭证):
- 同样流程下,header 应是 `x-amzn-kiro-agent-mode: vibe`,user-agent 为
  `KIRO_CLI_USER_AGENT` 形态。

### §1.3 429 fallback

**已决定**: 用环境变量 + 临时拦截。在 [claude-kiro.js:2489](src/providers/claude/claude-kiro.js#L2489)
和 [claude-kiro.js:3017](src/providers/claude/claude-kiro.js#L3017)
(`endpoint` for 循环里 axios 调用之前)各包一段:

```js
if (process.env.KIRO_FORCE_429 === 'cw' && endpoint.name === 'CodeWhisperer') {
    const fakeErr = new Error('Forced 429 for §1.3');
    fakeErr.response = { status: 429, headers: {}, data: { message: 'forced' } };
    throw fakeErr;
}
if (process.env.KIRO_FORCE_429 === 'all') {
    const fakeErr = new Error(`Forced 429 on ${endpoint.name} for §1.3`);
    fakeErr.response = { status: 429, headers: { 'retry-after': '1' }, data: { message: 'forced' } };
    throw fakeErr;
}
```

> 不走的备选: 用真实接近配额的账号反复压(慢、不可控);DNS 黑洞会变 ECONNREFUSED
> 而非 429,代码 [claude-kiro.js:2496](src/providers/claude/claude-kiro.js#L2496) 仅对
> status===429 走 `continue`,不会触发 fallback。

**操作**:
- 子用例 a (单端点 fallback): `KIRO_FORCE_429=cw node src/api-server.js` → 跑 §1.1 同样 curl。
- 子用例 b (三端点全 429): `KIRO_FORCE_429=all node src/api-server.js` → 跑 §1.1 同样 curl。

**通过判据**:
- 子用例 a:
  - 日志出现 `[Kiro][${node}] Endpoint CodeWhisperer quota exhausted (429), trying AmazonQ...`
    ([claude-kiro.js:2498](src/providers/claude/claude-kiro.js#L2498)) 或流式版
    ([claude-kiro.js:3028](src/providers/claude/claude-kiro.js#L3028))。
  - 紧接着 `Endpoint AmazonQ succeeded after fallback from earlier 429.`
    ([claude-kiro.js:2491](src/providers/claude/claude-kiro.js#L2491))。
  - HTTP 200 返回。
- 子用例 b:
  - 三条 `Endpoint X quota exhausted (429), trying Y...` 依次出现。
  - 走 [claude-kiro.js:2556-2562](src/providers/claude/claude-kiro.js#L2556-L2562)
    最终 429 流程,日志出 `Received 429 (Too Many Requests). Retry-After=...`,
    response 是 429 而不是 hang。
  - 不出现死循环或栈溢出。

跑完: `unset KIRO_FORCE_429`、移除两段拦截代码。

### §1.4 401/403 不 fallback

**已决定**: 同一处临时拦截,新增 `KIRO_FORCE_401` 一次性开关。注入位置同 §1.3
([claude-kiro.js:2489](src/providers/claude/claude-kiro.js#L2489) /
[claude-kiro.js:3017](src/providers/claude/claude-kiro.js#L3017)):

```js
if (process.env.KIRO_FORCE_401 === 'cw_once' && endpoint.name === 'CodeWhisperer'
    && !global.__kiroForce401Fired) {
    global.__kiroForce401Fired = true;  // 只在首次尝试触发,避免刷新后真实 401 也被拦
    const fakeErr = new Error('Forced 401 for §1.4');
    fakeErr.response = { status: 401, headers: {}, data: { message: 'forced' } };
    throw fakeErr;
}
```

> 用 `global.__kiroForce401Fired` 一次性 flag 是为了规避"风险与未决项 §3":
> 若注入持续生效,token 刷新后的真实重试也会撞 fake 401,看不到正常的端点不切换行为。

**操作**: `KIRO_FORCE_401=cw_once node src/api-server.js` → 跑 §1.1 同样 curl。

**通过判据**(以 401 为例):
- **NOT** 出现 `Endpoint CodeWhisperer quota exhausted` —— 401 不是 429,代码在
  [claude-kiro.js:2496-2502](src/providers/claude/claude-kiro.js#L2496-L2502)
  仅对 429 走 `continue`,其他状态码 `throw err` 立即冒泡。
- **NOT** 出现 `Endpoint AmazonQ` 任何相关日志(没换端点)。
- 出现 [claude-kiro.js:2523](src/providers/claude/claude-kiro.js#L2523)
  `Received 401. Refreshing UUID and triggering background refresh via PoolManager...`
  + 节点 mark `needs refresh`(`[Kiro] Marking credential ... as needs refresh`)。
- 刷新完成后**真实重试一次成功**(此时 flag 已置位,fake 拦截不再生效)。
- 403 的对照(可选): 改 fake 为 `status: 403`,同样不出现端点跳转,只见
  `403 response body (callApi)` 之类。

跑完: `unset KIRO_FORCE_401`、移除拦截代码。

### §1.5 AmazonQCLI 模式

**前置**: 在 `configs/config.json` (或对应 provider 配置)加
`"KIRO_PREFERRED_ENDPOINT": "amazonq-cli"` → 重启服务。

**关键**: AI Monitor dump 看到的是 pre-`applyPayloadOrigin` 形态(见"起跑前的关键
发现 C"),所以**必须**额外加打点才能验证。在
[claude-kiro.js:2487](src/providers/claude/claude-kiro.js#L2487)
`this._applySidecar(axiosConfig)` 之前插:
```
logger.info(`[Kiro] endpointPayload=${endpoint.name}: ${JSON.stringify(endpointPayload).slice(0, 1500)}`);
```
streamApiReal 同位置 [claude-kiro.js:3017](src/providers/claude/claude-kiro.js#L3017)
也加一份。跑完移除。

**通过判据**(单条请求):
- `getSortedEndpoints('amazonq-cli')` 走 [claude-kiro.js:93-95](src/providers/claude/claude-kiro.js#L93-L95)
  分支,只返回 1 个端点;新加的打点只出现 1 次,且 `endpointPayload=AmazonQCLI`。
- 该 payload JSON 里:
   - **没有** `agentContinuationId`(被 [applyPayloadOrigin](src/providers/claude/claude-kiro.js#L124) 删掉)。
   - **没有** `agentTaskType`(同 [claude-kiro.js:125](src/providers/claude/claude-kiro.js#L125))。
   - `currentMessage.userInputMessage.origin === 'CLI'`。
- header 校验(沿用 §1.2 的打点):IDC 路径才是 CLI user-agent;SOCIAL 用账号下
  虽然 endpoint 是 AmazonQCLI,但 user-agent 仍是 `getKiroUserAgent` 而非 CLI 形态
  —— 这是因为 [claude-kiro.js:1401](src/providers/claude/claude-kiro.js#L1401)
  按 `isIdc` 而非 `endpoint.origin` 选择。**先确认这是 intended,如果计划要求
  AmazonQCLI 端点必须用 CLI user-agent,则代码与计划不一致,作为 finding 报给
  上游而不是测试失败**。
- 跑完后改回 `KIRO_PREFERRED_ENDPOINT` 默认值,重启。

### §1.6 非流式解析器

**操作**: 准备一个 tool 定义(如简化版 `Bash`),分别 `stream:true` 和 `stream:false`
跑同一句 prompt(让模型必须调用工具,例 `请用 Bash 工具列出 /tmp 下的文件`)。

**通过判据**:
- 两次响应中 `tool_use` 块的 `name` 字段一致(经
  [restoreKiroToolCallNames](src/providers/claude/claude-kiro.js#L95) 还原)。
- `input` JSON 字段一致(允许字段顺序差异,内容一致即可,直接 `jq -S` 比)。
- 日志中 `falling back to legacy regex parser`(debug 级)和
  `AWS event-stream parser produced 0 events`(同行)**都不出现**。
- 也可顺便看 [claude-kiro.js:2270](src/providers/claude/claude-kiro.js#L2270)
  解析路径走的是 `awsParseEventStreamFrames`(只能从未触发 fallback 间接证实)。

---

## 全部测试通过的判定

依次跑完 §1.1 / §1.3 / §1.4 / §1.5 / §1.6,§1.2 通过 logger.debug 打点 + logLevel
临时切换验证。每条用例按上面的判据全部满足。最后清理:

- **保留** §1.2 的 `logger.debug` 打点行(沉默,无副作用)。
- **移除** §1.5 加的 `logger.info` endpointPayload dump(info 级,会污染日志)。
- **移除** §1.1 In-Progress 调查 加的 raw buffer dump 与 `[Kiro DIAG]` info 行
  ([claude-kiro.js:2270](src/providers/claude/claude-kiro.js#L2270) 附近)。
- **保留** §1.1 修法 A/B/C 的实际代码修复(这是真正的 bug fix,不是临时打点)。
- **移除** §1.3 / §1.4 加的 `KIRO_FORCE_429` / `KIRO_FORCE_401` 拦截代码块。
- **回滚路线 A 的 thinking 映射临时改动** —— Phase 3.2 的 bug 单独立 issue/PR,
  不混进 Phase 1 sign-off。
- `git diff src/providers/claude/claude-kiro.js` 应只剩 §1.2 的两行 debug 打点
  + §1.1 的 dispatcher / 聚合修复。
- 把测试结果(每用例 pass/fail + grep 行号 / 关键日志摘录)汇成 short report。

## 风险与未决项

0.  **§1.1 空响应 bug (新发现, 阻塞 Phase 1 sign-off)** —— 详见上面的
    "§1.1 In-Progress 调查"小节。这是一条真 bug 而非测试规划本身的问题:
    `awsParseEventStreamFrames` + `emitEventFromParsed` + 非流式聚合循环这条链
    在 Kiro 0.12 响应下走不通。**必须先 raw-dump 判清 P1/P2、再决定修法 A/B/C
    才能继续 §1.1 / §1.6 / §1.3 / §1.4**。§1.2 / §1.5 不依赖响应正文,可并行推进。
1.  **Phase 3.2 thinking 映射 bug** 是横向影响最大的 finding,但严格说不属于
    Phase 1 范围。建议作为独立修复并行推进,不阻塞 Phase 1 sign-off
    (路线 A 跑完即可)。
2.  **§1.5 SOCIAL+AmazonQCLI 时 user-agent 选择**是否是 intended?
    [claude-kiro.js:1401](src/providers/claude/claude-kiro.js#L1401)
    用 `isIdc` 决定 CLI/IDE user-agent,与 endpoint 解耦。计划文档
    [§1.3](docs/pending-plans/migration-from-0-11-to-0-12/home-chris-projects-kiro-account-manage-valiant-cake.md#L130-L138)
    描述模糊,需要先与上游对齐再判 fail。
3.  **测试期间 token 刷新可能掩盖 §1.4 的 403 不 fallback 验证** —— 现有日志
    [logs/app-2026-05-23.log:72-83](logs/app-2026-05-23.log#L72-L83) 显示节点会自动
    刷新 token 后重试。注入 fake 401 时**确保只在第一次尝试上注入**,否则刷新后
    的真实 401 也会被拦,看不到正常的端点不切换行为。

## Verification 总览

按上面顺序跑完各小节,产物是:
- 每条测试在 `logs/app-2026-05-23.log` 中可定位的 grep 命中行(贴到 report)。
- §1.2 / §1.5 临时打点收集到的 outbound headers / endpointPayload JSON 摘录。
- 最终 short report:Phase 1 通过 / 失败结论 + 已知 finding(Phase 3.2 bug、
  §1.5 user-agent 问题)。
