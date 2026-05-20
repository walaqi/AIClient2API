# 下游流式响应不完整 — 全链路调研与修复计划 (v2,已采纳 review_1)

> **修订记录(v3)**:在 v2 基础上吸收 [review_2.md](../../projects/AIClient2API/docs/pending-plans/stream%20shorts/review_2.md):
> ① **M1 修正**:第 P0-2 代码示例笔误 `ofam` → `of stream`(评审 M1);
> ② N1 修正 Gemini 行号 1370-1371 → 1371-1372;
> ③ N2 跨协议映射验证清单补 unary 路径(ClaudeConverter.js:381-389、1253-1267);
> ④ N3 在验证段补 64K 报错分诊规则;
> ⑤ N5 控制事件改名 `__streamEnd` → `__kiroStreamEnd`,加未识别事件白名单兜底,加单测反向断言;
> ⑥ R1 backlog #1 提级标记 P1.5;
> ⑦ R2 单测明确用真实 fixture(选项 A);
> ⑧ 落地顺序补一步"收集真实 fixture"(P0-2/P0-3 落地后)。
>
> v2 修订记录(已并入):截断信号改"多源 OR";删除 outputTokens 60000 夹紧;axios 默认 300s + socket inactivity;P1-2 改为单一退出点;P2 单测提级到 P1。

## Context(调研背景)

何夕反馈:下游客户端(Claude Code)接收流式响应时**展示内容不完整**,偶发收到 `API Error: Server response exceeded the 64000 output token maximum. To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.` 本地 client 未设 max_tokens 限制。控制台已观察到:

```
[Kiro Stream] Raw stream ended with remaining buffer (2 bytes): ...
```

需判断截断发生在:① 上游 → 本项目解析阶段;② 本项目 → 下游 SSE 转发阶段;③ 上游 token 超 64K 触发客户端硬限。

---

## 全链路逐跳分析(以 Claude 客户端 → Kiro 上游 为主线)

### 第 1 跳:HTTP 入口接收下游请求

