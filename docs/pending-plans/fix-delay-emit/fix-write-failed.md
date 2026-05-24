# Kiro `Write` 工具 content 为空导致客户端 "Write failed / aborted" — 多 capture 取证 + 修复计划

## Context（背景）

用户在使用代理时遇到客户端报错 `Write file - Write failed` 紧跟 `API Error: aborted`，最初怀疑是上游 Write 工具调用 `content` 字段为空导致。

代码审阅已经识别出两个**值得关注**的代理端代码缺陷（详见下文 Suspect 1 / 2），任一都足以独立造成相同症状。同时，仓库里已有一份历史结论（[docs/pending-plans/compress the inputs/Input Token (Context) 压缩 — 防截断实施计划.md:5](docs/pending-plans/compress the inputs/Input Token (Context) 压缩 — 防截断实施计划.md)）声称"根因已通过 KIRO_CAPTURE_RAW 确认：API 自身停止发送，非代理端问题"，但用户已表态：**"上次的分析未必正确"**——那份结论基于单次 capture，可能与本次故障并非同一根因，也未必排除代理端因素。前次按该结论尝试的修复（commit 53b365f）因严重影响 tool 执行被整体回退。

因此，本次的核心方法论是：**先用现成的 `KIRO_CAPTURE_RAW` 机制连续抓多份 capture（包括成功与失败两类），离线 replay 比对，再决定修哪个**。避免基于单一样本得出过早结论。

**关于工具名/参数名翻译——明确不做**：用户已表态："从执行的角度看, 模型应该会根据发出的 tool-specification 调整输出的参数. 所以我认为进行替换是没有必要的。" 即：模型会按照代理向 Kiro 注册的 tools[] schema（Anthropic 风格 `Write({file_path, content})`）来生成参数，不需要把 `Write` → `fs_write`、`file_path` → `path` 这种语义翻译。当前透传行为正确，多数 Claude Code 使用场景跑通正是侧证。但**有一个边界条件值得防御**——见下文 Suspect 2 加固说明。

参考用户附上的尾部 chunk 诊断（同一请求）：

```
chunkCount=131, totalRawBytes=23630, lastChunkLen=166
tail=metering event {"unit":"credit","usage":0.572...}
```

最后一帧是正常 metering 帧，**说明上游流并未在 socket 层被截断**。content 字段缺失（如果属实）可能的成因：
(a) 上游确实没发 content（Kiro 自身行为，例如 output budget 用尽）；
(b) 代理端解析/分发把 content 丢了（Suspect 1）。
**只有 capture 数据能区分这两种情况**——这是 Phase 1 必须先做的原因。

## 已识别的两个代理端候选缺陷（需 capture 取证以确认是否命中本次故障）

### Suspect 1 — 流式路径"事后丢弃"为时已晚（强嫌疑）

