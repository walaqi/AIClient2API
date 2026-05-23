# Kiro 0.12.x 协议升级 — 手工测试指引

测试目标文件: [src/providers/claude/claude-kiro.js](vscode-webview://02o6oaihn1evl1rnsgsvd6sggap7dcl2ecrpvbkpb2m8s8vmtt5k/src/providers/claude/claude-kiro.js)

## 准备工作

1.  启动服务: `node src/api-server.js` (或项目实际启动命令)
2.  准备一个 SOCIAL/Builder-ID 账号 (用于 spec mode 验证) 和一个 IDC 账号 (用于 vibe mode 验证)
3.  推荐打开 `logRequests: true` 和 `logStreamEvents: true`,便于抓日志
4.  准备抓包工具或在 [claude-kiro.js:680](vscode-webview://02o6oaihn1evl1rnsgsvd6sggap7dcl2ecrpvbkpb2m8s8vmtt5k/src/providers/claude/claude-kiro.js#L680) 附近临时加 `logger.info('[Kiro] outgoing payload:', JSON.stringify(request))` 来 dump 出站请求体

* * *

## Phase 1 — 网络层 + 解析器

### 1.1 单轮冒烟

*   发一个普通 Claude `/v1/messages` 请求 (`stream: false`)
*   **预期**: 200 返回文本回复,无 400/500
*   **失败时看**: 日志里 endpoint 选择是否为 `CodeWhisperer`,event-stream 是否被 `awsParseEventStreamFrames` 解析(而非 legacy regex 回退)

### 1.2 Header parity (IDE 拟态)

*   抓出站 HTTP header,确认:
    *   SOCIAL 账号: `x-amzn-kiro-agent-mode: spec`
    *   IDC 账号: `x-amzn-kiro-agent-mode: vibe`
    *   `User-Agent` 包含 `KiroIDE-0.12.155-${machineId}`
    *   每次请求的 `amz-sdk-invocation-id` 是新的 uuid
    *   `amz-sdk-request: attempt=1; max=3`

### 1.3 429 fallback

*   临时把账号配额拉低(或用一个已经接近耗尽的账号)逼 CodeWhisperer 返回 429
*   **预期**: 日志出现 `Endpoint CodeWhisperer quota exhausted, trying next...`,然后 `AmazonQ` 接管成功
*   若三个 endpoint 都 429,应该走原有 quota-exhausted 流程(切账号/冷却)

### 1.4 401/403 不 fallback

*   用一个 access token 已过期且无 refresh token 的账号
*   **预期**: 401/403 立刻冒泡触发凭证刷新,**不**继续轮询下一个 endpoint

### 1.5 AmazonQCLI 模式

*   配置 `preferredEndpoint: 'amazonq-cli'`
*   **预期**: 出站 payload 里 NO `agentContinuationId`、NO `agentTaskType`,`origin` 是 `CLI`,User-Agent 用 CLI 变体

### 1.6 非流式解析器

*   同一个 tool-call 请求分别用 `stream: true` 和 `stream: false` 跑
*   **预期**: tool name + arguments 在两路返回中一致;非流式日志不应出现 `falling back to legacy regex parser`

* * *

## Phase 2 — 请求体清理

### 2.1 多轮 tool round-trip

*   发请求 + 一个 `Bash` 风格工具 → 收到 tool\_use → 回 tool\_result → 再发下一轮
*   **预期**: 无 400 `Improperly formed request`;响应里 tool name 已被 `restoreKiroToolCallNames` 还原成原名

### 2.2 sanitize 容错回归

*   构造一段畸形 history 发出去:
    *   两条连续的 user 消息
    *   一条空的 user 消息
    *   一个孤儿 tool\_use (没有匹配的 tool\_result)
*   **预期**: 请求成功;dump 出站 payload 确认:
    *   末尾**没有**伪造的 `Continue` assistant 消息(老逻辑残留)
    *   history 严格 user/assistant 交替
    *   孤儿 tool\_use 已被丢弃或补 failed result

### 2.3 orphan tool flatten

*   在 history 里塞一个工具名 `OldTool`,但当前请求的 `tools` 里**没有** `OldTool`
*   **预期**: 出站 payload 里 `OldTool` 引用变成纯文本 `<tool_use name="OldTool" id="...">{...}</tool_use>` + `<tool_result>...</tool_result>`,请求成功

### 2.4 modelId 仅在 currentMessage

*   dump 出站 payload,grep `modelId`
*   **预期**: 只在 `conversationState.currentMessage.userInputMessage.modelId` 出现一次,history 里**全部没有**

### 2.5 system prompt 形态

*   dump 出站 payload
*   **预期**: history 头部有两条注入消息:
    
    ```
    { userInputMessage: { content: "[Context: Current time is ...] ... <execution_discipline>..." } }
    { assistantResponseMessage: { content: "I will follow these instructions." } }
    ```
    
*   时间戳之外的字符应**逐字节匹配** translator.ts 的输出 (Phase 3 cache 命中前提)

### 2.6 token-based history trim

*   准备一段超长 history (比如塞几个 200K 字的对话历史)
*   **预期**: 日志出现 `[Kiro] trimHistoryByTokens: cut N message(s) ...`,无 `CONTENT_LENGTH_EXCEEDS_THRESHOLD` 400
*   trim 后 history 仍以 user 开头、user/assistant 交替