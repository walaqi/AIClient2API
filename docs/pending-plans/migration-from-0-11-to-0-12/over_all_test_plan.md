# Kiro 0.11.63 → 0.12.155 协议迁移 — 三阶段手工测试指引

> 测试目标文件: src/providers/claude/claude-kiro.js
> 参考实现: /home/chris/projects/Kiro-account-manager/Kiro-account-manager/src/main/proxy/{kiroApi,translator,toolNameRegistry,types}.ts
>
> 通用前置: 在 configs/config.json 中开启 logRequests 与 logStreamEvents,以便 dump 出站 payload 与入站事件流。建议同时打开 DEBUG 级别日志。
>
> 关键观察项 (所有 phase 通用):
> - 出站 payload 的 conversationState 形态 (是否带 modelId, agentContinuationId, agentTaskType, cachePoint, additionalModelRequestFields)
> - 出站 HTTP header (User-Agent, x-amzn-kiro-agent-mode, amz-sdk-invocation-id, amz-sdk-request)
> - HTTP 状态码 (200 / 400 / 401 / 403 / 429)
> - 入站 metering 事件中的 inputTokens / outputTokens / cacheReadTokens

---

## Phase 1 — 网络与解析器层 (低风险)

### 1.1 单轮冒烟

**目的**: 验证迁移后的基础链路能正常拿到文本回复。

**步骤**:
1. 用任意 Claude API 客户端 (如 curl 或 Cherry Studio) 发起一次 /v1/messages 请求,model 选 claude-sonnet-4-5,messages 仅包含一条简单 user 消息 (例如 "Hello, who are you?"),stream=false。
2. 重复一次,把 stream 改为 true。

**预期**:
- 两次都返回 200,内容字段 (content[0].text) 是合理的英文回复。
- 日志中能看到 endpoint = CodeWhisperer,KIRO_VERSION = 0.12.155。

**失败信号**: 400 / 500 / 网络层超时;或日志里仍是 0.11.63。

---

### 1.2 Header parity (IDE 形态对齐)

**目的**: 验证出站 header 与新协议 IDE 形态一致。

**步骤**:
1. 单轮冒烟基础上,抓出 outgoing request header (用 logRequests 即可,无需抓包)。
2. 分别在 SOCIAL/Builder-ID 账号 与 IDC 账号 下各跑一次。

**预期**:
- User-Agent 包含字符串 KiroIDE-0.12.155-{machineId},其中 machineId 是 64 位十六进制。
- amz-user-agent 形如 aws-sdk-js/1.0.34 KiroIDE 0.12.155 {machineId}。
- 每次请求都带 amz-sdk-invocation-id (UUID v4) 与 amz-sdk-request: attempt=1; max=3。
- x-amzn-kiro-agent-mode: SOCIAL/Builder-ID = spec;IDC = vibe。
- IDC 账号下 User-Agent 切换为 KIRO_CLI_USER_AGENT 变体 (CLI rust 形态)。

**失败信号**: header 仍是旧的 0.11.63 字符串;agent-mode 始终是 vibe;machineId 缺失或不是 64 位 hex。

---

### 1.3 429 三端点 fallback

**目的**: 验证 CodeWhisperer 429 时能自动降级到 AmazonQ。

**步骤**:
1. 准备一个已经接近耗尽配额的账号 (或将 quotaLimit 临时下调到几乎为 0,触发 429)。
2. 发起一次普通对话请求。
3. 观察日志。

**预期**:
- 日志中先出现 Endpoint CodeWhisperer 收到 429,继而出现 trying next endpoint AmazonQ。
- 最终请求由 AmazonQ 完成,返回 200。
- 只有当所有三个 endpoint (CodeWhisperer, AmazonQ, AmazonQCLI) 都 429 时,才走旧的 quota-exhausted 路径触发账号切换。

**失败信号**: 第一个 endpoint 429 后直接报错给客户端;或者 endpoint 顺序不是 CodeWhisperer → AmazonQ。

---

### 1.4 401/403 不 fallback

**目的**: 验证认证失败仍由现有 credential refresh 路径处理,不被新的 endpoint 循环吞掉。

**步骤**:
1. 临时让 accessToken 失效 (改成乱码,或等其自然过期)。
2. 发起一次普通对话请求。