[src/handlers/request-handler.js:27-40](src/handlers/request-handler.js#L27-L40) `parseRequestBody` —— 流式读取 `req.on('data')`,UTF-8 拼接为字符串后 `JSON.parse`。这是入口侧,不影响响应链路。

请求继续到 [src/handlers/request-handler.js:49-55](src/handlers/request-handler.js#L49-L55) `createRequestHandler` → 鉴权 + 上下文 ID → `handleAPIRequests`。

### 第 2 跳:路由分发

[src/services/api-manager.js:72-75](src/services/api-manager.js#L72-L75) —— `/v1/messages` 命中 `ENDPOINT_TYPE.CLAUDE_MESSAGE`,调 `handleContentGenerationRequest`。

### 第 3 跳:构造请求体(关键:本项目会注入哪些额外内容)

[src/utils/common.js:1284-1443](src/utils/common.js#L1284-L1443) `handleContentGenerationRequest` 顺序执行:

1. `getRequestBody` 解析下游 JSON。
2. [L1308](src/utils/common.js#L1308) `_extractModelAndStreamInfo` 提取 `model` / `isStream`。
3. [L1315-1331](src/utils/common.js#L1315-L1331) **自定义模型映射**:重写 `model` / `MODEL_PROVIDER`。
4. [L1342-1362](src/utils/common.js#L1342-L1362) 号池/AUTO 兜底重选 service。
5. [L1366](src/utils/common.js#L1366) 浅拷贝 `originalRequestBody → processedRequestBody`(保留原始)。
6. [L1369-1376](src/utils/common.js#L1369-L1376) 注入内部字段 `_monitorRequestId` / `_requestBaseUrl`(在 service 入口被删除,[claude-kiro.js:2425-2432](src/providers/claude/claude-kiro.js#L2425-L2432))。
7. [L1379-1392](src/utils/common.js#L1379-L1392) 跨协议转换:Claude → Claude/Kiro **同协议时不转换**。
8. [L1401](src/utils/common.js#L1401) `_applySystemPromptFromFile` —— 若配 `SYSTEM_PROMPT_FILE_PATH`,会按 override/append 追加 system。
9. [L1402](src/utils/common.js#L1402) `_manageSystemPrompt` 按协议规范化 system 字段。
10. [L1408-1410](src/utils/common.js#L1408-L1410) **`_applyCustomModelParameters`**([L1484-1541](src/utils/common.js#L1484-L1541)) —— **若 `customConfig.maxTokens` 有值会写入 `requestBody.max_tokens`**,这是本项目唯一会主动注入上游 max_tokens 的位置。下游不传、自定义配置也没写时,max_tokens 不会被注入。
11. [L1424-1427](src/utils/common.js#L1424-L1427) 分发到 `handleStreamRequest` / `handleUnaryRequest`。

**结论**:除非配 `customConfig.maxTokens`,本项目不会主动给 Kiro 加 max_tokens 限制。

### 第 4 跳:流式分发器 `handleStreamRequest`

[src/utils/common.js:604-970](src/utils/common.js#L604-L970):

1. [L642-644](src/utils/common.js#L642-L644) 写 SSE 响应头。
2. [L654](src/utils/common.js#L654) `service.generateContentStream(model, requestBody)` 驱动上游流。
3. [L659-779](src/utils/common.js#L659-L779) `for await`:
   - 同协议直接用 `nativeChunk`,跨协议 [L674](src/utils/common.js#L674) `convertData(..., 'streamChunk', ...)`。
   - [L740-747](src/utils/common.js#L740-L747) 检测到 `message_stop / [DONE] / done / candidates[].finishReason` 设 `hasMessageStop = true`。
   - [L749-776](src/utils/common.js#L749-L776) Claude / OpenAI Responses 协议先写 `event:` 行,再写 `data:` 行 + 双换行。
4. [L932-957](src/utils/common.js#L932-L957) `finally` 兜底:若 `!hasMessageStop` 按客户端协议补 `message_stop` / `[DONE]` / Gemini `STOP` 后 `res.end()`。

**结论**:下游 SSE 写入逻辑健全。问题在上游侧把流"提前结束"了,但本项目把它当作 `end_turn` 正常完成。

### 第 5 跳:Kiro service `generateContentStream`

[src/providers/claude/claude-kiro.js:2422-2978](src/providers/claude/claude-kiro.js#L2422-L2978):

1. [L2425-2432](src/providers/claude/claude-kiro.js#L2425-L2432) 摘除内部字段。
2. [L2435-2438](src/providers/claude/claude-kiro.js#L2435-L2438) Token 即将过期则入刷新队列。
3. [L2548-2563](src/providers/claude/claude-kiro.js#L2548-L2563) `yield message_start`。
4. [L2566](src/providers/claude/claude-kiro.js#L2566) `for await (event of streamApiReal(...))` 真正向 Kiro 发请求并解析事件。
5. emit `content_block_start` / `_delta` / 工具事件等。
6. `for await` 自然结束后,[L2845-2898](src/providers/claude/claude-kiro.js#L2845-L2898) 收尾未完成块,[L2909](src/providers/claude/claude-kiro.js#L2909) 关闭文本块。
7. [L2960-2970](src/providers/claude/claude-kiro.js#L2960-L2970) `yield message_delta { stop_reason }`,[L2972](src/providers/claude/claude-kiro.js#L2972) `yield message_stop`。

**关键问题**:这里不知道流是"自然结束"还是"被切断",`stop_reason` 默认 `end_turn`。

### 第 6 跳:底层 axios 流 `streamApiReal`

[src/providers/claude/claude-kiro.js:2236-2408](src/providers/claude/claude-kiro.js#L2236-L2408):

1. [L2255](src/providers/claude/claude-kiro.js#L2255) `buildCodewhispererRequest` 构造 CodeWhisperer 请求体([L1043-1573](src/providers/claude/claude-kiro.js#L1043-L1573))。**不会主动加 max_tokens**。
2. [L2269-2278](src/providers/claude/claude-kiro.js#L2269-L2278) axios `responseType: 'stream'`,`AXIOS_TIMEOUT = 120000` ms([L40](src/providers/claude/claude-kiro.js#L40))。
3. [L2280-2319](src/providers/claude/claude-kiro.js#L2280-L2319) 主循环:
   ```js
   buffer += chunk.toString();           // 风险点:UTF-8 切边
   const { events, remaining } = this.parseAwsEventStreamBuffer(buffer);
   buffer = remaining;
   ```
4. [L2320-2323](src/providers/claude/claude-kiro.js#L2320-L2323) 循环结束时若 `buffer.length > 0`,**仅 warn,剩余字节被丢**(就是控制台那行)。

### 第 7 跳:AWS Event Stream 解析 `parseAwsEventStreamBuffer`

[src/providers/claude/claude-kiro.js:2092-2231](src/providers/claude/claude-kiro.js#L2092-L2231):

- 不解析二进制头部,只用括号计数找 `{...}` JSON。
- 解析失败 `searchStart++` 继续。
- 末尾未闭合 [L2140-2143](src/providers/claude/claude-kiro.js#L2140-L2143) `remaining = remaining.substring(jsonStart); break`。
- 兜底 [L2225-2228](src/providers/claude/claude-kiro.js#L2225-L2228) 在路径 B 已经把 `remaining` 重写过的情况下再 `substring(searchStart)`,**两次 substring 语义错乱**(评审 P1-2 指出的真实 bug)。

### 第 8 跳:下游 SSE → Claude Code 接收

第 4 跳已展开。Claude Code 客户端会**累计 `message_delta.usage.output_tokens` 与 `CLAUDE_CODE_MAX_OUTPUT_TOKENS`(默认 64000)比对,超阈值即抛错并终止接收**——这是 64K 报错的客户端侧源头,本项目控制不到客户端,但可控 token 估算。

---

## 根因(按可能性排序)

### 根因 A:上游流被截断,但本项目当作 `end_turn` 完成
第 6 跳 axios 超时 / 上游断流 / Sidecar 中断 → 第 5 跳循环退出 → 默认 `end_turn` → 下游不知情。控制台 "Raw stream ended with remaining buffer" 是这个场景的直接信号。

### 根因 B:`chunk.toString()` 默认 UTF-8 在 chunk 边界破坏多字节字符
[claude-kiro.js:2285](src/providers/claude/claude-kiro.js#L2285) `Buffer#toString('utf8')` 不维持跨 chunk 状态。中文/Emoji 切两半 → `U+FFFD`;切到 `\` 上 → JSON 解析失败被吞。

### 根因 C:`parseAwsEventStreamBuffer` 路径 B 下 `remaining` 二次切片
[claude-kiro.js:2140-2143 + 2225-2228](src/providers/claude/claude-kiro.js#L2140-L2143) —— 路径 B 中 `remaining` 已被重写,L2226 再 `substring(searchStart)` 用旧 searchStart 在新 remaining 上切,语义错乱、丢字节方向不确定。

### 根因 D:`output_tokens` 双计 → 触发 Claude Code 64K 硬限
[claude-kiro.js:2705-2707](src/providers/claude/claude-kiro.js#L2705-L2707) 工具调用的 `name + input` 已加进 `totalContent`;[claude-kiro.js:2929-2939](src/providers/claude/claude-kiro.js#L2929-L2939) 又用 `JSON.stringify(tc.input)` 加一遍。**工具 input 算两遍**。

### 根因 E:SSE 写入(无问题)
[utils/common.js:752-776, 932-957](src/utils/common.js#L752-L776) 双行格式正确 + 兜底 `message_stop`。

---

## 修复计划(v2,采纳评审)

### P0-1 截断信号传递到 stop_reason —— 改用多源 OR

**Action**:

1. `streamApiReal` 末尾收集多源 `truncated` 信号:
   - `buffer.length > 0`(decoder.end() 之后)
   - axios 抛错(进入 catch 但要重试无果时)
   - underlying socket `aborted` / `error` 事件
   任一即 `truncated = true`。
2. `streamApiReal` 在循环退出前 yield 一个 `{ type: '__kiroStreamEnd', truncated }` 内部控制事件(双下划线 + 项目名前缀,降低未来命名碰撞)。
3. `generateContentStream` 用 `wasTruncated` 局部变量收集,在事件 if/else 链顶部加白名单兜底,对未识别事件 `logger.debug(...)` 而不是静默吞:
   ```js
   if (event.type === '__kiroStreamEnd') { wasTruncated = event.truncated; continue; }
   // ... 已知事件 ...
   else { logger.debug('[Kiro Stream] Unknown event type:', event.type); }
   ```
4. 在 [L2961-2970](src/providers/claude/claude-kiro.js#L2961-L2970):
   ```js
   const stopReason = toolCalls.length > 0 ? 'tool_use'
                    : wasTruncated ? 'max_tokens'
                    : emittedOnlyThinking ? 'max_tokens'
                    : 'end_turn';
   ```
5. **跨协议映射核验**:见上方 N2 修订项。

> **不采用** "metering 必为收尾事件"——评审指出 metering 识别条件脆弱(根因/遗漏 2),且没有协议保证。已与作者确认采用多源 OR。
4. **跨协议映射核验**:确保 `stop_reason: 'max_tokens'` 在 Claude → OpenAI 走 `length`、Claude → Gemini 走 `MAX_TOKENS`。
   - **流式路径**:[ClaudeConverter.js:578-580](src/converters/strategies/ClaudeConverter.js#L578-L580) `max_tokens → length`;[ClaudeConverter.js:1371-1372](src/converters/strategies/ClaudeConverter.js#L1371-L1372) `max_tokens → MAX_TOKENS`。
   - **Unary 路径**:[ClaudeConverter.js:381-389](src/converters/strategies/ClaudeConverter.js#L381-L389)(Claude→OpenAI)、[ClaudeConverter.js:1253-1267](src/converters/strategies/ClaudeConverter.js#L1253-L1267)(Claude→Gemini)均已映射。**OK**,无需新增工作,但要写进验证清单。

> **不采用** "metering 必为收尾事件"——评审指出 metering 识别条件脆弱(根因/遗漏 2),且没有协议保证。已与作者确认采用多源 OR。

### P0-2 用 StringDecoder 安全解码 chunk —— ✅ 同意 + 补 finally

[claude-kiro.js:2280-2323](src/providers/claude/claude-kiro.js#L2280-L2323):

```js
import { StringDecoder } from 'string_decoder';
const decoder = new StringDecoder('utf8');
let buffer = '';
try {
    for await (const chunk of stream) { buffer += decoder.write(chunk); ... }
    buffer += decoder.end();             // 正常路径榨干
    // 截断判断在 end() 之后
} catch (e) {
    buffer += decoder.end();             // 异常路径也榨干,避免最后字节被吞
    throw e;
}
```

**补登记**:扫一遍 `grep -rn "chunk.toString" src/providers/`,其他 provider 若有同类问题作为 P1.5 在后续轮次清理(本轮不做)。

### P0-3 output_tokens 不再双计 —— ✅ 方案 B + 删 Math.min(60000)

[claude-kiro.js:2929-2939](src/providers/claude/claude-kiro.js#L2929-L2939):

- 保留 `totalContent` 累加(改动最小)。
- **删除** [L2937-2939](src/providers/claude/claude-kiro.js#L2937-L2939) 工具 input 二次累加。
- **不**加 `Math.min(outputTokens, 60000)`——评审指出会长期低估开销,作者确认删除。
- 防御性观测:`if (outputTokens > 60000) logger.warn('output_tokens=N exceeds Claude Code soft limit')`,**只观测不修改值**。

### P1-1 axios 超时可配置 —— 300s + socket inactivity(首字节后启用)

[claude-kiro.js:40](src/providers/claude/claude-kiro.js#L40):

- 默认改 `KIRO_AXIOS_TIMEOUT_MS = 300000`(5 分钟),从 `CONFIG.KIRO_AXIOS_TIMEOUT_MS` 读取覆盖。
- **首字节阶段**:走 axios 总 timeout(300s),**不启用** socket inactivity——避免 Kiro 冷启动 / 排队首字节延迟被误判为截断。
- **首字节到达后**:才调 `socket.setTimeout(KIRO_STREAM_INACTIVITY_MS)` 切到 inactivity 模式。默认 `KIRO_STREAM_INACTIVITY_MS = 60000`(60s,给长 reasoning 沉默留余量),可配置。
  ```js
  let firstByteSeen = false;
  for await (const chunk of stream) {
      if (!firstByteSeen) {
          firstByteSeen = true;
          response.data.socket.setTimeout(KIRO_STREAM_INACTIVITY_MS);
          response.data.socket.on('timeout', () =>
              response.data.destroy(new Error('socket inactivity')));
      }
      buffer += decoder.write(chunk);
      ...
  }
  ```
- **不暴露 0(无超时)** ——评审指出会因下游异常一起卡住并发池。
- socket inactivity 触发的 destroy 会让 `for await` 抛错,P0-1 的 axios catch 路径就能捕获并标记 `truncated`。

### P1-2 parseAwsEventStreamBuffer —— 改为单一退出点

[claude-kiro.js:2092-2231](src/providers/claude/claude-kiro.js#L2092-L2231) 重写:

```js
parseAwsEventStreamBuffer(buffer) {
    const events = [];
    let remaining = buffer;
    let searchStart = 0;
    while (true) {
        const jsonStart = remaining.indexOf('{', searchStart);
        if (jsonStart < 0) {
            return { events, remaining: remaining.substring(searchStart) };
        }
        // ... 括号计数 ...
        if (jsonEnd < 0) {
            return { events, remaining: remaining.substring(jsonStart) };  // 路径 B:未闭合
        }
        // 解析成功 / 失败两条路径
        searchStart = (parseSuccess ? jsonEnd + 1 : jsonStart + 1);
    }
}
```

**关键**:删除 [L2225-2228](src/providers/claude/claude-kiro.js#L2225-L2228) 的二次 `substring(searchStart)` 兜底,改成在每个出口 return 前显式构造 `remaining`。

### P1(原 P2)单元测试 —— 提级到 P1,与 P0 同步落地

新建 [tests/providers/claude-kiro-stream.test.js](tests/providers/claude-kiro-stream.test.js):

**Fixture 策略(评审 R2)**:**用真实 Kiro 响应抓段保存为 fixture**(选项 A),避免"测试用解析器自身正确"的循环依赖。Fixture 路径:[tests/fixtures/kiro-stream/long-response.bin](tests/fixtures/kiro-stream/long-response.bin)、[tests/fixtures/kiro-stream/tool-call.bin](tests/fixtures/kiro-stream/tool-call.bin)。test 时按字节切片读入,模拟 chunk 流。

**测试用例**:

1. **中文字符在 chunk 边界**:验 StringDecoder 修复(根因 B)。
2. **Emoji `🎉`(4 字节)切两半**:同上。
3. **JSON 解析失败导致 searchStart 推进 + 下一 chunk 让它变完整**:验 P1-2 真实场景。
4. **流"提前结束"且 buffer 残留**:验 P0-1 的 `wasTruncated` → `stop_reason: 'max_tokens'`。
5. **短回答正常完成**:验 `stop_reason: 'end_turn'` 不被误判。
6. **工具调用流**:验 `stop_reason: 'tool_use'` 不被影响 + output_tokens 不再双计。
7. **`__kiroStreamEnd` 不被作为 content 输出**(评审 N5 反向断言):验内部控制事件不会污染下游 SSE。

### 落地顺序(评审建议 + R2 fixture 步骤)

1. **P0-2(StringDecoder)+ P0-3(双计)** —— 改动小、隔离、收益明确。先发观察日志。
2. **收集真实 fixture**(评审建议补一步):发一版仅含 P0-2/P0-3 的版本到测试环境,顺手抓 1~2 段真实流响应保存为 fixture,供后续单测使用,顺便观察"双计修复"是否解决了大多数 64K 报错。
3. **P1-2(parseAwsEventStreamBuffer 单一退出点)** —— 代码清晰,顺手修真 bug。
4. **P1 单测**(此时被测代码已稳定,fixture 已就绪)。
5. **P0-1(多源 truncated)** —— 信号源选择最复杂,前几步稳定后看日志判断 truncated 的真实条件再实施。
6. **P1-1(超时 + socket inactivity)** —— 配置项变更,需文档同步。

---

## 评审登记的遗漏(本轮不修,backlog)

1. **客户端断开未传递到 service 侧** —— [utils/common.js:701-704](src/utils/common.js#L701-L704) `clientDisconnected` 仅 break,没向 service 发取消信号。**评审 R1 提级标记 P1.5**:P1-1 落地后 socket inactivity 60s 会让"客户端断开 → 服务端余 60s 才停止占用"现象更明显(原本是 axios 总超时 120s 自然终止),建议在 P1-1 之后立即跟进。建议方案:用 AbortController 关 service 侧 stream。
2. **metering 识别条件脆弱** —— [claude-kiro.js:2202-2207](src/providers/claude/claude-kiro.js#L2202-L2207) `parsed.unit !== undefined && parsed.usage !== undefined`。若 Kiro 给 toolUseStop 也加 unit 字段会被误识别。这也是反对 P0-1 用 metering 的另一理由。
3. **重复 content 过滤可能丢真实重复内容** —— [claude-kiro.js:2293-2299](src/providers/claude/claude-kiro.js#L2293-L2299) 用 `lastContentEvent === event.data` 跳过。用户原文里"哈哈哈"被切两个相同 chunk 会被吞一次。久存 bug,登记。

---

## 关键文件

| 文件 | 行 | 用途 |
|---|---|---|
| [src/providers/claude/claude-kiro.js](src/providers/claude/claude-kiro.js) | 2092-2231 | `parseAwsEventStreamBuffer` 单一退出点 |
| [src/providers/claude/claude-kiro.js](src/providers/claude/claude-kiro.js) | 2236-2408 | `streamApiReal` StringDecoder + 多源 truncated |
| [src/providers/claude/claude-kiro.js](src/providers/claude/claude-kiro.js) | 2422-2978 | `generateContentStream` stop_reason + output_tokens 双计 |
| [src/providers/claude/claude-kiro.js](src/providers/claude/claude-kiro.js) | 40 | `AXIOS_TIMEOUT` 改可配置 |
| [src/utils/common.js](src/utils/common.js) | 604-970 | `handleStreamRequest`(无需改) |
| tests/providers/claude-kiro-stream.test.js(新建) | — | P1 单测 |

可复用:Node 内置 `string_decoder`(无新依赖)。

---

## 验证

1. **P1 单测全部通过**(上述 7 个 case)。
2. **端到端**:
   - 用 Claude Code 触发长回答(>3000 tokens / 含工具)。控制台再出现 "Raw stream ended with remaining buffer" 时,下游应收 `stop_reason: max_tokens`,不再是 `end_turn`。
   - `curl -N` 直连 `/v1/messages` 看 SSE 流,确认每个 `event:` + `data:` 格式正确,结尾有 `message_stop`。
   - 跨协议下游(OpenAI / Gemini)发同款长回答,验 `stop_reason` 转换为 `length` / `MAX_TOKENS`。**流式**走 [ClaudeConverter.js:578, 1371](src/converters/strategies/ClaudeConverter.js#L578),**unary** 走 [ClaudeConverter.js:381, 1253](src/converters/strategies/ClaudeConverter.js#L381),四条路径都要覆盖。
3. **回归**:
   - 短回答仍 `end_turn`、工具调用仍 `tool_use`。
   - 修复 output_tokens 双计前后,含 1 个工具调用的回答应减少约 `JSON.stringify(input).length / 4` token。
   - socket inactivity(P1-1 默认 60s)触发后,日志能看到"被截断"且下游收到 `max_tokens`。
   - **首字节延迟测试**:模拟上游 45s 后才返回首字节,验证不会被误判为截断(N4)。

4. **64K 报错分诊规则(评审 N3)**:删 `Math.min(60000)` 后客户端 64K 硬限不会消失,运维侧分诊:
   - 看 `message_delta.usage.output_tokens` 实际值;
   - **若 ≤ 60K** 仍触发 → 估算偏不准,需进一步查 `countTextTokens` 系数;
   - **若 > 60K** → 上游真长输出,本项目无法消除,需要客户端侧调高 `CLAUDE_CODE_MAX_OUTPUT_TOKENS` 环境变量。

---

## 后续阶段(本轮新增)— 端到端压测 + Fixture 采集 + 日志可识别性

### Context(为什么)

P0/P1 全部落地并提交在 `e2a96be 3.0.5.6 测试截断事件处理` (2026-05-15 15:31)。但服务器现存日志 `~/log1.log`、`~/log2.log` 时间区间 **2026-05-14 00:27 → 2026-05-15 05:57**,**早于** 修复提交,因此里面**不包含**新埋点 `Detected truncation` / `Reporting stop_reason=max_tokens due to truncated`,只能见到旧的 `Raw stream ended with remaining buffer`(`log1` 250 条、`log2` 0 条)。

更根本的问题:**单次请求的关键信息散落在 ≥10 行不同 tag 的日志里**(`[Server]` / `[Kiro]` / `[Kiro Stream]` / `[Model Pricing]` / `[Provider Pool]` …),需要先抓 `Req:127.0.0.1:xxxxxxxx` 再 `grep -F` 才能拼凑出"这次有没有 truncated、stopReason 是什么、output_tokens 多少"。日志量大(~30K 行/11MB)时,人肉拼接成本高,自动化判定也难。

**目标**:让"修复是否生效"这件事能用 **一行 grep** 回答。

### S1 — 单行 STREAM_SUMMARY 埋点(优先做,小改动)

在 `generateContentStream` 的 message_delta yield **之前**([claude-kiro.js:2890-2898](src/providers/claude/claude-kiro.js#L2890-L2898) 附近)、以及 `streamApiReal` 异常退出 catch 末尾,各加一行结构化总结,字段顺序固定、key=value 用空格分隔,grep 友好:

```
[Kiro Stream] STREAM_SUMMARY model=claude-sonnet-4-6 stopReason=max_tokens truncated=true bufferRemain=4 socketAborted=false toolCalls=0 outTok=2347 visibleText=true thinkingOnly=false durMs=18742
```

**字段定义**:
- `stopReason`:最终选定的 `end_turn / tool_use / max_tokens` 之一。
- `truncated`:`wasTruncated` 局部变量值(`__kiroStreamEnd` 多源 OR 的结果)。
- `bufferRemain` / `socketAborted`:决定 `truncated` 的两条原始信号(便于事后定位是哪一路触发)。
- `outTok`:已计算的最终 `output_tokens`(P0-3 修复后值)。
- `durMs`:从 `streamApiReal` 进入到 yield 时的耗时,用于和 inactivity timeout 对比。

**好处**:
- 一条 `grep "STREAM_SUMMARY" ~/log.log | grep "stopReason=max_tokens"` 就能数本次部署有多少次截断事件。
- `awk '{...}'` / Loki / Vector 解析无需正则改动,字段稳定。

**注意**:既存 `Stream completed. hasVisibleText=...`(2838 行)信息丰富但**不含 stopReason / truncated**,且没有 `outTok`,所以 STREAM_SUMMARY 是补充而非替换,旧行保留以免破坏运维既有 grep 习惯。

### S2 — 端到端真实压测流程(发完 S1 之后做)

**前置**:服务器已在跑包含 S1 + e2a96be 修复的版本。

**触发长回答(目标 >3000 outTok 或包含工具)**:
- Claude Code 客户端环境变量:
  ```
  ANTHROPIC_BASE_URL=http://<server>:3010/claude-kiro-oauth
  ANTHROPIC_AUTH_TOKEN=<server 配置的 key>
  ANTHROPIC_CUSTOM_HEADERS="Authorization: Bearer x"   # 旁路客户端 OAuth check
  ```
- 提示语建议:"逐字翻译以下 4000 字英文小说节选并加段落注释"(强制长输出 + 可能触发上游 token cap)。
- 工具调用场景:让 Claude Code 跑一段会触发 ≥3 次 Bash/Read 的任务。

**判定矩阵(grep S1 埋点)**:

| 场景 | 期望 | 失败现象 | 修复结论 |
|---|---|---|---|
| 短回答正常完成 | `stopReason=end_turn truncated=false` | 出现 `truncated=true` | P0-1 误报,需查 socket abort 误触发 |
| 长回答中途上游断流 | `stopReason=max_tokens truncated=true bufferRemain>0` | 仍 `end_turn` | P0-1 没生效,排查 `__kiroStreamEnd` 链路 |
| 工具调用回答 | `stopReason=tool_use truncated=*` | `tool_use` 被 truncated 覆盖 | 优先级写反 |
| 上游冷启动(首字节 >30s) | 不报 truncated | `stopReason=max_tokens truncated=true socketAborted=true` 且 `bufferRemain=0` | P1-1 首字节阶段保护没生效 |
| 客户端 64K 报错 | 看 outTok 字段(评审 N3 分诊) | outTok ≤ 60000 仍报 | 估算系数偏高 |

**采样命令(单行 grep)**:
```
grep "STREAM_SUMMARY" /var/log/aiclient2api.log \
  | awk '{ for(i=1;i<=NF;i++) if($i~/^stopReason=|^truncated=|^outTok=/) printf "%s ",$i; print "" }' \
  | sort | uniq -c | sort -rn
```
直接出"stopReason × truncated × outTok 分桶"分布。

### S3 — 真实 fixture 采集(临时 dump 钩子)

**目标**:取 1~2 段真实 Kiro 上游响应保存为字节文件,供后续单测在 chunk 边界做回归。

**钩子设计**(临时,采完即删):
- 在 `streamApiReal` 主循环 [claude-kiro.js:2167-2184](src/providers/claude/claude-kiro.js#L2167-L2184) 加一个**只读 raw byte dump**(在 `decoder.write(chunk)` **之前**),受环境变量 `KIRO_DUMP_RAW_STREAM=1` 控制:
  ```js
  const dumpRaw = process.env.KIRO_DUMP_RAW_STREAM === '1';
  let dumpStream = null;
  if (dumpRaw) {
      const fs = await import('fs');
      const dumpPath = `tests/fixtures/kiro-stream/raw-${Date.now()}-${uuidv4().slice(0,8)}.bin`;
      dumpStream = fs.createWriteStream(dumpPath);
      logger.info(`[Kiro Stream] Dumping raw stream to ${dumpPath}`);
  }
  for await (const chunk of stream) {
      if (dumpStream) dumpStream.write(chunk);  // chunk 为 Buffer,直接写
      // ... 既有逻辑 ...
  }
  if (dumpStream) dumpStream.end();
  ```
- **重要**:dump 必须写**原始 Buffer**(不经 StringDecoder),否则失去复现 chunk 边界 bug 的价值。
- `try/finally` 保证 dumpStream 一定 close(否则文件可能残缺)。

**采集流程**:
1. `KIRO_DUMP_RAW_STREAM=1 npm start`(单进程,避免并发文件交错)。
2. 各跑一次:① 短回答 ② 长回答 ③ 工具调用 ④ 含中文 / Emoji 的回答。
3. 关闭 dump,选 2 段最有代表性的(长回答 + 工具调用)重命名为 `tests/fixtures/kiro-stream/long-response.bin` 和 `tool-call.bin`,其余删除。
4. **Dump 钩子代码完成后立刻撤回**(不进 main 分支或留 disabled 默认),避免长期写满磁盘。

**fixture 回归测试**(新增到 `tests/providers/claude-kiro-parser.test.js` 或新建 `claude-kiro-fixture.test.js`):
```js
import fs from 'fs';
import { StringDecoder } from 'string_decoder';
import { parseAwsEventStreamBuffer } from '../../src/providers/claude/aws-event-stream-parser.js';

test('long-response.bin 按 1KB 切片解码后,所有 content 拼接非空且不含 U+FFFD', () => {
    const raw = fs.readFileSync('tests/fixtures/kiro-stream/long-response.bin');
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    const allEvents = [];
    for (let i = 0; i < raw.length; i += 1024) {
        buffer += decoder.write(raw.subarray(i, Math.min(i + 1024, raw.length)));
        const r = parseAwsEventStreamBuffer(buffer);
        buffer = r.remaining;
        allEvents.push(...r.events);
    }
    buffer += decoder.end();
    allEvents.push(...parseAwsEventStreamBuffer(buffer).events);
    const text = allEvents.filter(e => e.type === 'content').map(e => e.data).join('');
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain('�');
});

test('tool-call.bin 中至少有一个 toolUse 事件,且 input 是字符串', () => {
    // ... 同上读取 ...
    const tools = allEvents.filter(e => e.type === 'toolUse');
    expect(tools.length).toBeGreaterThan(0);
    expect(typeof tools[0].data.input).toBe('string');
});

test('随机切片大小(1B / 7B / 13B)解码出的 content 与 1KB 切片完全相同', () => {
    // 三次解码取 content 拼接,assert.equal 三者相等 → chunk 边界鲁棒性
});
```

**好处**:这些回归在没有运行 service 的情况下能完整验证 P0-2(StringDecoder)+ P1-2(单一退出点)在真实数据上的行为。

### S4 — P1.5 客户端断开传递(本轮仅登记,不做)

评审 R1 指出 P1-1 落地后 socket inactivity 60s 会让"客户端断开 → 服务端余 60s 才停止占用"现象更明显。本轮**仅登记**,不实施。建议方案大纲(供未来落地参考):

1. `handleStreamRequest`([common.js:618-637](src/utils/common.js#L618-L637))创建 `AbortController`,把 `signal` 透传给 `service.generateContentStream(model, requestBody, { signal })`。
2. `clientDisconnected.value=true` 时,调 `controller.abort()`。
3. `claude-kiro.js streamApiReal` 接收 `signal`:
   - 在 axios 请求里传 `signal: opts.signal`(axios ≥0.22 支持);
   - 同时监听 `signal.aborted` → `stream.destroy()` 主动断上游;
   - catch 路径里 `if (signal.aborted) { wasTruncated=false; ... }` —— 客户端断开**不算 truncated**,避免污染 stopReason。
4. 单测覆盖:模拟下游 res 提前 close,验上游 socket 被立即 destroy(可观察 axios mock 收到 abort)。

**优先级**:P1.5(P1-1 之后,P2 之前)。**前置**:S1 + S2 跑出第一份压测数据后,看"客户端断开后等 60s"现象是否真在生产可见,确认后再排期。

### S5 — 落地顺序(本轮)

1. **S1 STREAM_SUMMARY 埋点**(2 行代码,5 分钟)→ 提交 → 部署。
2. **S3 临时 dump 钩子**(env-gated 加几行)→ 同次提交或独立提交 → 部署。
3. 服务器端开 `KIRO_DUMP_RAW_STREAM=1`,跑 S2 压测脚本采集 4 类样本。
4. 关闭 dump,选 2 个保留为 fixture,**撤掉 dump 钩子代码**(或保留 env-gated 默认 off)。
5. 写 fixture 回归测试,跑 `npm test` 确保通过。
6. 用 S2 判定矩阵 + 一行 grep 出修复效果报告。

### 关键文件(新增/修改)

| 文件 | 用途 |
|---|---|
| [src/providers/claude/claude-kiro.js:2890](src/providers/claude/claude-kiro.js#L2890) (S1) | message_delta 之前加 STREAM_SUMMARY |
| [src/providers/claude/claude-kiro.js:2244](src/providers/claude/claude-kiro.js#L2244) (S1) | catch 路径末尾加 STREAM_SUMMARY(stopReason=error truncated=true) |
| [src/providers/claude/claude-kiro.js:2167](src/providers/claude/claude-kiro.js#L2167) (S3) | env-gated raw byte dump 钩子(临时) |
| `tests/fixtures/kiro-stream/long-response.bin`(新建) | 长回答原始字节,fixture |
| `tests/fixtures/kiro-stream/tool-call.bin`(新建) | 工具调用原始字节,fixture |
| `tests/providers/claude-kiro-fixture.test.js`(新建) | 基于真实 fixture 的回归 |

### 验证

- **S1**:重启 service 后跑一次任意请求,`grep STREAM_SUMMARY` 应有一行,字段齐全。
- **S2**:压测 4 类场景后,判定矩阵每行命中。**特别**:发起一次 Claude Code 长回答,不再出现 `64000 output token maximum` 报错(若仍出现,按评审 N3 分诊规则定位)。
- **S3**:fixture 文件存在且 `file tests/fixtures/kiro-stream/*.bin` 报"data";`npm test` 通过包括新增的 fixture 回归;dump 钩子撤回后再跑一次,`KIRO_DUMP_RAW_STREAM=0` 默认不写文件。
