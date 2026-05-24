# Phase 2 手工测试方案 — Kiro 0.11 → 0.12 迁移

## Context

Phase 1 已签字 PASS (见 `docs/pending-plans/migration-from-0-11-to-0-12/phase-1-testreport.txt`)。`git show --stat 7a36fe5` 显示该 commit 实际把 Phase 1 + Phase 2 + Phase 3 的代码改动一次性带进了 HEAD,工作区目前是干净的 (仅 `memo.md` 与 docs/ 未跟踪)。

因此 **Phase 2 测试的对象就是当前 HEAD 上已就绪的代码**,不存在 work-in-progress 差异。本次目标:验证请求体重建 (§2.1-§2.6) 不再触发 `400 Improperly formed request`,且出站 `conversationState` 形态符合 0.12 IDE 协议。

测试节点沿用 Phase 1 的 SOCIAL OAuth 凭证 (`a02bd631-9099-423b-968c-8f8ef181bdff`,uuid `3950825e`),日志根 `logs/app-2026-05-24.log`。所有步骤在工作区直接执行,**不 commit**。

## 关键被测代码 (HEAD 已就绪)

- `sanitizeKiroConversation` 7 步管线: [src/providers/claude/claude-kiro.js:551-565](src/providers/claude/claude-kiro.js#L551-L565)
- `normalizeKiroToolHistory` orphan flatten: [src/providers/claude/claude-kiro.js:515-548](src/providers/claude/claude-kiro.js#L515-L548)
- Token-based trim + 图片剥离: [src/providers/claude/claude-kiro.js:567-634](src/providers/claude/claude-kiro.js#L567-L634), 图片阈值 [src/providers/claude/claude-kiro.js:2036-2098](src/providers/claude/claude-kiro.js#L2036-L2098)
- System prompt synthetic Human/AI pair: [src/providers/claude/claude-kiro.js:2002-2033](src/providers/claude/claude-kiro.js#L2002-L2033)
- modelId 仅在 currentMessage: [src/providers/claude/claude-kiro.js:2178-2180](src/providers/claude/claude-kiro.js#L2178-L2180)
- KiroToolNameRegistry (FNV-1a, ≤64 字符): [src/providers/claude/claude-kiro.js:694-744](src/providers/claude/claude-kiro.js#L694-L744)
- restoreKiroToolCallNames: [src/providers/claude/claude-kiro.js:771-783](src/providers/claude/claude-kiro.js#L771-L783)
- callApi / streamApiReal 出站点: [src/providers/claude/claude-kiro.js:2188](src/providers/claude/claude-kiro.js#L2188) (callApi), 流式 ~3050 行附近

## 测试基础设施 — 临时 payload dump

`over_all_test_plan.md` 引用的 `logRequests` / `logStreamEvents` 配置项在当前 codebase **不存在** (`grep -rn "logRequests\|logStreamEvents" src/ configs/` 空)。Phase 1 保留的三处 `logger.debug` 只 dump headers,无法看到 `conversationState`。

**测试期临时手段** (测完移除,与 Phase 1 §1.5 endpointPayload dump 同模式):

1. 在 [src/providers/claude/claude-kiro.js:2188](src/providers/claude/claude-kiro.js#L2188) (callApi 路径,`request` 已构造完成、即将 axios.post 之前) 插入:
   ```js
   logger.debug('[Kiro Phase2 DIAG] outbound conversationState=' + JSON.stringify(request.conversationState));
   logger.debug('[Kiro Phase2 DIAG] outbound additionalModelRequestFields=' + JSON.stringify(request.additionalModelRequestFields || null));
   ```
2. 流式路径 streamApiReal 同位置 (~3050 行附近) 同样插入一条等价的 dump。
3. `configs/config.json` 临时把 `logLevel` 改为 `debug` (测完恢复)。
4. 用 `tail -F logs/app-2026-05-24.log | grep "Kiro Phase2 DIAG"` 实时取 payload,jq 校验。

Sign-off 前必须 grep 确认 `Kiro Phase2 DIAG` 全部移除、`logLevel` 恢复。

## 客户端

用 `curl` 直打本地 `:3010/v1/messages`,`Authorization: Bearer 123456`。每个 case 把 body 存到 `/tmp/phase2-{caseId}.json`,响应存到 `/tmp/phase2-{caseId}.resp.json`,出站 payload (从日志 grep 后) 存到 `/tmp/phase2-{caseId}.outbound.json`。便于复盘与对照。

## 推荐执行顺序 (按 over_all_test_plan.md L364-365)

§2.5 → §2.4 → §2.1 → §2.2 → §2.3 → §2.6

理由:§2.5 与 §2.4 是 payload 形态固定项,先确认基线;§2.1 跑 happy path 确认 tool round-trip;§2.2/§2.3 测容错 (前者畸形输入、后者 orphan 工具) 在 happy path 之后做;§2.6 涉及大体量构造,留到最后。

---

## §2.5 System prompt 形态 (Human/AI synthetic pair)

**步骤**

1. body:
   ```json
   { "model": "claude-sonnet-4-5", "max_tokens": 256, "system": "You are a helpful assistant.", "messages": [ {"role":"user","content":"Say hi."} ] }
   ```
2. 取出站 `conversationState`。

**判据**

- `history[0].userInputMessage.content` 形如 `[Context: Current time is 2026-05-24T...]\n\nYou are a helpful assistant.\n\n<execution_discipline>...</execution_discipline>` (起始 `[Context:`,末尾 `</execution_discipline>` 与一个换行)。
- `history[0].userInputMessage.origin === 'AI_EDITOR'` (KIRO_CONSTANTS.ORIGIN_AI_EDITOR)。
- `history[0].userInputMessage.cachePoint = { type: 'default' }` (§3.5 同时验证,这里顺手对一下)。
- `history[1].assistantResponseMessage.content === 'I will follow these instructions.'`。
- `history[0].userInputMessage` **没有** `modelId` 字段 (留给 §2.4 再 grep 一次全 history)。
- `<execution_discipline>` 文本与 [src/providers/claude/claude-kiro.js:2007-2015](src/providers/claude/claude-kiro.js#L2007-L2015) 当前实现 byte-stable 一致 (用 `diff <(jq -r '.history[0].userInputMessage.content' /tmp/phase2-2.5.outbound.json) <(node -e "...")` 比对最稳;最低限度 `grep -F '<execution_discipline>'` 与结尾 tag 都在)。
- 旧 3-branch heuristic (system prompt 注入第一个 user message) 已在源码中搜不到 (`grep -n "first user message" src/providers/claude/claude-kiro.js` 空)。

**失败信号** 见 over_all_test_plan.md L210。

---

## §2.4 modelId 仅在 currentMessage

**步骤**

复用 §2.5 的 outbound;再加一轮 `assistant + user` follow-up,dump 一次,确认多轮也只有 currentMessage 上有 modelId。

**判据**

- `jq '[.history[].userInputMessage?.modelId, .history[].assistantResponseMessage?.modelId] | map(select(. != null)) | length' outbound.json` → `0`。
- `jq -r '.currentMessage.userInputMessage.modelId' outbound.json` → 与请求里的 `model` 字段对得上 (注意可能经过 model mapping;以 [src/providers/claude/claude-kiro.js:2178-2180](src/providers/claude/claude-kiro.js#L2178-L2180) 的 `kiroModelId` 计算结果为准)。
- `grep -c '"modelId"' outbound.json` → 全 payload 仅 1 处。

---

## §2.1 多轮 tool round-trip

**步骤**

1. 第 1 轮 — 发起 (定义 `run_bash`):
   ```json
   { "model":"claude-sonnet-4-5", "max_tokens":1024,
     "tools":[{"name":"run_bash","description":"Run a shell command (test tool with intentionally long description so the registry hash path actually fires; the description text here serves no other purpose than to push internal name handling logic).","input_schema":{"type":"object","properties":{"cmd":{"type":"string"}},"required":["cmd"]}}],
     "messages":[ {"role":"user","content":"Run `echo hello` for me."} ] }
   ```
2. 取响应中的 `tool_use` 块 (`name=run_bash`, `id=toolu_xxx`),保存。
3. 第 2 轮 — 回送 tool_result + follow-up:
   ```json
   { ..., "messages":[
       {"role":"user","content":"Run `echo hello` for me."},
       {"role":"assistant","content":[{"type":"tool_use","id":"toolu_xxx","name":"run_bash","input":{"cmd":"echo hello"}}]},
       {"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_xxx","content":"hello\n"},{"type":"text","text":"What did you get back?"}]}
   ]}
   ```
3. 第 3 轮 — 拿到 assistant 的最终回答即可结束。

**判据**

- 三轮 HTTP 全部 200,无 `Improperly formed request`。
- 出站 payload 里 `tools[].toolSpecification.name` 是 hash 形态 (`run_bash_${hash}`,长度 ≤ 64),**不是** `run_bash`;实际形态以 `KiroToolNameRegistry.toKiroName` 在 [src/providers/claude/claude-kiro.js:694-744](src/providers/claude/claude-kiro.js#L694-L744) 的逻辑为准 (`run_bash` 长度 8 远小于 64,可能直接保留;若是这样则要给一个 description+name 长度刻意超 64 的辅助 case,把 run_bash 改成 `run_bash_with_a_very_very_long_descriptive_name_that_exceeds_64_chars_threshold`)。
- 客户端响应 `content[].tool_use.name === "run_bash"` (经 [src/providers/claude/claude-kiro.js:771-783](src/providers/claude/claude-kiro.js#L771-L783) `restoreKiroToolCallNames` 还原)。
- `grep -c "Continue" outbound.json` → 0 (无 dummy assistant 后缀)。`grep -n "I will follow these instructions" outbound.json` 应只在 history[1] 出现 1 次 (§2.5 的 synthetic pair),不应作为多余的 assistant 修补出现。

**辅助 case**: 若上面 `run_bash` 没触发 hash 路径,补一个长名 case 验证 hash 端到端。

---

## §2.2 sanitize 容错回归

每个 case 的请求体保持其它字段一致,只换 `messages` 数组,确认 5 种畸形全部 200。

| Case | messages 构造 | 7 步管线哪一步生效 |
|------|---------------|-------------------|
| A — assistant 起头 | `[{role:"assistant",content:"hi"},{role:"user",content:"continue please"}]` | `ensureStartsWithUserMessage` ([:200-216](src/providers/claude/claude-kiro.js#L200-L216)) 在前面塞 KIRO_HELLO_MESSAGE |
| B — 双 user 连续 | `[{role:"user",content:"part1"},{role:"user",content:"part2"}]` | `ensureAlternatingMessages` 中间塞 KIRO_CONTINUE_MESSAGE |
| C — 空 user | `[{role:"user",content:""},{role:"user",content:"hello"}]` | `removeEmptyUserMessages` ([:372-384](src/providers/claude/claude-kiro.js#L372-L384)) 删除空条 |
| D — orphan tool_use | `[{role:"user",content:"x"},{role:"assistant",content:[{type:"tool_use",id:"toolu_a",name:"run_bash",input:{cmd:"x"}}]},{role:"user",content:"再说一句"}]` (无 tool_result) | `ensureValidToolUsesAndResults` ([:311-370](src/providers/claude/claude-kiro.js#L311-L370)) flatten 成 XML 文本 |
| E — 末尾非 user | `[{role:"user",content:"hi"},{role:"assistant",content:"hello"}]` | `ensureEndsWithUserMessage` 追加 KIRO_CONTINUE_MESSAGE |

**判据**

- 5 个 case 全部 HTTP 200,响应 `content[]` 非空。
- `grep -nE "Continue assistant|fake assistant|dummy assistant" src/providers/claude/claude-kiro.js` → 应该都是新代码的合理用法 (KIRO_CONTINUE_MESSAGE 仅作 user 侧填充,以及 [:2167](src/providers/claude/claude-kiro.js#L2167) 的防御性 warn 路径),无旧版伪造 assistant 回复的痕迹。
- 各 case 的出站 `history` 序列形态符合上表第 3 列。

**失败信号**: 任何一个 case 400;或者 case D 的 outbound 仍含结构化 `toolUses` 节点。

---

## §2.3 Orphan tool flatten (normalizeToolHistory)

**步骤**

```json
{ "model":"claude-sonnet-4-5", "max_tokens":512,
  "tools":[{"name":"current_tool","description":"only valid tool now","input_schema":{"type":"object","properties":{}}}],
  "messages":[
    {"role":"user","content":"先跑老工具"},
    {"role":"assistant","content":[{"type":"tool_use","id":"toolu_legacy","name":"LegacyTool","input":{"foo":"bar"}}]},
    {"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_legacy","content":"legacy ok"}]},
    {"role":"assistant","content":"ok done"},
    {"role":"user","content":"现在用 current_tool 干别的"}
  ]
}
```

**判据**

- 出站 `history` 中 LegacyTool 已被 [src/providers/claude/claude-kiro.js:515-548](src/providers/claude/claude-kiro.js#L515-L548) `normalizeKiroToolHistory` 改写成纯文本块 (形如 `<tool_use name="LegacyTool" id="toolu_legacy">...</tool_use>` 与对应 `<tool_result tool_use_id="toolu_legacy">legacy ok</tool_result>`)。
- 出站 `tools[]` (含 `cachePoint`) 中只有 `current_tool` 的 hash 形态,**没有** LegacyTool。
- `jq '.. | objects | select(has("toolUses") or has("toolResults"))' outbound.json` → 空 (无结构化引用未知工具)。
- HTTP 200。

**失败信号** 见 over_all_test_plan.md L176。

---

## §2.6 Token-based history trim

**步骤**

构造一段超长 history,塞到模型 context window 上限附近 (claude-sonnet-4-5 的 MODEL_CONTEXT_TOKENS = 200000,见 [src/providers/claude/claude-kiro.js:837-847](src/providers/claude/claude-kiro.js#L837-L847)):

- 准备一个 ~20KB 的英文/中文 lorem 文本块 `BIG`,让单条消息约消耗 ~5000 tokens。
- 拼 25 轮 user/assistant 交替,前 20 轮各塞 `BIG`,**第 1/3/5 轮**的 user content 里再附带一个 `image` block (用一段 base64 PNG ~50KB),共 3 张图。
- 末尾 5 轮是真正的 user/assistant 短对话 (倒数第 5 条之内)。
- 最后一条 user "请简短总结前面"。

调用前在客户端确认按 anthropic token 估算(可粗略用字符 / 3.5 估)body 总量在 250K-300K 之间,确保超出预算。

**判据**

- HTTP 200,响应 `content[]` 非空。
- 出站 `history` 长度 < 客户端发的 `messages` 长度,被裁掉的是从前往后的旧消息。
- `jq '[.history[] | .userInputMessage?.userInputMessageContext?.images? // [] | length] | add' outbound.json`:
  - 倒数第 5 条之前 (即被 distanceFromEnd > 5 命中的位置) **不应**有 images;
  - 末尾 5 条以内的 images 保留 (本 case 全在前面、所以全应剥离)。
- 被裁掉/剥离图片的 user 消息 content 中含占位 `[此消息包含 N 张图片,已在历史记录中省略]` (来自 [src/providers/claude/claude-kiro.js:2037-2098](src/providers/claude/claude-kiro.js#L2037-L2098))。
- 不出现 "tool_use 留下而 tool_result 被裁掉" 的失衡 (本 case 没有工具,严格说不会触发,但仍 grep 一次 `jq '.history[] | select(.userInputMessage.userInputMessageContext.toolResults?)' outbound.json` 与 toolUses 配对计数应一致)。
- 出站 `inputTokens` 估算应 ≤ `MODEL_CONTEXT_TOKENS - tokenBufferReserve` (默认 reserve = 50000,所以上限约 150000 tokens)。

**失败信号** 见 over_all_test_plan.md L227。

---

## 全程横向校验 (穿插每个 case 都顺手做一次)

- `grep -c '"modelId"' outbound.json` 必须 = 1 (§2.4 的硬约束)。
- `jq '.history[0].userInputMessage.cachePoint' outbound.json` = `{"type":"default"}` (§2.5 + §3.5 锚点)。
- `jq '.history[1].assistantResponseMessage.content' outbound.json` = `"I will follow these instructions."`。
- `grep -nE "<thinking_mode>|</thinking_mode>" outbound.json` → 空 (旧 inline thinking 标签已停用,Phase 3.2 锚点提前看一眼;若发现,留作 Phase 3 再追)。

## 清理 & sign-off

测试结束后:

1. 移除 callApi/streamApiReal 两处 `Kiro Phase2 DIAG` debug log。
2. `configs/config.json` 的 `logLevel` 恢复原值。
3. `grep -nE "Kiro Phase2 DIAG|phase2-diag|__phase2" src/` 必须空。
4. `git status` 确认 src/ 干净。
5. 把执行结果按 phase-1-testreport.txt 同款结构写到 `docs/pending-plans/migration-from-0-11-to-0-12/phase-2-testreport.txt`,字段:日期 / 执行计划 / 测试节点 / 总体结论 / 逐用例结论 / finding (若有) / 清理确认 / 建议。

## 验证 (用本机服务,不依赖外部)

1. `node src/services/api-server.js` 起服务 (端口 3010)。
2. 按上述 §2.5 → §2.4 → §2.1 → §2.2 (5 case) → §2.3 → §2.6 顺序逐个 curl,每个 case 同时 `tail -F logs/app-2026-05-24.log | grep 'Kiro Phase2 DIAG'` 抓 outbound payload,落到对应 `/tmp/phase2-*.outbound.json`。
3. 用 jq / grep 按上文判据逐项核对。
4. 全部 PASS 后清理代码与配置,写报告。

## 风险 / 注意

- §2.6 用真实 ~50KB base64 图片 ×3 + 25 轮 ~5KB 文本,单 body ≈ 1.5MB,需要确认客户端不被 4MB 限额挡住;若挡了改用更小图 + 更多轮。
- §2.1 的 hash 行为依赖 `KIRO_MAX_TOOL_NAME_LENGTH=64` ([:694](src/providers/claude/claude-kiro.js#L694));短名 `run_bash` 不会触发 hash 路径,要确认 hash 端到端,需要补一个长名工具,见该节注释。
- 若 §2.5 测出 execution_discipline 文案与参考实现 byte 不同 → 不是 PASS,Phase 3.6 cache 命中也会失败;立刻停下来对照 translator.ts:713-810 修文案后再继续。
- DIAG log 里 conversationState 是完整 history,可能含敏感对话;测完务必 `truncate -s 0 logs/app-2026-05-24.log` 或归档加密保存。