**预期**:
- 不进入 endpoint fallback 循环,而是立即触发现有的 token 刷新逻辑。
- 刷新成功后请求重发并返回 200。

**失败信号**: 401 后日志显示 trying next endpoint AmazonQ —— 说明把认证错误也当成 endpoint 错误降级了,这是回归。

---

### 1.5 AmazonQCLI 模式 (preferredEndpoint = amazonq-cli)

**目的**: 验证 CLI 模式下 payload 与 origin 都按 CLI 形态发送,且不做 fallback。

**步骤**:
1. configs/config.json 把 preferredEndpoint 改为 amazonq-cli。
2. 发起一次普通对话请求,dump 出站 payload。

**预期**:
- 出站 payload 的 conversationState 中:agentContinuationId 不存在,agentTaskType 不存在。
- userInputMessage.origin 等于 CLI (而不是 AI_EDITOR)。
- 整个请求过程中不会 fallback 到 CodeWhisperer 或 AmazonQ —— CLI 是独占模式,要么成功要么直接失败。
- HTTP 调用的是 q.us-east-1.amazonaws.com/SendMessageStreaming。

**失败信号**: payload 仍带 agentContinuationId;origin 是 AI_EDITOR;CLI 模式下回退到 CodeWhisperer。

---

### 1.6 非流式解析器 (native AWS event-stream)

**目的**: 验证非流式响应路径切到 native parser 后仍能正确解出 tool_call 与文本。

**步骤**:
1. 准备一段会触发 tool_use 的 prompt + 一个简单的 tools 数组 (例如 get_weather)。
2. 发送 stream=false 请求,dump 完整响应体。
3. 同时跑一次 stream=true 作为对照。

**预期**:
- 非流式响应里的 tool_use 名称、参数、id 与 stream 模式产出的内容一致。
- 日志中能看到 messageMetadataEvent / meteringEvent / supplementaryWebLinksEvent / citationEvent / codeReferenceEvent / reasoningContentEvent 都被正确消费 (而非旧版的 silently dropped)。
- 当 native parser 真正失败时才会出现 fallback to bracket parser 的 debug 日志,正常情况下看不到。

**失败信号**: 非流式响应缺 tool_use;参数 JSON 解析报错;或日志中频繁出现 fallback to bracket parser。

---

## Phase 2 — 请求体重建 (消除 400 Improperly formed request)

### 2.1 多轮 tool round-trip

**目的**: 验证 tool_use → tool_result 完整往返不再报 400。

**步骤**:
1. 客户端定义一个 tool (name = run_bash, description 较长),发起请求。
2. 收到 assistant 的 tool_use 块后,客户端构造 tool_result 消息回送。
3. 再发一轮 follow-up user 消息。

**预期**:
- 三轮 (user → assistant tool_use → user tool_result + follow-up → assistant) 都返回 200。
- 出站 payload 中没有出现 dummy "Continue" assistant 后缀 (旧代码的 workaround)。
- tool 名字在响应路径被还原为客户端原名 (run_bash),而出站时被映射到 ≤64 字符的 Kiro 形态名。

**失败信号**: 任何一轮 400 Improperly formed request;响应里 tool 名字是奇怪的 hash 后缀名;日志里仍能搜到 Continue 字符串作为伪造 assistant 内容。

---

### 2.2 sanitize 容错回归

**目的**: 验证 7 步 sanitizeConversation 管线能消化各种畸形会话。

**测试 case**:
- **case A**: messages 第一条不是 user (例如先来一条 assistant)。
- **case B**: 两条连续的 user 消息 (无 assistant 间隔)。
- **case C**: 空内容的 user 消息 (content 是空数组或空字符串)。
- **case D**: 一个 tool_use 后没有对应的 tool_result。
- **case E**: 末尾不是 user 消息。

**预期**:
- 全部 5 种畸形都返回 200,不再需要旧版的 dummy Continue assistant 修补。
- 旧版 ad-hoc adjacent-role merging 路径不再触发 (新管线已通吃)。

**失败信号**: 任何一种畸形回到 400;或者新代码中仍有为修补 case 而注入的伪造消息。

---

### 2.3 Orphan tool flatten (normalizeToolHistory)

