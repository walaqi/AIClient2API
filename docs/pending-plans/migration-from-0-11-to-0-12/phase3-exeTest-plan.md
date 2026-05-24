# Kiro 0.11 → 0.12 迁移 — Phase 3 手工测试规划

## Context

Phase 1 (commit 7a36fe5) 与 Phase 2 已分别 sign-off,Phase 3 (cache 与 thinking) 的代码改动已落在工作树但尚未独立验证。需按 [over_all_test_plan.md](docs/pending-plans/migration-from-0-11-to-0-12/over_all_test_plan.md) §3.1-§3.6 逐项执行,产出 `phase-3-testreport.txt`。

代码探查发现 3 处判据/实现不一致,影响测试形态:

1. **§3.2.b**:计划要求 `enabled` 模式下 `additionalModelRequestFields.thinking` 含 `budget_tokens=4096`。但 Phase 1 [Fix-D] (claude-kiro.js:2206-2218) 已确认 0.12 服务端 enum 仅接受 `["adaptive","disabled"]`,代码把 `enabled` 一并归为 `{type:'adaptive'}`(不下发 budget_tokens)。**测试按 Fix-D 实际行为执行,计划判据需修正**。
2. **§3.1 sessionHint**:[claude-kiro.js:1854](src/providers/claude/claude-kiro.js#L1854) 读 `this._currentRequestMetadata.session_id / conversation_id`,但**全项目 grep 无该字段赋值**(metadata 在 Claude API 规范里是 body 字段,本项目 KiroApiService 路径没接进去)。sessionHint 永远是 undefined,只有 fingerprint 路径生效。
3. **§3.6 metering**:仅流式路径 [claude-kiro.js:3162-3163, 3886, 3919](src/providers/claude/claude-kiro.js#L3886) 消费 metering 事件并算出 `cache_read_input_tokens`;非流式路径 [claude-kiro.js:2329](src/providers/claude/claude-kiro.js#L2329) 明确 `丢弃 (Phase 3.x 单独处理)`。

按用户决策:§3.2.b 按 Fix-D 行为测;§3.1 metadata 不在 header 而在 body,补线接入;§3.6 先补非流式 metering 再测。

---

## 测试前最小代码补全(随 Phase 3 一并 commit)

### Fix-E: 补 `_currentRequestMetadata` 写入(§3.1 前置)

补线让 `requestBody.metadata.{session_id|conversation_id}` 真正抵达 [resolveConversationId](src/providers/claude/claude-kiro.js#L666)。

- [claude-kiro.js:2932](src/providers/claude/claude-kiro.js#L2932) `generateContent` 入口:在 `if (requestBody._monitorRequestId)` 之前加
  ```js
  this._currentRequestMetadata = requestBody?.metadata || null;
  ```
- [claude-kiro.js:3296](src/providers/claude/claude-kiro.js#L3296) `generateContentStream` 入口同步加同样一行
- 不改 buildCodewhispererRequest 与 resolveConversationId 已有逻辑

复用现有函数:`resolveConversationId` (claude-kiro.js:666),`fingerprintFromClaudeMessages` (claude-kiro.js:642)。

### Fix-F: 非流式 metering 透传 + cache token 计算(§3.6 前置)

- [claude-kiro.js:2329](src/providers/claude/claude-kiro.js#L2329):把 metering 事件的 `event.data.usage` 累加到本地 `meteringCredits`(沿用流式 [claude-kiro.js:3466-3467](src/providers/claude/claude-kiro.js#L3466) 的语义)
- [claude-kiro.js:2351](src/providers/claude/claude-kiro.js#L2351):`parseEventStreamChunk` return shape 增加 `meteringCredits`
- [claude-kiro.js:2451](src/providers/claude/claude-kiro.js#L2451):legacy 兜底分支 return `meteringCredits: null` 占位(沿用 Phase 1 [Fix-C] 对 thinking 字段的处理模式)
- [claude-kiro.js:2929](src/providers/claude/claude-kiro.js#L2929):`_processApiResponse` 把 `meteringCredits` 透传出去
- [claude-kiro.js:2959-2976](src/providers/claude/claude-kiro.js#L2959-L2976):`generateContent` 收到后调 [calculateCacheTokens](src/utils/model-pricing.js)(已在文件顶部 import,流式路径同款用法)算 `cache_read_input_tokens` / `cache_creation_input_tokens`,通过 `buildClaudeResponse` 的 `inputTokens` 链路或直接补到 usage 对象

复用现有函数:`calculateCacheTokens` (utils/model-pricing.js,流式路径已用),`buildClaudeResponse`。

---

## 测试期临时诊断手段(测后清理)

沿用 Phase 1 §1.5 / Phase 2 §2.5 的"插入 logger.debug → 测后移除"模式:

1. **出站 payload dump**:在 [buildCodewhispererRequest](src/providers/claude/claude-kiro.js#L1851) `return request` 之前 插一条
   ```js
   logger.debug(`[Kiro Phase3 DIAG] outbound conversationState=${JSON.stringify(request.conversationState).slice(0, 8000)} addl=${JSON.stringify(request.additionalModelRequestFields || null)}`);
   ```
2. **入站 metering dump**:[claude-kiro.js:3466-3467](src/providers/claude/claude-kiro.js#L3466) 流式分支 + Fix-F 新增的非流式分支,各 `logger.debug` 一行 `meteringCredits` 与解析出的 `cacheReadTokens / cacheCreationTokens / inputTokens`
3. **conversationId 命中 dump**:[resolveConversationId](src/providers/claude/claude-kiro.js#L666) 返回前加一条 `logger.debug` 标注 cache hit / miss 与 fingerprint key 前 8 位

`configs/config.json` 的 `LOG_LEVEL` 已是 `debug`,无需改配置。

---

## 执行顺序(按 over_all_test_plan.md §"推荐测试顺序")

| 步骤 | Case | 备注 |
|---|---|---|
| 1 | §3.3 | Claude 3.x 不带 additionalModelRequestFields。模型选 `claude-3-5-sonnet-20241022`(配置里需先确认是否在 [MODEL_MAPPING](src/providers/claude/claude-kiro.js#L898) 内,否则回退 4-5)|
| 2 | §3.2.a | adaptive 模式,出站含 `additionalModelRequestFields.thinking={type:"adaptive"}` |
| 3 | §3.2.b | **按 Fix-D 行为**:`enabled` 模式 出站含 `{type:"adaptive"}`(无 budget_tokens),记录与计划判据的差异(`[C3]`) |
| 4 | §3.2.c | `disabled` / 不传:出站无 `additionalModelRequestFields` |
| 5 | §3.4 | 客户端构造含 thinking content block 的 history,出站 `assistantResponseMessage` 不含 `reasoningContent`、content 文本不含 `<thinking>` 标签 |
| 6 | §3.5 | 单次请求 + tools + system prompt,出站 `userInputMessageContext.tools` 末尾有 `{cachePoint:{type:"default"}}`,且 `history[0].userInputMessage.cachePoint={type:"default"}`(Phase 2 §2.5 已横向覆盖,此处单独 dump 确认) |
| 7 | §3.1-A | **fingerprint 路径**:同一段 history(前 2 条 user 内容一致)发两次,2h 内 `conversationId` 相同 |
| 8 | §3.1-B | **sessionHint 路径**(Fix-E 后):body 带 `metadata.session_id="phase3-test"`,history 改变前 2 条但 session_id 不变,`conversationId` 仍相同 |
| 9 | §3.6 | `stream:true` 同一会话连发两次,第二次 `cache_read_input_tokens` 显著大于 0;额外用 `stream:false` 复测一次(Fix-F 后) |

每个 case 抓:出站 payload(/tmp/phase3-X.X.outbound.json)+ 入站 metering(/tmp/phase3-X.X.metering.log)。

---

## 关键文件

- **主测试目标**:[src/providers/claude/claude-kiro.js](src/providers/claude/claude-kiro.js)
- **前置改动**:同上(Fix-E 在 :2932 / :3296;Fix-F 在 :2329 / :2351 / :2451 / :2929 / :2959-2976)
- **判据来源**:[docs/pending-plans/migration-from-0-11-to-0-12/over_all_test_plan.md](docs/pending-plans/migration-from-0-11-to-0-12/over_all_test_plan.md)
- **产出**:`docs/pending-plans/migration-from-0-11-to-0-12/phase-3-testreport.txt`
- **参考实现**(对照):`/home/chris/projects/Kiro-account-manager/Kiro-account-manager/src/main/proxy/translator.ts:1015-1054` (kiroApi conversationId cache),`translator.ts:713-810` (execution_discipline)

---

## 验证

1. **功能正确性**:9 个 case 全部按上表判据 PASS;失败时回到 claude-kiro.js + 参考实现对照修复,再 reroll 该 case 与之后所有依赖 case
2. **代码清理验证**:测试后 `grep -nE "Kiro Phase3 DIAG|phase3-diag" src/` 应为空,Fix-E / Fix-F 的真实修复保留
3. **回归不引入**:Phase 1 §1.6(parser parity)与 Phase 2 §2.5/§2.4(modelId / cachePoint)在 §3.1-§3.6 完成后再各跑一次抽样,确认未破坏既有形态
4. **报告输出**:对齐 `phase-1-testreport.txt` / `phase-2-testreport.txt` 结构(逐用例结论 + 实质性 bug 修复 + 计划修正 + 清理确认 + 建议),把 `[C3]`(§3.2.b 判据修正)、Fix-E、Fix-F 都记入

---

## 不在本次范围

- Phase 1 [F2] SOCIAL+AmazonQCLI user-agent 策略(单独 issue)
- aws-event-stream-parser.js:69 `:event-type` header 派发改造(单独 issue)
- 全部测试用例的自动化(本次仍是手工测试,与 Phase 1/2 同模式)
