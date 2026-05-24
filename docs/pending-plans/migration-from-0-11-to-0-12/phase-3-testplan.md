## Phase 3 — 缓存 + 思考

### 3.1 conversationId 稳定性

*   同一个 client、同一段 history,前后发两次请求(2h 内)
*   **预期**: 两次请求日志里的 `conversationId` 完全一致
*   改动 history 的第一条 user 消息内容,再发一次 → `conversationId` 应该变了
*   显式带 `metadata.session_id: "test-123"` 发两次 → 无论 history 怎么变,id 都一致


### 3.2 native thinking (Claude 4+) — 续

*   **预期 (响应)**: reasoning 作为 thinking content block 返回, 不是被 <thinking>...</thinking> 文本标签包裹的 text block
*   用 thinking: { type: 'enabled', budget\_tokens: 8000 } 再测一次 → 出站 payload 里 additionalModelRequestFields.thinking 应为 { type: 'enabled', budget\_tokens: 8000 } (budget 经过 \_normalizeThinkingBudgetTokens 钳制到 \[MIN, MAX\] 区间)
*   用 thinking: { type: 'disabled' } → additionalModelRequestFields 字段**完全不出现**于 payload

### 3.3 Claude 3.x 跳过 thinking

*   如果环境里有 Claude 3.x 模型可用 (比如经 MODEL\_MAPPING 映射过的 sonnet-3.5),发同样带 thinking 的请求
*   **预期**: 出站 payload 里**没有** additionalModelRequestFields 字段 (服务端会拒)
*   没有 Claude 3.x 模型可测就跳过本项

### 3.4 history reasoning 丢弃

*   构造一段 history, assistant 消息里包含 type: 'thinking' 的 content block (thinking 字段塞点假 reasoning 文本)
*   发请求, dump 出站 payload
*   grep 整个 payload 找 reasoningContent、<thinking>、<thinking\_mode> 三个字符串
*   **预期**: history 里一个都不应出现; assistant content 只剩纯文本部分

### 3.5 cachePoint 标记位置

*   dump 出站 payload, 验证两处 cachePoint:
    1.  currentMessage.userInputMessage.userInputMessageContext.tools 数组的**最后一个元素**是 { cachePoint: { type: 'default' } }, 前面是若干个 { toolSpecification: {...} }
    2.  history 第一条 synthetic system-prompt user message 的 userInputMessage.cachePoint 等于 { type: 'default' }

### 3.6 cache 命中可观测

*   同一个 sessionHint、相同 system prompt、相同 tools 列表, 在 2h 内连发两次请求
*   看 meteringEvent (流式响应里) 或最终 usage 字段:
    *   **第一次**: cacheWriteTokens > 0, cacheReadTokens 等于 0
    *   **第二次**: cacheReadTokens > 0 (理想接近 system prompt + tools 的 token 量)
*   两次都是 0 时, 排查顺序:
    *   conversationId 两次是否真的一样 (Phase 3.1 是否生效)
    *   system prompt 是否字节级稳定 (execution\_discipline 文本不能动、timestamp 之外的差异要查)
    *   tools 数组顺序是否稳定 (tools 重排会破坏 cache key)