**目的**: 验证 history 中引用了当前 tools 列表里不存在的 tool 名时,会被安全 flatten 成 XML 文本。

**步骤**:
1. 构造一段 history:assistant 含 tool_use name = LegacyTool,user 含对应的 tool_result。
2. 当前请求的 tools 数组里没有 LegacyTool。
3. 发送请求并 dump 出站 payload。

**预期**:
- 出站的 history 消息里,LegacyTool 已经被序列化成形如 &lt;tool_use name="LegacyTool" id="..."&gt;{...}&lt;/tool_use&gt; 加 &lt;tool_result tool_use_id="..."&gt;...&lt;/tool_result&gt; 的纯文本块。
- 不再以结构化 toolUses / toolResults 字段出现在 conversationState 中。
- 请求返回 200。

**失败信号**: payload 里仍以结构化 toolUses 引用未知工具;或服务端 400 报 unknown tool。

---

### 2.4 modelId 仅在 currentMessage 上

**目的**: 验证 history 里所有 userInputMessage 都不带 modelId,只有 currentMessage 上有。

**步骤**:
1. 多轮对话,dump 出站 payload。
2. 在 conversationState.history 中遍历所有 userInputMessage 节点。

**预期**:
- 全部 history.userInputMessage 都没有 modelId 字段。
- 仅 conversationState.currentMessage.userInputMessage.modelId 存在,值是当前请求的目标模型。

**失败信号**: history 中仍有 modelId 字段。

---

### 2.5 System prompt 形态 (Human/AI synthetic pair)

**目的**: 验证系统提示被转成两条合成 history 消息,且与参考实现 byte-stable 一致 (Phase 3.5 cache 命中的前提)。

**步骤**:
1. 给一段 system prompt (例如 You are a helpful assistant.),发请求,dump 出站 payload。
2. 观察 history 头部的两条合成消息。

**预期**:
- history[0] = userInputMessage,content 形如 [Context: Current time is 2026-05-23T...] + 原 system prompt + &lt;execution_discipline&gt;...&lt;/execution_discipline&gt; 块。
- history[1] = assistantResponseMessage,content = "I will follow these instructions."。
- &lt;execution_discipline&gt; 内的字符串与 translator.ts:713-810 完全一致 (复制自参考实现,不可改写,否则 cache key 漂移)。
- 旧代码的 3-branch heuristic (system prompt 注入 first user message 的几种分支) 已删除,搜不到原本的分支条件。

**失败信号**: system prompt 被塞进了 currentMessage 而不是 history;execution_discipline 文案被本地修改;时间戳前缀缺失。

---

### 2.6 Token-based history trim

**目的**: 验证按 token 预算裁剪 history 的逻辑生效,且图片移除先于 token 裁剪。

**步骤**:
1. 构造一段超长 history (含若干图片附件,塞到接近模型 context window 上限)。
2. 发请求,dump 出站 payload。

**预期**:
- 倒数第 5 条之前的所有消息中,图片字节已被剥离 (仅保留文本占位)。
- 按 model 的 MODEL_CONTEXT_TOKENS - tokenBufferReserve 计算上限,history 被从前往后裁剪到不超限。
- 裁剪不破坏 tool_use / tool_result 配对 (即裁掉的应是完整成对单元)。

**失败信号**: 图片字节依然出现在很早的 history 消息里;tool_use 留下而 tool_result 被裁掉,导致下一步 sanitize 报 invalid tool。

---

## Phase 3 — Cache 与 Thinking (高级特性,最小提交)

### 3.1 conversationId 稳定性 (2h TTL fingerprint cache)

**目的**: 验证同一会话连续两次请求拿到同一 conversationId,从而能命中服务端 prompt cache。

**步骤**:
1. 用同一段 history (前 N 条 user 消息内容完全一致) 发起两次请求,间隔不超过 2 小时。可选:在 metadata 里带上 session_id 作为 sessionHint。
2. 对比两次请求的出站 conversationId。

**预期**:
- 两次请求的 conversationState.conversationId 完全相同。
- LRU cache 上限大约 256 条,超过会逐出最早的;TTL 2 小时,过期后即使内容相同也会重新生成。
- sessionHint 优先于 history fingerprint:同一 sessionHint 即使 history 不同也能复用 conversationId (按参考实现 translator.ts:1022 的语义)。

