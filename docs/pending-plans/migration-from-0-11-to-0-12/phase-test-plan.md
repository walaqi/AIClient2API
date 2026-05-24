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