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
- **移除** §1.3 / §1.4 加的 `KIRO_FORCE_429` / `KIRO_FORCE_401` 拦截代码块。
- **回滚路线 A 的 thinking 映射临时改动** —— Phase 3.2 的 bug 单独立 issue/PR,
  不混进 Phase 1 sign-off。
- `git diff src/providers/claude/claude-kiro.js` 应只剩 §1.2 的两行 debug 打点。
- 把测试结果(每用例 pass/fail + grep 行号 / 关键日志摘录)汇成 short report。

## 风险与未决项

1.  **Phase 3.2 thinking 映射 bug** 是横向影响最大的 finding,但严格说不属于
    Phase 1 范围。建议作为独立修复并行推进,不阻塞 Phase 1 sign-off
    (路线 B 跑完即可)。
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