**失败信号**: 两次请求 conversationId 不同 —— 说明 fingerprint hash 不稳定或 cache 未启用,Phase 3.5/3.6 必然失败。

---

### 3.2 Native thinking via additionalModelRequestFields (Claude 4+)

**目的**: 验证 thinking 字段通过 additionalModelRequestFields 下发 (而不是旧版的 inline 标签注入)。

**3.2.a — adaptive 模式**:
1. 客户端发请求,body 含 thinking: { type: "adaptive" },model 选 claude-sonnet-4-5 (或任意 claude-opus-4-* / claude-sonnet-4-* / claude-haiku-4-*)。
2. dump 出站 payload。

**预期 (出站)**:
- conversationState.additionalModelRequestFields = { thinking: { type: "adaptive" } } (顶层,而不是嵌在 inferenceConfig 里)。
- 出站 user 消息 content 中绝对找不到 &lt;thinking_mode&gt;adaptive&lt;/thinking_mode&gt; 等 inline 标签 —— 旧的 _generateThinkingPrefix 在出站路径已不再调用。
- 入站 stream 里 reasoningContentEvent 仍能被解析为 Claude 兼容的 thinking content block 返回给客户端。

**3.2.b — enabled 模式 (经 [Fix-D] 归一为 adaptive)**:
1. 同上,但 thinking: { type: "enabled", budget_tokens: 4096 }。
2. dump 出站 payload。

**预期 (出站)**:
- additionalModelRequestFields.thinking = { type: "adaptive" } (无 budget_tokens)。
  原因: Kiro 0.12 服务端 thinking.type enum 仅接受 ["adaptive","disabled"];Phase 1 [Fix-D] 在 claude-kiro.js _normalize 路径将客户端 "enabled" 一并归到 adaptive, 且不下发 budget_tokens, 否则服务端 400。

**3.2.c — disabled 或未传**:
- thinking: { type: "disabled" } 或不传 thinking 字段时,出站 payload 中应完全不含 additionalModelRequestFields (或该字段为空对象);服务端等同关闭。

**失败信号**: payload 里 additionalModelRequestFields 不存在 (Claude 4+ 应当存在);或 user 消息中仍能搜到 &lt;thinking_mode&gt; 文本;或 enabled 模式下出站 thinking.type !== "adaptive" (说明 [Fix-D] 归一未生效)。

---

### 3.3 Claude 3.x 跳过 thinking 字段

**目的**: 验证 isClaudeFourOrLater 判断生效,避免 Claude 3.x 模型携带 additionalModelRequestFields 触发服务端 400。

**步骤**:
1. 同 3.2.a 的请求,但 model 改为 claude-3-5-sonnet-20241022 或 claude-3-7-sonnet-latest。
2. dump 出站 payload。

**预期**:
- 出站 payload 中 additionalModelRequestFields 字段 不存在 (不是空对象,而是字段缺失)。
- 请求返回 200,客户端可正常拿到回复。

**失败信号**: Claude 3.x 模型也下发了 thinking 字段 → 服务端 400。

---

### 3.4 History reasoningContent 必须丢弃

**目的**: 验证 history 中携带的 reasoningContent / thinking 块在出站前被剥离。

**步骤**:
1. 客户端构造一段 history,assistant 消息中包含 thinking content block (例如上一轮拿到的 thinking 块原样回灌)。
2. 发起新请求,dump 出站 payload。

**预期**:
- 出站 conversationState.history 中 任何 assistantResponseMessage 都不应有 reasoningContent 字段。
- 任何 message 的 content 中也不应出现 &lt;thinking&gt;...&lt;/thinking&gt; 标签包裹的文本 (即旧版的 KIRO_THINKING.START_TAG / END_TAG 路径已停用)。
- 请求返回 200。

**失败信号**: payload 里看到 reasoningContent 节点;或 assistant 历史 content 中能搜到 &lt;thinking&gt; 标签 → 多半会触发 400 Improperly formed request。

---

### 3.5 cachePoint 标记位置

**目的**: 验证 cachePoint 标记按 IDE 形态分别挂在 tools 数组末尾与合成 system-prompt user 消息上。