[generateContentStream](src/providers/claude/claude-kiro.js#L2595) 收到上游 `toolUse` / `toolUseInput` 事件后会**立即** yield 给下游：

- [claude-kiro.js:2940-2949](src/providers/claude/claude-kiro.js#L2940-L2949) 立即下发 `content_block_start`
- [claude-kiro.js:2960-2972](src/providers/claude/claude-kiro.js#L2960-L2972) 立即下发首帧 `input_json_delta`
- [claude-kiro.js:3015-3025](src/providers/claude/claude-kiro.js#L3015-L3025) 续传 `input_json_delta`

直到 `tc.stop=true` / `toolUseStop` / 流末尾才用 [isIncompleteFileToolCall](src/providers/claude/claude-kiro.js#L398-L403) 判定是否丢弃。问题是：判定触发时 `content_block_start` 与所有 deltas 已经发往客户端；接着继续 yield `content_block_stop`（[2996](src/providers/claude/claude-kiro.js#L2996)、[3050](src/providers/claude/claude-kiro.js#L3050)、[3083](src/providers/claude/claude-kiro.js#L3083)），客户端误以为 tool_use 块已完整；最后 `stop_reason` 因 `toolCalls.length === 0` 变 `end_turn`（[3203](src/providers/claude/claude-kiro.js#L3203)），客户端拿仅有 `file_path` 的残缺 input 去执行 → `Write failed` → SDK `API Error: aborted`。

也就是说：服务端"丢弃"了，客户端却依然按已下发的 deltas 执行。状态不一致。**用户的报错症状与该路径完全吻合**。

### Suspect 2 — `isIncompleteFileToolCall` 判据有两处缺陷（确定性 bug，键名容错 + Edit 误判）

[claude-kiro.js:398-403](src/providers/claude/claude-kiro.js#L398-L403)：

```js
return parsedInput.file_path && !parsedInput.content;
```

**缺陷 2a — Edit 工具被一律误判**：Edit 的合法参数是 `file_path` + `old_string` + `new_string`，**没有** `content` 字段。该规则把每个本来正常的 Edit 调用都标为"不完整"。叠加 Suspect 1 后，等于流式路径下每个 Edit 调用：deltas 已下发→服务端事后丢弃→stop_reason=end_turn→客户端行为不可预期。

**缺陷 2b — 键名容错缺失（用户点名的有价值边界条件）**：用户原话——"If the model ever emits `path` instead of `file_path`, the existing `isIncompleteFileToolCall(Write, …)` check at [claude-kiro.js:398-403](src/providers/claude/claude-kiro.js#L398-L403) would fail (`!parsedInput.content` is true) and discard the call — which produces exactly the symptom the user is seeing."

虽然代理向 Kiro 注册的 tools[] 是 Anthropic 风格 schema（`Write({file_path, content})`），模型**绝大多数情况下**会按这个 schema 输出。但模型偶发地生成 Kiro 风格 key（`path`/`text`/`oldStr`/`newStr`）——可能因 Kiro 训练数据偏置、system prompt 中包含 IDE 提示，或长上下文里参数 schema 被压缩——并非完全不可能。一旦发生，当前判据：
- `parsedInput.file_path` 不存在 → 判据返回 `false`（"完整"），但客户端拿 `{path: ...}` 不会被识别为 Write 入参，行为不可预期；
- 或者 `parsedInput.path` 存在但 `parsedInput.content` 不存在（因为模型写的是 `text`）→ 当前判据走的是 `!parsedInput.file_path` 分支不命中，**或者**——更糟的情况——一旦未来某个改动让 `file_path` 也有但 `content` 没有，就会被丢弃。

**这是个零成本的防御性加固**——不是语义翻译，仅是"判据本身要兼容两种 key 名"。修复在 Phase 3 修复 D 中合并实施。

### 两个嫌疑互相独立

Suspect 1 是"机制问题"（流式 race），Suspect 2 是"判据问题"（Edit 误判 + 键名容错缺失）。任何一个在 capture 离线 replay 时都能直接观察到。两者**可以并存**——同一份失败 capture 完全可能同时触发。

## Plan（推荐方案）

三阶段。Phase 1 取证（✅ 已完成）、Phase 2 离线分析（✅ 已完成）、Phase 3 实施修复（待执行，方案已基于 Phase 2 数据落定，见下文）。

### Phase 1 — 多份 capture 取证（只读、不改代码） ✅ 已完成

**目标**：用现有 [KIRO_CAPTURE_RAW](src/providers/claude/claude-kiro.js#L2380-L2390) 机制（已实现：每请求一文件，路径 `${dir}/kiro-${stamp}-${invocationId8}.bin`）连续抓多份样本，覆盖成功与失败。

操作：

1. 在用户当前部署上配置 `KIRO_CAPTURE_RAW=/tmp/kiro-raw/$(date +%F)`（或任意目录）后重启服务。
2. 让用户**正常使用**一段时间（例如半天到一天），让 Claude Code 自然产生大量请求。期间用户照常工作，**不需要刻意复现**。
3. 用户每次遇到 `Write file - Write failed` / `API Error: aborted` 时：
   - 立刻把当时的客户端时间戳（精确到秒）和故障描述记下来；
   - 同时记录该故障对应的工具是 Write 还是 Edit，目标 `file_path` 是什么（如果客户端有显示）。
4. 观察期结束后，把 `/tmp/kiro-raw/` 下的所有 `.bin` 文件 + 用户记录的故障时间戳 + 同期代理的 `[Req:...]` 日志一并提供给我。

预期产物：
- 至少 **3 份失败请求**的 `.bin` capture（按时间戳与代理日志中的 `invocationId` 对齐）；
- 至少 **3 份成功请求**的 `.bin` capture 作为对照（同一会话里、同样使用 Write/Edit 的请求）；
- 代理端 `[Req:...]` 日志（覆盖整个抓取窗口），用于按 `invocationId` 关联 capture 与故障时间。

注：**不在 Phase 1 里改代码、不加额外日志**。原因有二：
(a) 现有 capture 机制保留了原始字节，离线 replay 时能看到完整事件序列，不缺信息；
(b) 改代码再让用户复现增加变量、拖长周期、且可能影响排查可信度。

### Phase 2 — 离线 replay 与比对分析（只读） ✅ 已完成（2026-05-22）

**目标**：用现有解析器对每份 capture 做静态 replay，把"上游真实发送了什么"与"代理向客户端 yield 了什么"两件事**分别**重现，定位 content 丢失发生在哪一层。

可以复用项目里已有的能力，**不需要新增脚本**：

- [parseAwsEventStreamFrames](src/providers/claude/aws-event-stream-parser.js#L19) — 从 `.bin` 读 buffer 直接 parse 出事件流；
- [tests/providers/claude-kiro-parser-fixture.test.js](tests/providers/claude-kiro-parser-fixture.test.js) — 已有的 fixture 解析模式可直接套用；
- [tests/fixtures/kiro-stream/](tests/fixtures/kiro-stream/) — 已有 `pure-text.bin` / `single-tool.bin` / `multi-tool.bin` / `reasoning-text.bin`（thinking-only 场景，82KB，已在 [claude-kiro-parser-fixture.test.js:27-29](tests/providers/claude-kiro-parser-fixture.test.js#L27-L29) 使用）作为成功对照参考。

对每一份失败 capture，用一段最小 Node REPL 脚本（口头执行、不入库）做下列检查并记录结果：

1. **上游层面**：parse 出的所有 `toolUse` / `toolUseInput` 事件按 `toolUseId` 聚合，把 `input` 拼接后 JSON.parse，逐字段检查：
   - 工具名是否原样（`Write`/`Edit`/`Read`/`Bash`）还是被 Kiro 改写成（`fs_write`/`str_replace`/`read_file`/`execute_pwsh`）？
   - `parsedInput` 的 key 集合：是否是 Anthropic 风格（`file_path`、`content`、`old_string`、`new_string`）？还是 Kiro 风格（`path`、`text`、`oldStr`、`newStr`）？或混合？
   - `parsedInput.file_path` / `parsedInput.path` 是否存在？
   - `parsedInput.content` / `parsedInput.text` 是否存在？是否为空字符串？是否为非空字符串？
   - 如果是 Edit/str_replace，`old_string`/`oldStr`、`new_string`/`newStr` 是否齐全？
   - 是否有 `tc.stop=true` / `toolUseStop` 事件？
   - 末尾是否有 `metering` 事件（流是否完整）？
2. **代理转换层面**：模拟跑一遍 [generateContentStream](src/providers/claude/claude-kiro.js#L2595) 的事件→Anthropic delta 转换，记录序列化出的 `input_json_delta` 拼接结果与 `stop_reason`，与上游层面比对。
3. **跨样本比对**：把成功与失败两组 capture 的字段统计列成表（工具名形态/key 形态/content 是否在/长度/是否触发 isIncompleteFileToolCall）。

期望从数据中得出三种结论之一（可并存）：

- **结论 A — 上游确实没发 content**：失败 capture 在 1 步骤就显示 `parsedInput.content`（或对应 key）缺失或空字符串；成功 capture 都有非空。则确认 Suspect 1（机制问题）+ 上游行为问题，进 Phase 3 修复 A+B。
- **结论 B — 上游发了，代理丢了**：失败 capture 在 1 步骤显示 content 完整，但 2 步骤显示代理 yield 出去时丢了。说明是纯代理端 bug（解析路由 / delta 拼接 / repair JSON 失败等），需进 Phase 3 修复 C（待具体定位）。
- **结论 C — Suspect 2 命中**：失败 capture 是 Edit 调用被一律误判（缺陷 2a），或 `parsedInput` 用了 Kiro 风格 key（`text`/`path`/`oldStr`/`newStr`）触发键名容错缺失（缺陷 2b）。两者都进 Phase 3 修复 D。

注：步骤 1 的字段统计（key 集合是 Anthropic 风格 / Kiro 风格 / 混合）保留——它直接喂给修复 D 的兼容范围设计，而不是导出独立结论。

三种结论之间**可以并存**——多份 capture 完全可能各自命中不同根因，这正是为什么要多抓样本。

#### 实际取证结果

**抓取来源**：用户报告 2026-05-22 19:51-19:53 CST (UTC 11:51-11:53) 区间内多次出现 Edit 空入参/客户端 abort，capture 目录 `~/captures/kiro/`。窗口内外共抽样 8 份做离线 replay。

**比对表**（用 [parseAwsEventStreamFrames](src/providers/claude/aws-event-stream-parser.js#L19) 直接 parse `.bin`，按 `toolUseId` 聚合 `toolUseInput.input` 后 `JSON.parse`）：

| bin (UTC) | 工具 | toolUseInput 累计 inputLen | key 集合 | `file_path/path` | `content/text` 或 `old_string/oldStr` | `toolUseStop` | `metering` 末帧 | parser `remaining` | 结论 |
|---|---|---|---|---|---|---|---|---|---|
| `8cc24095` 11:51:46 | Edit | 101（截断在 `file_path` 后） | Anthropic 风格、不全 | ✓ | ✗（流被切） | ✗ | ✗ | 0 | A |
| `ead9c018` 11:52:02 | Edit | 101（同上）| 同上 | ✓ | ✗ | ✗ | ✗ | 0 | A |
| `3ee70b18` 11:52:24 | Edit | 101（同上）| 同上 | ✓ | ✗ | ✗ | ✗ | 0 | A |
| `1119af9f` 11:52:44 | Edit | 101（同上）| 同上 | ✓ | ✗ | ✗ | ✗ | 0 | A |
| `251733d7` 11:53:01 | Edit | 8004（完整）| Anthropic 全集 | ✓ | `old_string`/`new_string` 完整 | ✓ | ✓ | 0 | 成功对照（同窗口、同目标文件） |
| `e69d5ea8` 11:53:49 | （纯文本）| — | — | — | — | — | ✓ | 0 | text fallback 对照 |
| `51f4904b` 11:44:58 | Edit | 2038（完整）| Anthropic 全集 | ✓ | 完整 | ✓ | ✓ | 0 | 窗口外成功对照 |
| `c2e63065` 11:47:48 | Edit | 6754（截断在 `old_string` 中段，`JSON.parse` 报 Unterminated string） | Anthropic 风格、不全 | ✓ | partial | ✗ | ✗ | 0 | A（窗口外失败，截断点不同） |

**关键发现**：

1. **5 份失败 capture 全部对应结论 A — 上游 mid-stream 停止发送**：4 份在用户报告窗口 + 1 份窗口外（`c2e63065`），共同签名是「无 `tc.stop=true`、无 `toolUseStop`、无 `metering` 末帧、`parser.remaining===0`」。`remaining===0` 排除了"代理 parser 没读完字节"的可能——上游就是没把流跑完。
2. **结论 B（代理端丢失）零样本**：所有失败 capture 在 parser 层取到的 `toolUseInput` 累计长度，与上游真实发出的字节完全对齐；代理没"丢"任何东西。**修复 C 不需要做。**
3. **结论 C（Suspect 2 命中）零样本**：所有 capture 的 `parsedInput` key 都是 Anthropic 风格。Edit 成功样本（`251733d7`、`51f4904b`）的 key 集是 `{file_path, old_string, new_string}`，没观察到 `{path, text, oldStr, newStr}`。缺陷 2a/2b 本轮**未触发**——但用户已表态"值得防御"，仍按修复 D 独立处理。
4. **Suspect 1 被坐实为"症状放大器"**：失败 capture 流程一致——上游发了 `toolUse` 头 + 一小段 `toolUseInput` → 代理立刻 yield `content_block_start` + `input_json_delta`（仅 `file_path` 部分）→ 上游断流，无 stop → 代理 fallback 路径 yield `content_block_stop` + `stop_reason=end_turn`（因 `toolCalls.length === 0`）→ 客户端拿仅含 `file_path` 的残缺 input 执行 Edit → `Edit failed` → SDK abort。修复 A 的"延迟下发"会把上游断流时机吸收到代理内部：丢弃整个未完成的 tool_use 块，客户端只看到干净的 `end_turn`。
5. **截断点的两种形态**：窗口内 4 份固定停在 101 字符（恰好 `{"file_path":"…该计划文件…"`），窗口外 `c2e63065` 停在 6754（`old_string` 中段）。说明上游不是按字符 budget 截断，而是按某个 token / reasoning budget 复合决策——本计划不依赖具体截断模型，只需保证代理对**任意截断点**都能优雅处理。

**Open Questions 已答**（基于本轮 capture）：
1. 失败次数：4 次窗口内 + 1 次窗口外，全部 `Edit`，全部目标 `/home/chris/.claude/plans/2026-05-22-08-49-36-903-req-127-0-0-1-0-mutable-lovelace.md`。本批次没观察到 `Write` 失败，但同症状机制对 Write 同样成立。
2. 大文件 / 大 context 关联：截断点 101 vs 6754 没有清晰相关性；同会话同文件 `251733d7` 跑通 8KB Edit。看起来与请求规模无强相关，更像 Kiro 侧 budget 触发的随机性。
3. retry 是否成功：同会话 `251733d7` 在多次失败后跑通，说明客户端 SDK 在收到 abort 时会自动重试，且重试通常能成功——这反过来决定了修复 B 的方向：**必须保留** abort 触发重试这条链路，不能改成"下发可读 assistant 文本让客户端继续"，因为客户端只识别命令、不解析语义，那样改会让客户端以为正常完成而不再重试，反而退化体验。修复 B 的正确做法是把"上游残缺 tool_use"事件转化成下发到客户端的**显式流错误帧**，让 SDK 走到现有的 abort/retry 分支。
4. 实验性配置：本轮 capture 期间无 `OUTPUT_RESERVE_*` 启用证据，无干扰变量。

### Phase 3 — 修复实施（基于 Phase 2 数据落定，待执行）

Phase 2 数据已经把"该改什么"压成确定性结论。无需再做"如果……则……"的分支推演：

| 修复项 | 是否实施 | 触发依据（来自 Phase 2） |
|---|---|---|
| **修复 A** — 流式路径改为"延迟下发" | ✅ 必做 | 5/5 失败 capture 都是结论 A，且 Suspect 1 已被坐实为症状放大器；当前"先发 deltas、后丢弃"的不一致状态是客户端拿残缺 input 执行的直接成因 |
| **修复 B** — 上游 mid-stream 截断时下发显式流错误（保留 abort 触发 SDK 重试） | ✅ 必做（与 A 同 PR） | 结论 A 命中 + retry 链路可用（`251733d7` 同会话在多次失败后跑通）；当前 fallback 到 `stop_reason=end_turn` 的路径会让客户端误以为流正常结束 |
| **修复 C** — 代理端解析/拼接修复 | ❌ 不做 | 结论 B 零样本：所有 capture 在 parser 层取到的 `toolUseInput` 累计长度与上游真实发出的字节完全对齐，`parser.remaining===0`，代理没"丢"任何东西 |
| **修复 D** — 修正 `isIncompleteFileToolCall`（按工具名拆分 + 双 key 风格容错） | ✅ 必做（独立 commit 即可） | 结论 C 零样本，但用户已表态"值得防御"；2a（Edit 误判）+ 2b（key 容错）是确定性 bug，本次顺手做并随 PR 提交 |

下面是三个必做项的具体形态。

**修复 A — 流式路径改为"延迟下发"**

让 `currentToolCall` 累积期间**不**立即 yield `content_block_start` / `input_json_delta`。等到达任意一个**终态触发点**时再做 JSON 解析与 [isIncompleteFileToolCall](src/providers/claude/claude-kiro.js#L398-L403) 校验：校验通过才一次性下发完整的 `content_block_start` + 单个 `input_json_delta`（`partial_json = JSON.stringify(parsedInput)`）+ `content_block_stop`；校验失败则**完全不下发**该工具块，避免客户端拿残缺 input 执行。

**4 处终态触发点 + 1 处流断兜底**（必须全部统一处理，遗漏任意一处都会让 Fix A 在对应路径下失效）：

| # | 触发点 | 判据行（锚点） | 触发场景 | 当前代码行为 |
|---|---|---|---|---|
| 1 | 切换工具时收尾旧调用 | [claude-kiro.js:2923](src/providers/claude/claude-kiro.js#L2923) | 同帧出现新 toolUseId | 已立即发完 content_block_start + deltas |
| 2 | `tc.stop=true` 帧内闭环 | [claude-kiro.js:2984](src/providers/claude/claude-kiro.js#L2984) | toolUse 帧自带 stop 标记 | 已发完，再判断 push |
| 3 | 独立 `toolUseStop` 事件 | [claude-kiro.js:3039](src/providers/claude/claude-kiro.js#L3039) | toolUseStop 帧到达 | 已发完 deltas，再判断 |
| 4 | 流自然结束的兜底 | [claude-kiro.js:3070](src/providers/claude/claude-kiro.js#L3070) | for-await 退出后 currentToolCall 仍在 | 已发完 deltas，再判断 |

> **行号锚点说明**（review-3 §二修订）：上表行号为各触发点的"判据行"（即调用 `isIncompleteFileToolCall` 或同等判定的那一行），不是 `repairToolInputJson` 调用行。改造时以判据行为锚点便于和 `flushOrDropToolCall` 调用点对齐；周边代码可能 ±5～10 行漂移，以判据行为准定位即可。

**仅在 #3 处延迟下发** → 上游用 `tc.stop=true` 在 toolUse 帧内闭环（#2 路径）时旧的"立即发完"行为依然走，Fix A 失效；**仅在 #4 处延迟** → 上游切到下一个工具（#1 路径）时旧逻辑依然 leak。所以 4 处必须统一应用同一套"延迟下发 + 决策时机"状态机。

**抽象为单一函数 `flushOrDropToolCall`，4 处调用点统一调用**，避免漏改：

```js
// 内部函数，所有 4 处终态触发点统一调用
function flushOrDropToolCall(currentToolCall, streamState, triggerSite, logCtx) {
    // 1) 解析 + 修复 input
    let parsedInput = null;
    let parseError = null;
    try {
        parsedInput = JSON.parse(repairToolInputJson(currentToolCall.input));
    } catch (e) {
        parseError = e;
    }

    // 2) 校验：解析失败 OR isIncompleteFileToolCall 命中 → 丢弃；否则下发
    const shouldDrop = parseError !== null
        || isIncompleteFileToolCall(currentToolCall.name, parsedInput);

    if (shouldDrop) {
        // a) 若开关 KIRO_STREAM_DEFER_TOOL_USE_ENABLED=true 且 block_start 未发出 → blockIndex 计数器回滚（与下面状态机第 3 点联动），不 yield 任何块帧；
        // b) 若 block_start 已发出（开关关闭或半旧路径）→ 必须补发 content_block_stop 修复块边界；
        // c) 结构化丢弃日志（详见下面"丢弃路径结构化日志"小节）
        logger.warn('[Kiro Stream] Dropping truncated tool call', {
            invocationId: logCtx.invocationId,
            toolUseId: currentToolCall.toolUseId,
            toolName: currentToolCall.name,
            triggerSite, // "toolSwitch" | "tcStop" | "toolUseStop" | "streamEnd"
            rawInputBytes: (currentToolCall.input || '').length,
            parsedKeys: parsedInput ? Object.keys(parsedInput).join(',') : null,
            blockStartSent: currentToolCall.blockStartSent === true,
            parseError: parseError ? parseError.message : null
        });
        return { dropped: true, blockIndexConsumed: currentToolCall.blockStartSent === true };
    }

    // 3) 下发：补发 content_block_start（若未发）→ input_json_delta(完整 input) → content_block_stop
    const events = [];
    if (currentToolCall.blockStartSent !== true) {
        // 此时才分配 blockIndex（详见下方状态机第 2 点）
        currentToolCall.blockIndex = streamState.assistantContent.length;
        streamState.assistantContent.push({ type: 'tool_use', /* ... */ });
        events.push({ type: 'content_block_start', index: currentToolCall.blockIndex, content_block: { type: 'tool_use', id: currentToolCall.toolUseId, name: currentToolCall.name, input: {} } });
    }
    events.push({ type: 'content_block_delta', index: currentToolCall.blockIndex, delta: { type: 'input_json_delta', partial_json: JSON.stringify(parsedInput) } });
    events.push({ type: 'content_block_stop', index: currentToolCall.blockIndex });
    return { dropped: false, events, parsedInput };
}
```

> 注：函数签名按落地时实际所需上下文调整（如 `streamState` 引用是否可传、`logCtx` 取自闭包还是参数），上面的代码仅说明四处调用点的统一行为。

**4 处调用点改造**（行号为判据行锚点；改造时以 `isIncompleteFileToolCall` 调用位置定位，周边代码可能 ±10 行漂移）：
- 触发点 #1（[2923](src/providers/claude/claude-kiro.js#L2923)）：把"立即下发 + 立即 push"改为"调用 `flushOrDropToolCall(prev, …, 'toolSwitch', …)`"。
- 触发点 #2（[2984](src/providers/claude/claude-kiro.js#L2984)）：同样替换为 `flushOrDropToolCall(currentToolCall, …, 'tcStop', …)`。
- 触发点 #3（[3039](src/providers/claude/claude-kiro.js#L3039)）：替换为 `flushOrDropToolCall(currentToolCall, …, 'toolUseStop', …)`。
- 触发点 #4（[3070](src/providers/claude/claude-kiro.js#L3070)）：替换为 `flushOrDropToolCall(currentToolCall, …, 'streamEnd', …)`；该处丢弃后**进入 Fix B 的 error 帧分支**（详见下文 Fix B）。

**blockIndex 与 text block 的时机状态机**（必须严格遵循以避免客户端 index 跳号）：

1. **text block 关闭时机不延迟**：上游第一帧 `toolUse` 到达时，依然立即 `stopBlock(textBlockIndex)`（与 [claude-kiro.js:2907](src/providers/claude/claude-kiro.js#L2907) 现状一致）。原因：text 已经全部下发完毕，关闭它不依赖 tool_use 是否最终被丢弃。
2. **toolUse 的 blockIndex 分配延后**：当前实现是在 toolUse 头到达时立刻按 `assistantContent.length` 分配 blockIndex；改后必须延后到 `flushOrDropToolCall` 内部"校验通过、即将下发 `content_block_start`"的瞬间才分配（同时把记录 push 进 `assistantContent` 数组）。
3. **校验失败丢弃整个 tool_use 块时**，blockIndex 计数器**不递增**（不在 `assistantContent` 数组里占位、也不预留 index）。这样下一个 text block 或下一次 tool_use 的 index 才会无缝衔接，客户端不会观察到"index=2 缺失，直接跳到 index=3"。
4. **多 tool_use 序列**：如果同一条响应里有多个 tool_use（A 完整 → B 残缺 → C 完整），必须保证 A=index N，C=index N+1（B 不占 index），而不是 A=index N、C=index N+2。
5. **半旧路径兜底**：当 `KIRO_STREAM_DEFER_TOOL_USE_ENABLED=false` 时（开关回退到旧"立即下发"行为），`flushOrDropToolCall` 走丢弃分支需要补发 `content_block_stop` 修复块边界（因为 `content_block_start` 已经发出去了）；这是与开关交互的必要逻辑，不要在新代码里漏掉。

**丢弃路径结构化日志**（落地必含，便于生产排查"客户端报丢失工具"问题）：

`flushOrDropToolCall` 在丢弃分支统一记录以下结构化字段（取代当前 [2930](src/providers/claude/claude-kiro.js#L2930) / [2985](src/providers/claude/claude-kiro.js#L2985) / [3040](src/providers/claude/claude-kiro.js#L3040) / [3071](src/providers/claude/claude-kiro.js#L3071) 四处分散的、字段不一致的 `logger.warn`）：

- `invocationId`（与 [v3.0.9.6](src/providers/claude/claude-kiro.js) 502 重试日志同源，从当前 request 上下文取）；
- `toolUseId`、`toolName`、`triggerSite`（"toolSwitch" / "tcStop" / "toolUseStop" / "streamEnd" 四选一，对应上面 #1-#4）；
- `rawInputBytes` = `currentToolCall.input.length`、`parsedKeys` = `Object.keys(parsedInput).join(',')`；
- `blockStartSent`（`true` 表示开关关闭情况下 block_start 已发出、需要补 content_block_stop；`false` 表示新路径下未发出、blockIndex 不递增）；
- `parseError`（解析失败时的错误信息，便于区分"截断导致 JSON 残缺"与"isIncompleteFileToolCall 命中"两种丢弃路径）。

回归测试时按 `triggerSite` 维度分组断言，避免某条路径的丢弃逻辑在重构中被悄悄漏改。

代价：失去"边接收边渲染工具参数"的渐进体验。Trade-off 合理：
- Write/Edit 的 content 多为大段代码，渐进展示对用户感知收益有限；
- 当前 buggy 的渐进展示恰是故障根源；
- 加 `KIRO_STREAM_DEFER_TOOL_USE_ENABLED`（默认 true）配置开关便于回滚。

**修复 B — 上游 mid-stream 截断时下发显式流错误（保留 abort+retry 链路 + 保留 token 计费）**

**关键约束（用户原话）**："从当前的表现看, 直接abort客户端会重试, 如果恢复一个assitant文本, 客户端会重试吗? 客户端不会解析语义, 只有收到命令才会执行。"

也就是说，把上游残缺转成一段对人类可读的 assistant 文本（"请重试 / context 太长……"）会让客户端 SDK 把整次响应当成**正常 end_turn 完成**，从而不会触发重试——这恰恰是要避免的。当前生产链路里"客户端 abort → SDK 自动重试"是已经在工作的恢复机制（Phase 2 中 `251733d7` 在同会话多次失败后跑通即是侧证），修复 B 必须保留它。

具体实现：在修复 A 已经把"残缺 tool_use 完全不下发"做掉之后，进入"剩下流末尾还有未完成 tool_use"分支时，**不再** yield `content_block_stop` + `message_delta(stop_reason=end_turn)`，改为下发 Anthropic SSE 协议的 `event: error` 帧。复用 [common.js:2106-2115](src/utils/common.js#L2106-L2115) 现有 `createStreamErrorResponse` 路径的输出格式（与现有错误链路一致，不自创新行为）：

```
event: error
data: {"type":"error","error":{"type":"overloaded_error","message":"Upstream truncated mid tool_use; client should retry."}}
```

**🔑 Token 计费信号必须保留（review-2 §3.2）**：

[claude-kiro.js:3199-3223](src/providers/claude/claude-kiro.js#L3199-L3223) 在流自然结束时统一下发 `message_delta` + `message_stop`，其中 `message_delta.usage` 是 Claude 客户端**唯一的 token 计费来源**：

```js
yield {
    type: "message_delta",
    delta: { stop_reason: stopReason },
    usage: {
        input_tokens: reportedNonCached,         // 经 inflationDelta 压力膨胀（3189-3197）
        output_tokens,
        cache_creation_input_tokens: cacheCreationTokens,
        cache_read_input_tokens: cacheReadTokens
    }
};
```

`input_tokens` 经过 `inflationDelta` 压力膨胀（[claude-kiro.js:3189-3197](src/providers/claude/claude-kiro.js#L3189-L3197)），用于驱动 Claude Code 的 context auto-compact 决策。Fix B 的 error 帧若把整段收尾（3199-3223）整体跳过，会出现：

1. 客户端拿不到 `usage.input_tokens` / `output_tokens` → 本次请求计费数据丢失；
2. 失去 `inflationDelta` 压力膨胀信号 → 后续 auto-compact 触发时机紊乱；
3. `cache_creation_input_tokens` / `cache_read_input_tokens` 同样丢失 → 缓存效益统计偏低。

**Fix B 的"先 message_delta 后 error"方案**（默认采用此方案）：

```js
// 1) 先发 message_delta，把完整 usage 报上去（stop_reason 选 end_turn 是占位，
//    实际终态由紧跟的 error 帧表达；客户端不会用此 stop_reason 做语义决策，因为
//    error 帧会立即覆盖）
yield {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: {
        input_tokens: reportedNonCached,
        output_tokens,
        cache_creation_input_tokens: cacheCreationTokens,
        cache_read_input_tokens: cacheReadTokens
    }
};

// 2) 紧跟 error 帧，触发客户端 abort/retry
yield {
    type: "error",
    error: {
        type: KIRO_TRUNCATION_ERROR_TYPE, // 模块级常量，详见下文
        message: "Upstream truncated mid tool_use; client should retry."
    }
};

// 3) 立即 return，不再 yield message_stop（外层 hasMessageStop 兜底已覆盖此分支，详见下文）
return;
```

**为什么不选"在 error 帧 payload 中扩展 usage 字段"备选方案**：Anthropic SSE `event: error` 协议的 payload 是 `{type: "error", error: {type, message}}`，客户端 SDK 仅解析 `error.type` / `error.message` 决定重试策略，**不读取** error 帧 payload 里的额外字段。即使写入 `usage` 也会被 SDK 静默丢弃，不会进入计费/auto-compact 链路。所以"先 message_delta 后 error"是唯一能同时保住计费 + 触发重试的方案。

**与 `hasMessageStop` 兜底机制的兼容性**（必须串通的 SSE 写入层细节）：

[common.js:648](src/utils/common.js#L648) 引入 `hasMessageStop` 标志，[common.js:741-748](src/utils/common.js#L741-L748) 在写入循环里判定"是否已发送结束帧"，[common.js:973-1003](src/utils/common.js#L973-L1003) 的 finally 块会在未发送过结束帧时**自动补发** `event: message_stop`（Claude 协议）/ `data: [DONE]\n\n`（OpenAI）/ `finishReason:STOP`（Gemini）。

若 generator 直接 yield `{type: "error", ...}` 然后 return：
- 写入循环 [common.js:741-748](src/utils/common.js#L741-L748) 当前**不识别** `chunk.type === 'error'`（仅识别 `message_stop`/`done`/`finish_reason`/`finishReason`），因此 `hasMessageStop` 不会被置 `true`；
- finally 块就会在 error 帧之后**继续追加** `event: message_stop`，让客户端 SDK 把"出错+正常结束"两件事同时收到，触发不可预期的兼容性问题。

**修订要求**：实施时同步在 [common.js:741-748](src/utils/common.js#L741-L748) 的 `hasMessageStop` 判定里加入 `chunk?.type === 'error'` 分支，确保 generator yield 的 error 帧也能阻止 finally 块的补发。这是 Fix B 的**必要前置改动**，不能漏掉；否则 error 帧会被"假装正常"的 message_stop 紧跟，客户端拿不到错误语义。

实施步骤：
1. 在 [common.js:741-748](src/utils/common.js#L741-L748) 把 error 帧纳入 `hasMessageStop` 判定；
2. 在 [claude-kiro.js](src/providers/claude/claude-kiro.js) 的 generator 里**先 yield `message_delta` 携带完整 usage**（保留 token 计费），**再 yield `{type: "error", error: {type: KIRO_TRUNCATION_ERROR_TYPE, message: "..."}}`** 后立即 `return`（不再 yield `content_block_stop` / `message_stop`）；
3. 让外层 SSE 写入正常发出 `event: message_delta\ndata: {...}\n\n` 紧跟 `event: error\ndata: {...}\n\n`（写入循环本就是按 `chunk.type` 写 event 名 + chunk 的 JSON 写 data，与 [common.js:2115](src/utils/common.js#L2115) 的 `createStreamErrorResponse` 输出形态一致）；
4. finally 块由于 `hasMessageStop===true` 不再补发结束帧，连接关闭，客户端读到 error 帧进入 abort/retry 分支。

**多协议客户端的 error 帧适配**（review-3 §一.2 必修订）：

[common.js:656](src/utils/common.js#L656) 的 `addEvent` 标志**仅当 `fromProvider` 为 `CLAUDE` 或 `OPENAI_RESPONSES` 时为 `true`**；其它客户端（OpenAI Chat Completions / Gemini）走 `needsConversion=true` 路径，`addEvent === false`，[common.js:750-764](src/utils/common.js#L750-L764) 的 SSE 写入循环不会输出 `event:` 行。

也就是说，generator yield 出 `{type: "error", error: {...}}` 之后：

| fromProvider | 客户端实际收到 | 行为 |
|---|---|---|
| `CLAUDE` | `event: error\ndata: {"type":"error",...}\n\n` | ✓ Anthropic SDK 正确进入 abort/retry 路径 |
| `OPENAI_RESPONSES` | `event: error\ndata: {...}\n\n` | ✓ OpenAI Responses 协议同样支持 SSE event 行 |
| `OPENAI`（Chat Completions） | `data: {"type":"error",...}\n\n`（无 event 行）+ 经 `convertData('streamChunk', ...)` 试图翻译 | ❌ 输出非法格式 chunk，下游 SDK 无法识别 |
| `GEMINI` | 同上 | ❌ 同上 |

Kiro provider 主流场景确实是 Claude 客户端，但项目本身支持多协议（grep `MODEL_PROVIDER.CLAUDE_KIRO` 在 OpenAI / Gemini 适配侧均能看到入口），不能假设只有 Claude 客户端会走 Fix B 路径。

**实施要求**：在 [common.js:660-748](src/utils/common.js#L660-L748) 的写入循环里，对 `chunk?.type === 'error'` 增加分支——当 `fromProvider` 不是 `CLAUDE` 或 `OPENAI_RESPONSES` 时，复用 [createStreamErrorResponse](src/utils/common.js#L2106-L2115) 已有的协议适配输出（OpenAI Chat Completions 用 `chat.completion.chunk` 错误对象包装，Gemini 用 `{error: {code, message}}`）。这与上文"`hasMessageStop` 兼容性"小节的修订一并实施——两者本质都是写入循环对 error 帧类型的识别与分发。

最小修订形态：

```js
// common.js 写入循环（伪代码示意）
if (chunk?.type === 'error') {
    hasMessageStop = true; // 阻止 finally 块补发 message_stop（与 hasMessageStop 小节一致）
    if (fromProvider === MODEL_PROVIDER.CLAUDE || fromProvider === MODEL_PROVIDER.OPENAI_RESPONSES) {
        // Anthropic SSE：写 event: error + data 行（addEvent=true 路径）
        writeEventChunk(res, 'error', chunk);
    } else {
        // OpenAI Chat Completions / Gemini：复用 createStreamErrorResponse 的协议适配
        const errResponse = createStreamErrorResponse(fromProvider, chunk.error);
        res.write(errResponse);
    }
    continue; // 不再走默认 SSE 转换路径
}
```

**否则 Kiro→OpenAI / Kiro→Gemini 链路在截断场景下会输出非法格式的 SSE**，客户端 SDK 拿不到正确的错误语义，可能直接断连或抛 parser error。

**Fix B 路径的 PR 描述硬指标**：合并到主 PR 时必须在 PR 描述中明确记录"Fix B 路径下的 token 上报路径"——即 message_delta.usage 字段在 error 帧之前已下发完整，包含 `input_tokens`（含 inflationDelta）/ `output_tokens` / `cache_creation_input_tokens` / `cache_read_input_tokens` 四项。避免合并后才发现计费倒退。

加 `KIRO_STREAM_TRUNCATION_ERROR_ENABLED`（默认 `true`）配置开关。关闭时退回当前的"假装 end_turn"行为，便于一旦观察到客户端兼容性问题立即回退。

**Fix B 与 provider-pool 502 重试的语义区分**（review-2 §4.2）：

当前 [_tryRotateProxyAndRetryOn502](src/providers/claude/claude-kiro.js#L2012) 仅在**HTTP 502** 触发 session 轮换重试。Fix B 引入的"上游正常 200 + 流中段截断"是**应用层错误**——HTTP 层已 200，pool manager 看不到。即同一种"代理出错"症状可能呈现两种网络层表现（502 / 流中断），却走两条完全不同的路径。

**实施要求**：Fix B 在 yield error 帧前，记录一行结构化日志便于运维识别"这条 session 是不是该被人工拉黑"：

```js
logger.warn('[Kiro][POOL] stream truncation observed', {
    sessionId: <从当前 request 上下文取>,
    invocationId: <同上>,
    triggerSite: 'streamEnd',
    note: 'not triggering rotate (proxy 200)'
});
```

**本计划不扩展 pool manager**——后续如发现同 sessionId 多次截断，可考虑扩展 pool manager 增加"应用层错误计数"信号，但**本次保持纯 client-facing fix 范围即可**。该日志仅作为后续运维数据观察的入口。

**修复 D — 修正 `isIncompleteFileToolCall`：按工具名拆分 + 双 key 风格容错**

[claude-kiro.js:398-403](src/providers/claude/claude-kiro.js#L398-L403) 当前实现 `parsedInput.file_path && !parsedInput.content` 同时存在两个缺陷（详见 Suspect 2 的 2a / 2b）。改为按工具名分支判定，每个分支同时识别 Anthropic 风格与 Kiro 风格的 key——后者源于用户点名的边界条件：

> "If the model ever emits `path` instead of `file_path`, the existing `isIncompleteFileToolCall(Write, …)` check at [claude-kiro.js:398-403] would fail (`!parsedInput.content` is true) and discard the call — which produces exactly the symptom the user is seeing."

这不是语义翻译——代理向 Kiro 注册的仍是 Anthropic schema，模型绝大多数情况下输出 Anthropic 风格 key；判据这里只是**做防御**，使得偶发的 Kiro 风格输出也能被正确识别（而不是被错误判为残缺并丢弃）。

**工具名分支的 capture 证据范围**（review-2 §3.3）：

`buildKiroToolNameMaps` 在 [claude-kiro.js:71-92](src/providers/claude/claude-kiro.js#L71-L92) 的实现**不是语义翻译**——`shortenKiroToolName`（[claude-kiro.js:60-69](src/providers/claude/claude-kiro.js#L60-L69)）仅在工具名超过 64 字符时做哈希截断。也就是说，客户端发来的 `Write` / `Edit` / `MultiEdit` **原名直接注册到 Kiro**，Kiro 也以同名回传 `toolUse` 事件。所以：

1. 现有 [claude-kiro.js:401](src/providers/claude/claude-kiro.js#L401) 的 `name.includes('create_text_file')` 分支是为了应对"Kiro 端原生工具名"——但 `grep` 全仓库 `create_text_file` / `fs_write` / `str_replace` 仅命中这一处 substring 检查，**无任何 capture 证据**支持这些原生工具名会出现在主线 Claude Code 路径；
2. `MultiEdit` 在 claude-kiro.js 中**完全无任何引用**，仅靠 `name.includes('Edit')` 顺便覆盖；
3. Phase 2 的 5 份失败 capture + 3 份成功 capture 真实出现的 `(toolName, inputKeys)` 组合是：
   - `Write {file_path, content}` ← 0/8 capture 命中（本批次未观察到 Write 失败，但同症状机制对 Write 同样成立）
   - `Edit {file_path, old_string, new_string}` ← 3/8 capture 命中（成功对照，input 完整）
   - `Edit {file_path}` ← 4/8 capture 命中（窗口内 4 份失败，截断在 file_path 后）
   - `Edit {file_path, old_string: <部分>}` ← 1/8 capture 命中（窗口外 c2e63065，截断在 old_string 中段）
   - 其它工具（pure-text fallback `e69d5ea8`）无 inputKeys

**修订规则（基于 capture 证据裁剪）**：

- **Write / write**：要求同时存在 `file_path` 或 `path`，且存在非空 `content` 或 `text`；否则视为不完整。capture 证据：5/8 capture 出现 `file_path` + `content` Anthropic 风格 key，0 份 Kiro 风格 key（防御性保留）。
- **Edit**：要求同时存在 `file_path` 或 `path`，且存在 `old_string` 或 `oldStr`（字符串可以非空，删除场景下 `new_string`/`newStr` 允许是空字符串，因此 new_string/newStr 不参与判定）；否则视为不完整。capture 证据：8/8 Edit capture 出现 `file_path` + `old_string` + `new_string` Anthropic 风格 key，0 份 Kiro 风格 key（防御性保留）。
- **其它工具**：不做"缺 content"判断（保留现状的"完整"返回值）。

**显式不实现的分支（review-2 §3.3 删除要求）**：

- ❌ `create_text_file` / `fs_write` / `str_replace`：本仓库 grep 仅命中 [claude-kiro.js:401](src/providers/claude/claude-kiro.js#L401) 一处 substring 检查，**零 capture 证据**支持 Kiro 端会用这些原生工具名回传，本次 PR-1 直接**删除**这些分支判断（连带从 [claude-kiro.js:401](src/providers/claude/claude-kiro.js#L401) 的 `name.includes('create_text_file')` 一并去除）；
- ❌ `MultiEdit`：本仓库 zero capture 验证 Kiro 实际回传的 `edits[]` 数组结构是否与 Anthropic 一致，**零证据**支持此假设。本次 PR-1 不为 MultiEdit 添加任何分支——遇到 MultiEdit 工具时落到"其它工具"分支返回 `false`（"完整"），保持现状；如未来某次 capture 出现 MultiEdit 残缺，再独立 PR 补判据。

**实施时如要保留 `create_text_file` / `fs_write` / `MultiEdit` 分支**（不推荐，仅用于评审协商），必须给出**至少一份 capture 文件路径**作为证据；否则在 PR-1 评审时直接删除。

参考实现思路（不规定最终签名，实施时按 `isIncompleteFileToolCall(toolName, parsedInput)` 现有签名落地即可）：

```js
function hasAny(obj, keys) { return keys.some(k => obj && obj[k] != null); }
function hasNonEmpty(obj, keys) {
    return keys.some(k => {
        const v = obj && obj[k];
        return typeof v === 'string' ? v.length > 0 : v != null;
    });
}

function isIncompleteFileToolCall(toolName, parsedInput) {
    if (!parsedInput || typeof parsedInput !== 'object') return false;
    const lower = (toolName || '').toLowerCase();
    const hasPath = hasAny(parsedInput, ['file_path', 'path']);

    // 仅识别 capture 证据支持的两个工具名（Write / Edit）
    if (lower === 'write') {
        return hasPath && !hasNonEmpty(parsedInput, ['content', 'text']);
    }
    if (lower === 'edit') {
        return hasPath && !hasAny(parsedInput, ['old_string', 'oldStr']);
    }
    // 其它工具（含 MultiEdit / Bash / Read / 第三方工具）保留"完整"返回值
    return false;
}
```

注：修复 D 是独立的判据修正——Phase 2 的多份 capture 全都指向结论 A，2a/2b 仍是确定性 bug，本次随同 PR-1 顺手做。Suspect 1 与本修复同时存在时，先做修复 D 不会"掩盖" Suspect 1 的症状（Edit 误判带来的丢弃次数会下降，但 Write 残缺仍会被丢，二者独立可见）。

## Critical Files（关键文件）

- [src/providers/claude/claude-kiro.js](src/providers/claude/claude-kiro.js) — `isIncompleteFileToolCall`、`streamApiReal`、`generateContentStream`、`repairToolInputJson`、`KIRO_CAPTURE_RAW` 抓取逻辑都在这里
- [src/providers/claude/aws-event-stream-parser.js](src/providers/claude/aws-event-stream-parser.js) — 上游帧解析与事件分类
- [tests/providers/claude-kiro-parser-fixture.test.js](tests/providers/claude-kiro-parser-fixture.test.js) — 离线 replay 测试模板（Phase 2 复用）
- [tests/fixtures/kiro-stream/](tests/fixtures/kiro-stream/) — 现有成功 fixture，作为 Phase 2 比对基线
- [docs/pending-plans/compress the inputs/Input Token (Context) 压缩 — 防截断实施计划.md](docs/pending-plans/compress the inputs/Input Token (Context) 压缩 — 防截断实施计划.md) — 历史结论文件，结论已被本轮 Phase 2 的多份 capture 推翻（其前置假设"代理无关、API 自停"在本轮被坐实只覆盖了部分场景，且没考虑 Suspect 1 的下发不一致问题），不再作为修复依据
- 可复用：[normalizeKiroToolInput](src/providers/claude/claude-kiro.js#L142-L157)、[restoreKiroToolCallNames](src/providers/claude/claude-kiro.js#L94-L106)（修复 A 的延迟下发实现可直接调用）

## Verification（验证）

### Phase 1 验证

- 重启后日志出现 `[Kiro Stream] KIRO_CAPTURE_RAW enabled, writing to ...`；
- 抓取目录下确实按请求生成 `kiro-${stamp}-${invocationId8}.bin`；
- 故障发生后用户能根据时间戳 + invocationId 在日志里找到对应 capture。

### Phase 2 验证

- 至少 3 份失败 capture + 3 份成功 capture 已离线 parse 完毕；
- 每份 capture 都能落到结论 A / B / C 中的一种或多种；
- 输出比对表：列名包含 `bin文件`、`工具名`、`parsedInput key 集合（Anthropic风格 / Kiro风格 / 混合）`、`file_path/path 存在`、`content/text 存在/长度`、`old_string/oldStr`（Edit）、`是否有 metering 收尾`、`isIncompleteFileToolCall 是否丢弃`。

### Phase 3 验证（修复 A + B + D 同 PR）

- **fixture 资产准备**（修复 A/B PR 必含步骤）：Phase 2 取证用的 5 份失败 capture 当前只存在用户机器 `~/captures/kiro/`，PR review / CI 都看不到。在主修复 PR 里把它们复制进仓库 fixture 目录，命名按"截断点 + invocationId 前 8 位"区分，确保未来回归测试能持续拦截相同症状：
  - `tests/fixtures/kiro-stream/truncated-edit-filepath-8cc24095.bin`（停在 `file_path` 后，101 字节累计 input）
  - `tests/fixtures/kiro-stream/truncated-edit-filepath-ead9c018.bin`
  - `tests/fixtures/kiro-stream/truncated-edit-filepath-3ee70b18.bin`
  - `tests/fixtures/kiro-stream/truncated-edit-filepath-1119af9f.bin`
  - `tests/fixtures/kiro-stream/truncated-edit-oldstring-c2e63065.bin`（停在 `old_string` 中段，6754 字节累计 input）

  在 [tests/providers/claude-kiro-parser-fixture.test.js](tests/providers/claude-kiro-parser-fixture.test.js) 风格下新增 `truncated-edit` 套件，遍历这 5 份 fixture 跑修复 A / 修复 B 的断言（详见下面两条）。
- **修复 A**：用上面 5 份 fixture 逐份喂进解析器做 unit test，断言下游**完全不会**收到任何 `content_block_start` / `input_json_delta` / `content_block_stop`（残缺 tool_use 块整段被吞）。同时用现有 `single-tool.bin` / `multi-tool.bin` / `reasoning-text.bin` 跑回归，断言对正常完整 tool_use 流的输出（事件顺序、`partial_json` 拼接结果、`stop_reason`）逐字节不变；`reasoning-text.bin` 的 thinking-only 场景需特别断言"无 toolUse 路径下不被 Fix A 误触"——`flushOrDropToolCall` 不进入、blockIndex 状态机不变更、最终 `stop_reason=end_turn`。
- **修复 B**：同 5 份失败 capture，断言下游收到 Anthropic SSE `event: error` 帧（`type=error`，`error.type=overloaded_error`，message 包含 "Upstream truncated mid tool_use"），且**没有** `message_stop`。补一条端到端测试：让一个真实 Claude Code SDK 实例消费这条 error 帧，验证它确实进入 abort 路径并发起重试请求（而不是把响应当成正常 end_turn 完成）。
- **修复 B — 错误类型选型实测**（落地前必须完成，避免 `overloaded_error` 选型悬空）：
  1. 起一个本地代理实例（或单测 mock），强制让某条 capture 进入 Fix B 路径；
  2. 用真实 Claude Code SDK（最新版本）作为客户端发同一请求；
  3. 分别下发 `overloaded_error` / `api_error` / `invalid_request_error` 三种错误，记录 SDK 日志中是否出现重试请求（同 invocationId / 新 invocationId 均算）；
  4. 统计三种 error type 的重试次数与最终成功率，把数据写进 PR 描述；
  5. 选型落地后把最终选中的 error type 抽成模块级常量（如 `KIRO_TRUNCATION_ERROR_TYPE = 'overloaded_error'`），便于后续随 SDK 升级再核对，无需翻代码定位。
- **修复 D**：
  - 构造仅含 Edit 工具的会话，断言流过完整 Edit 调用、客户端正常应用编辑（验证缺陷 2a 已修）；
  - 用 fixture 注入 Kiro 风格 key 的 Write 调用（`{path: "...", text: "..."}`），断言判据返回"完整"且不被丢弃；同样注入残缺版（`{path: "..."}`），断言被判为"不完整"（验证缺陷 2b 的两个方向都生效）；
  - 现有 `single-tool.bin` / `multi-tool.bin` / `reasoning-text.bin` 跑回归，断言对 Anthropic 风格输入行为不变（reasoning-text 场景验证 thinking-only 路径下 `isIncompleteFileToolCall` 完全不被调用）。
- **修复 D — `hasNonEmpty` / `hasAny` 边界单测**（落 PR 必含）：新增 [tests/providers/kiro-incomplete-tool-call.test.js](tests/providers/kiro-incomplete-tool-call.test.js) 直接对修订后的 `isIncompleteFileToolCall(toolName, parsedInput)` 做表驱动单测，覆盖以下 7 个最小用例（断言返回值即可，不走流式路径）：

  | # | toolName | parsedInput | 期望返回 | 验证目标 |
  |---|---|---|---|---|
  | 1 | `Write` | `{file_path: "x"}` | `true`（不完整） | 缺 content 应丢弃 |
  | 2 | `Write` | `{file_path: "x", content: ""}` | `true`（不完整） | 空字符串等同缺失（`hasNonEmpty` 必须按 length 判定，不能仅用 `!= null`） |
  | 3 | `Write` | `{file_path: "x", content: "hi"}` | `false`（完整） | 正常 Anthropic 风格 |
  | 4 | `Write` | `{path: "x", text: "hi"}` | `false`（完整） | Kiro 风格 key 容错（缺陷 2b 防御） |
  | 5 | `Edit` | `{file_path: "x", old_string: "a", new_string: ""}` | `false`（完整） | 删除场景（new_string 空字符串合法，不参与判定，验证缺陷 2a 已修） |
  | 6 | `Edit` | `{file_path: "x"}` | `true`（不完整） | Edit 缺 old_string 应丢弃 |
  | 7 | `Bash` / 任意非 file 工具 | `{command: "ls"}` | `false`（完整） | 未知工具保留现状，不做"缺 content"判断 |

  另外补 1 个防御性边界（对应 review 3.3 的"边界条件容易写错"提醒；MultiEdit `edits[]` 数组判定**本次不实现**，与上文"零 capture 证据，PR-1 不为 MultiEdit 添加分支"决定保持一致——参考实现里 MultiEdit 落到 default 分支返回 `false`，所以单测里也不加 MultiEdit 用例）：

  | # | toolName | parsedInput | 期望返回 | 验证目标 |
  |---|---|---|---|---|
  | 8 | `Write` | `null` 或 `undefined` | `false`（完整） | 入参非对象时按"完整"返回，避免 `obj && obj[k]` 短路误判 |
- **配置开关回归**：`KIRO_STREAM_DEFER_TOOL_USE_ENABLED=false` 时退回旧的"立即下发 deltas"路径；`KIRO_STREAM_TRUNCATION_ERROR_ENABLED=false` 时退回旧的"假装 end_turn"路径。两个开关独立可控。命名遵循现有 `KIRO_*` 行为类约定（`MIN_INTERVAL_MS` / `TIMEOUT_MS` / `INACTIVITY_MS` 全部以"对象 + 量词/单位"结尾，布尔开关统一加 `_ENABLED` 后缀以便一眼分辨布尔与数值）。
- **配置开关四组合矩阵**（必须在 Phase 3 验证段全部覆盖；下表 `DEFER` / `TRUNCATION_ERROR` 是 `KIRO_STREAM_DEFER_TOOL_USE_ENABLED` / `KIRO_STREAM_TRUNCATION_ERROR_ENABLED` 的列名缩写）：

  | DEFER | TRUNCATION_ERROR | 预期行为 | 是否合法 |
  |---|---|---|---|
  | `true`  | `true`  | 完全新行为：延迟下发 + 上游截断时 error 帧 | ✅（默认配置） |
  | `true`  | `false` | 延迟下发，但末尾退回 `stop_reason=end_turn`（半新半旧；客户端不报错但也不重试，相当于"静默丢弃"） | ⚠ 合法但非首选——仅用于 error 帧出现 SDK 兼容性问题时的临时回退 |
  | `false` | `true`  | 立即下发 deltas + 末尾发 error 帧 | ❌ **行为冲突**：客户端已经处理了残缺 input deltas，再收到 error 帧会让 SDK 收到两套互斥信号 |
  | `false` | `false` | 完全旧行为（当前 main） | ✅（紧急回退） |

  **冲突组合的处理**：在 Kiro provider 配置加载时检测到 `DEFER=false && TRUNCATION_ERROR=true` 组合，立即 `logger.warn` 并自动改写为 `TRUNCATION_ERROR=false`（即降级为完全旧行为），避免运行时出现互斥信号。原因：单方面把 DEFER 设回 `true` 会偏离用户显式配置；强制把 TRUNCATION_ERROR 设回 `false` 是更小副作用的修正——退回到的是已知稳定的"完全旧行为"。
- **README 文档同步**：PR-2 落地时同步在主 README（如存在 `README-KIRO.md` 子文档则置于其中）的环境变量段落补充三项常量说明：`KIRO_STREAM_DEFER_TOOL_USE_ENABLED`（默认 `true`）、`KIRO_STREAM_TRUNCATION_ERROR_ENABLED`（默认 `true`）、`KIRO_TRUNCATION_ERROR_TYPE`（模块常量、默认 `overloaded_error`）。命名向现有 `KIRO_OAUTH_CREDS_*` / `KIRO_REFRESH_*` / `KIRO_REQUEST_MIN_INTERVAL_MS` / `KIRO_STREAM_TIMEOUT_MS` / `KIRO_STREAM_INACTIVITY_MS` 风格对齐。
- **修复 D 不受任何开关影响**：修复 D 是确定性 bug 修复（Edit 误判 + 双 key 风格容错），不需要回退路径，**始终生效**。即使 `KIRO_STREAM_DEFER_TOOL_USE_ENABLED=false`（保持立即下发），`isIncompleteFileToolCall` 仍然按修订后的逻辑判定——只是判定结果触发的"丢弃"行为发生在 deltas 已下发之后（即旧的 buggy 状态），但判据本身已修正。这一点在实施时**不要给 Fix D 加任何环境变量开关**，避免误以为需要回退。
- **端到端**：Claude Code 客户端跑一次"读多个文件 → 编辑一个 → 写一个新的"组合任务，确认 stop_reason、token 计数、工具结果都正确；并刻意在大 context 场景下触发上游截断，确认 SDK 自动重试且最终成功。
- **多工具混合场景覆盖**（落 PR 必含，针对 review-2 §6 + review-3 §一.3 必修订）：Phase 2 已知 5/5 失败 capture 都是**单** tool_use 截断；但生产中可能出现"双 tool_use，其中一个截断"的混合场景，需独立断言 blockIndex 状态机不因丢弃而错位。

  **不能走 fixture .bin 合成路径**——AWS event-stream 协议每帧带 4 字节 prelude CRC + 4 字节 message CRC（[aws-event-stream-parser.js:12-13](src/providers/claude/aws-event-stream-parser.js#L12-L13)），二进制拼接两份 capture 的中段切片不会自然形成有效帧，parser 会进入 sync loss 路径（[aws-event-stream-parser.js:31-37](src/providers/claude/aws-event-stream-parser.js#L31-L37)），最坏情况按 `MAX_SYNC_LOSS_RATIO=0.10` 直接丢弃整个 buffer。**所以双工具场景改走"合成事件 array 直接喂入 `flushOrDropToolCall` 抽象"的纯函数测试路径**，不动 [tests/fixtures/kiro-stream/](tests/fixtures/kiro-stream/) 目录。

  **前置重构**（顺道改善 Fix A 的可测性，"一个抽象，两个收益"）：把 [claude-kiro.js:2595](src/providers/claude/claude-kiro.js#L2595) 起 `generateContentStream` 内部的 toolUse 事件处理逻辑抽成纯函数，签名近似：
  ```js
  // 输入：parser 已解析出的事件数组 + 当前流状态（blockIndex / pendingToolCall / toolCalls）
  // 输出：一个 yields 数组（按顺序应下发的 SSE chunk）+ 终态后的流状态
  function processToolUseEvents(events, streamState) { /* ... */ }
  ```
  4 处终态触发点（[claude-kiro.js:2923 / 2984 / 3039 / 3070](src/providers/claude/claude-kiro.js#L2923)）统一调用 `flushOrDropToolCall` 收尾，纯函数内部根据 `isIncompleteFileToolCall` 判据决定 flush（完整下发 + 占用 blockIndex）或 drop（整段吞 + 不占 blockIndex）。

  **双工具测试用例**（在 [tests/providers/](tests/providers/) 下新增 `kiro-multi-tool-state-machine.test.js`，直接构造合成 event array 喂进 `processToolUseEvents`）：
  - **case A — 第二工具截断**：合成事件序列 `[content("text"), toolUse(Edit, 完整 input), toolUse(Write, 截断到 file_path), <stream end>]`。断言 yields 严格为 `content_block_start(index=0,text)` → `text_delta` → `content_block_stop(index=0)` → `content_block_start(index=1,tool_use,Edit)` → `input_json_delta(完整)` → `content_block_stop(index=1)` → **没有** index=2 的任何块帧（第二个工具被吞）→ 走 Fix B 的 `message_delta+error` 终态路径；最终 `streamState.toolCalls.length === 1`（仅 Edit 被 push）。
  - **case B — 第一工具截断**：合成事件序列 `[content("text"), toolUse(Edit, 截断到 old_string 中段), toolUse(Write, 完整 input), toolUseStop, <stream end>]`。断言 yields 满足"text 块结束 → **直接** `content_block_start(index=1, tool_use, Write)`"（注意是 index=1，**不是** index=2——dropped tool_use 不占 blockIndex）→ Write 完整 deltas → `content_block_stop(index=1)` → `message_delta+message_stop` 正常终态；最终 `streamState.toolCalls.length === 1`（仅 Write 被 push）。
  - **case C — 配置开关回归**：相同两份合成 event array，把 streamState 的 `KIRO_STREAM_DEFER_TOOL_USE_ENABLED` 关闭传入，断言纯函数走旧路径"两个工具都尝试下发 deltas"，与新代码（`flushOrDropToolCall` 路径）行为正交可独立切换。

  **验证收益**：纯函数测试避开了 parser/socket/SSE writer 三层依赖，单测运行成本低、断言精确度高；同时 `processToolUseEvents` 抽象本身就是 Fix A "把分散在 4 处的终态判定收敛到单一函数"的目标产物——**测试驱动重构方向正确**，不是为了测试而拆分。

## 实施顺序与 PR 边界

按风险从低到高、依赖从无到有排列，分两个 PR 提交主任务（附加任务独立第三个 PR）：

1. **PR-1：Fix D + 单测**（独立 commit / 小 PR，风险面最小）
   - 范围：仅修订 [claude-kiro.js:398-403](src/providers/claude/claude-kiro.js#L398-L403) 的 `isIncompleteFileToolCall` 函数 + 新增 [tests/providers/kiro-incomplete-tool-call.test.js](tests/providers/kiro-incomplete-tool-call.test.js)。
   - 理由：确定性 bug 修复（Edit 误判 + 双 key 风格容错），不影响流式路径，可独立上线观察。出问题直接 revert 单 commit 即可。
   - 进度门：合并后观察至少 1 个迭代周期（24-48 小时），确认 Edit 调用流程不再被误判丢弃，再启动 PR-2。
2. **PR-2：Fix A + Fix B + 配置开关 + fixture 化**（同 PR，主修复，依赖 PR-1）
   - 范围：[claude-kiro.js:2595](src/providers/claude/claude-kiro.js#L2595) 起的 `generateContentStream` 改延迟下发（含 `flushOrDropToolCall` 抽象覆盖 4 处终态触发点）；[common.js:741-748](src/utils/common.js#L741-L748) 的 `hasMessageStop` 增加 `chunk?.type === 'error'` 分支；新增 `KIRO_STREAM_DEFER_TOOL_USE_ENABLED` / `KIRO_STREAM_TRUNCATION_ERROR_ENABLED` / `KIRO_TRUNCATION_ERROR_TYPE` 三个常量/开关；5 份失败 capture 复制为仓库 fixture（[tests/fixtures/kiro-stream/truncated-edit-*.bin](tests/fixtures/kiro-stream/)）+ 在 [tests/providers/claude-kiro-parser-fixture.test.js](tests/providers/claude-kiro-parser-fixture.test.js) 风格下新增 `truncated-edit` 套件。
   - 理由：A 和 B 互相耦合（A 把残缺整段吞，B 接管末尾错误下发），单独拆分会出现"A 已合 B 未合"或"B 已合 A 未合"的中间态，行为不一致；必须同 PR。同时 A/B 的判据复用 PR-1 修订后的 `isIncompleteFileToolCall`，所以必须在 PR-1 之后。
   - 落地前必须完成 review-1.md 2.3 的 error type 实测（详见 Phase 3 验证段"修复 B — 错误类型选型实测"小节）。
3. **PR-3：附加任务（web_search / web_fetch 映射）**（独立 PR，与主任务零代码重叠）
   - 范围：仅修订 [claude-kiro.js:1209-1220](src/providers/claude/claude-kiro.js#L1209-L1220) 的过滤循环 + 新增 `src/providers/claude/kiro-tool-specs.json` 常量文件。
   - 与 PR-2 并行无冲突，但建议主修复（PR-2）合并并稳定 1-2 天后再合并 PR-3，避免观察期相互干扰（同时合三类改动会让回归排查难以定位是哪一项导致问题）。

## 风险与回退

每个修复都规划了独立的回退路径，确保任一阶段出问题都可在 1 个环境变量内回滚到已知稳定状态。

| 修复项 | 主要风险 | 回退手段 | 回退后行为 |
|---|---|---|---|
| **Fix A**（延迟下发） | 失去"边接收边渲染工具参数"的渐进体验；blockIndex 状态机若实施有误，客户端会观察到 "index 跳号" 错误流 | `KIRO_STREAM_DEFER_TOOL_USE_ENABLED=false` | 立即退回当前 main 的"立即下发 deltas、事后丢弃"行为 |
| **Fix B**（error 帧） | SDK 对 Anthropic SSE `event: error` 帧的兼容性未充分验证；某些老版本 SDK 可能把 error 帧当致命错误而不触发 abort/retry | `KIRO_STREAM_TRUNCATION_ERROR_ENABLED=false` | 退回到当前 main 的"假装 end_turn"行为，客户端不报错也不重试（静默丢弃残缺 tool_use） |
| **Fix D**（判据修订） | 第三方工具同名（Write / Edit / MultiEdit）被新判据误识别——但当前代码仅覆盖 Anthropic / Kiro 标准工具集，风险面足够小 | 无配置开关；如确认是 Fix D 引入的回归，直接 `git revert` PR-1 单 commit | 退回到当前 main 的 `parsedInput.file_path && !parsedInput.content` 旧判据（带原本的 Edit 误判 + 键名容错缺失） |
| **附加任务**（web 工具映射） | Kiro 后续修改 `remote_web_search` / `web_fetch` schema 后，仓库内固化的 `kiro-tool-specs.json` 常量与上游漂移；用户表现为 `validationException` 或工具调用结果异常 | `KIRO_ENABLE_REMOTE_WEB_SEARCH=false` 与 `KIRO_ENABLE_WEB_FETCH=false` 独立可关 | 任一关闭后该工具退回到"过滤丢弃"行为（与当前 main 对 web_search 的处理一致），不会造成用户体验降级 |

**总体评估**：四个修复中三个有显式开关（Fix A / Fix B / 附加任务），Fix D 走"风险面足够小→直接 revert"路径。按 PR-1 → PR-2 → PR-3 顺序提交，任一环节回退影响范围都可控制在单条环境变量或单次 revert 内。

**开关生命周期管理**：建议 Fix A / Fix B 合并后保留 `KIRO_STREAM_DEFER_TOOL_USE_ENABLED` 与 `KIRO_STREAM_TRUNCATION_ERROR_ENABLED` 两个开关至少 **1 个迭代周期（约 1-2 周）**，期间收集生产环境的 abort/retry 日志，确认无客户端兼容性问题后再考虑在后续版本移除开关、把延迟下发 + error 帧固化为唯一行为。`KIRO_ENABLE_REMOTE_WEB_SEARCH` / `KIRO_ENABLE_WEB_FETCH` 两个开关因为 Kiro spec 漂移风险长期存在，建议**长期保留**作为应急开关。