**步骤**:
1. 发一次带 tools 数组与 system prompt 的请求,dump 出站 payload。

**预期**:
- conversationState.currentMessage.userInputMessage.userInputMessageContext.tools (或 conversationState 中存放 tools 的同等位置) 数组末尾追加了一个 { cachePoint: { type: "default" } } union 元素 (而非 toolSpecification)。
- history 中合成的 system-prompt userInputMessage (即 2.5 验证过的 history[0]) 上挂有 cachePoint: { type: "default" } 字段 (与 toolSpecification 同级)。
- 整个 payload 中其它位置不出现 cachePoint。

**失败信号**: cachePoint 出现在 currentMessage 的 user 消息上 (不该有);或 tools 列表里完全没有 cachePoint。

---

### 3.6 Cache 命中可观测

**目的**: 端到端验证 conversationId 稳定 + 系统提示 byte-stable + cachePoint 三者协同后,服务端确实复用 prompt cache。

**步骤**:
1. 用同一 system prompt + 同一 history (前 N 条不变) 发起两次请求,间隔几秒,session_id 相同。
2. 收集两次入站 metering 事件中的 inputTokens / outputTokens / cacheReadTokens。

**预期**:
- 第一次:cacheReadTokens 为 0 或较小;inputTokens 是完整长度。
- 第二次:cacheReadTokens 显著大于 0 (理想情况下接近第一次的 inputTokens),inputTokens 在计费层面下降。
- conversationId 与 3.1 一致。

**失败信号**: 第二次 cacheReadTokens 仍为 0 → cache 没命中,逐项核对 3.1 (conversationId 是否相同)、2.5 (system prompt byte 是否漂移)、3.5 (cachePoint 是否在正确位置)。

---

## 排错速查 (Troubleshooting)

| 现象 | 最可能的根因 | 优先核对项 |
|------|--------------|-----------|
| 400 Improperly formed request | history 里残留 reasoningContent 或 &lt;thinking&gt; 文本;或 tools 不匹配的 tool_use | 3.4, 2.3 |
| 400 但只在多轮出现 | sanitize 管线漏了 case (orphan tool_use 等) | 2.2 |
| 401/403 后请求无法恢复 | endpoint fallback 把认证错也吞了 | 1.4 |
| 第一个 endpoint 429 直接失败 | endpoint 循环未生效 / lastError 处理错位 | 1.3 |
| Claude 3.x 报 unknown field | additionalModelRequestFields 错误下发到 3.x | 3.3 |
| Cache 始终不命中 | conversationId 漂移 / system prompt 字节不稳 / cachePoint 缺位 | 3.1, 2.5, 3.5 |
| 工具响应里 tool 名是 hash | restoreKiroToolCallNames 未执行或 registry 未传递 | 2.1 |
| AmazonQCLI 仍 fallback | 模式判定未短路 | 1.5 |
| User-Agent 仍是 0.11.63 | KIRO_VERSION 常量未更新或未被引用 | 1.2 |
| 流式与非流式 tool_call 不一致 | 非流式仍走 regex parser | 1.6 |

---

## 推荐测试顺序

1. **Phase 1 → 1.1 → 1.2 → 1.6** (单轮 + header + 解析器,验证基础链路)
2. **Phase 1 → 1.3 → 1.4 → 1.5** (fallback 与模式切换)
3. **Phase 2 → 2.5 → 2.4** (system prompt 与 modelId 形态,目检 payload 即可)
4. **Phase 2 → 2.1 → 2.2 → 2.3 → 2.6** (功能性回归,涉及多轮与畸形 case)
5. **Phase 3 → 3.3 → 3.2** (先验证 Claude 3.x 不被污染,再验证 Claude 4+ 正确下发 thinking)
6. **Phase 3 → 3.4** (history reasoning 剥离)
7. **Phase 3 → 3.5 → 3.1 → 3.6** (cachePoint 位置 → conversationId 稳定 → cache 命中,这三步顺序不可颠倒,后一步依赖前一步)

每完成一步若失败,回到对应文件位置 (claude-kiro.js) 与参考实现 (Kiro-account-manager 的 translator.ts / kiroApi.ts) 对比修复,再重新跑该步与之后的所有步骤。
