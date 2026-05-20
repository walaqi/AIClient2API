# 评审意见 — Round 2

**评审对象**:[stream-stream-event-stream-client-max-t-unified-clock.md](../../../../.claude/plans/stream-stream-event-stream-client-max-t-unified-clock.md) (v2)
**评审日期**:2026-05-15
**前轮**:[review_1.md](review_1.md)
**评审范围**:v2 修订版的采纳质量、遗留问题、新增风险

---

## 总体结论

**通过,可落地**。v2 把 round-1 的五条核心建议都吞下了:多源 OR 截断信号、删 60000 夹紧、300s + socket inactivity、单一退出点、单测提级。逻辑闭环且与代码现状对得上。

但存在 **1 处明显笔误**、**4 处需要在实施时注意的细节**、**1 个新增的交互风险**。下面逐项说。

---

## 必须修正

### M1:v2 第 156 行代码示例笔误 —— 阻塞落地

```js
for await (const chunk ofam) { buffer += decoder.write(chunk); ... }
//                       ^^^ 这里
```

应为 `of stream`。这是粘贴时被啃掉的字符,不是真实代码。**必须改回**,否则照抄就编译报错。

---

## 需要在实施时注意

### N1:L143 引用行号有 ±1 偏差,不影响结论

> v2 原文:"Gemini 走 [ClaudeConverter.js:1370-1371] 映射到 `MAX_TOKENS`"

实测 [src/converters/strategies/ClaudeConverter.js:1371-1372](../../../src/converters/strategies/ClaudeConverter.js#L1371-L1372) 才是 `stopReason === 'max_tokens' ? 'MAX_TOKENS'`。OpenAI 那侧 [ClaudeConverter.js:578-580](../../../src/converters/strategies/ClaudeConverter.js#L578-L580) 行号准确。仅文档行号偏差,**结论不变,跨协议映射均已存在**。落地时顺手把行号修正即可。

### N2:跨协议映射只查了"流式"路径,unary 漏一行

v2 L143 只列了流式 chunk 的映射(L578、L1371)。**unary 路径**还有 [ClaudeConverter.js:381-389](../../../src/converters/strategies/ClaudeConverter.js#L381-L389)(Claude→OpenAI)和 [ClaudeConverter.js:1253-1267](../../../src/converters/strategies/ClaudeConverter.js#L1253-L1267)(Claude→Gemini)。已实测两处都把 `'max_tokens'` 映射为 `'length'` / `'MAX_TOKENS'`。**无需新增工作**,但评审建议在 P0-1 落地时把这两条也写进验证清单,免得后续误以为没覆盖。

### N3:P0-3 删 `Math.min(60000)` 后,客户端 64K 硬限不会消失

修复 output_tokens 双计后:

- **如果**之前的 64K 报错是因为"双计虚报"导致 → 修完不再触发,问题解决;
- **如果**实际内容真的超 64K → 修完依然触发,这是**客户端的硬限,本项目无法消除**。

v2 没把这个边界条件写清,作者(以及 review 阅读者)可能误以为"修完双计 = 64K 报错绝迹"。

**建议**在 v2 验证段补一句:"若修复后仍出现 64K 报错,看 `message_delta.usage.output_tokens` 的实际值——若 ≤60K 则是估算不准需进一步修;若 >60K 则是上游真长输出,需要客户端侧 `CLAUDE_CODE_MAX_OUTPUT_TOKENS` 调高。" 这样运维侧才能正确分诊。

### N4:P1-1 的 socket inactivity 30s 默认,对"首字节延迟"路径太严

`socket.setTimeout(30000)` 是**任意 30s 静默**就触发,包括"请求发出 → 第一个字节"之间的等待。Kiro / Claude 上游在排队 / 冷启动场景下,首字节延迟超 30s 不算少见;模型在长 reasoning 中也可能短暂沉默。

**建议**:

- 首字节阶段单独走 axios 的总 timeout(300s),不启用 socket inactivity;
- 收到第一个 byte 后才调 `socket.setTimeout(30000)` 切到 inactivity 模式;
- 或者直接给个更宽的默认值如 60s,然后让 `KIRO_STREAM_INACTIVITY_MS` 可配。

不要把所有用户都默认丢进 30s 静默就被砍的体验里——一旦上游真的慢一点,就会出现"莫名其妙的 max_tokens"。

### N5:P0-1 `__streamEnd` 是泄漏抽象,但可接受

`streamApiReal` 现在 yield 的是数据事件(content / toolUse / metering …),v2 让它再 yield 一个**控制事件** `{ type: '__streamEnd', truncated }`,意味着 `generateContentStream` 的 if/else if 链要新增一支专门处理它,所有未来新加的事件类型也要小心别和 `__streamEnd` 重名。

更"正"的做法是用 `try { for await … } finally { /* 通过外部闭包标记 */ }` 在调用方用 `Promise<{events, truncated}>` 包装。但**改造成本高**,而且 v2 的双下划线前缀已经做了命名隔离,**可接受**。落地时建议:

1. 把事件名换成更长更安全的 `__kiroStreamEnd`,降低未来碰撞概率;
2. 在 `generateContentStream` 的事件 if/else 链顶部加一个**白名单兜底**:对未识别事件 `logger.debug(...)` 而不是静默吞;
3. 单测里加一个"`__streamEnd` 不被作为 content 输出"的反向断言。

---

## 新增风险

### R1:P0-1 与"客户端断开未传递到 service 侧"(backlog #1)的交互

v2 把 P0-1 的多源 truncated 信号交给 `streamApiReal` 的 catch 路径捕获,但**客户端断开时,axios stream 不会自动报错**——`for await` 会一直等到 socket inactivity 超时(P1-1 的 30s)才被 destroy,然后才走到 catch。期间:

1. `handleStreamRequest` 这一侧已经 `break` 外层循环、释放 slot、可能已 `res.end()`;
2. service 一侧 generator 仍在跑,继续向已关闭的 res 上下文积累状态;
3. 30s 后 axios catch 触发 → P0-1 试图 yield `__streamEnd` → 上游消费者(handleStreamRequest)早已退出 → 这个 yield 被吞或卡住。

**这不是 P0-1 引入的 bug**,但 P0-1 + P1-1 同时落地会让"客户端断开 → 服务端余 30s 才停止占用"的现象**变得更明显**(原本是 axios 总超时 120s)。

**建议**:在 v2 backlog #1 的描述里补一句"P1-1 落地后此问题影响放大,优先级建议提到 P1.5"。本轮不修,但要登记影响层级变化。

### R2:P1 单测的 mock 数据生成方式未定

v2 列了 6 个 case,但**没说怎么造一段合法的 AWS Event Stream 二进制 chunk**。两个选项:

- **选项 A**:从真实 Kiro 响应抓一段保存为 fixture,test 时分片读;
- **选项 B**:写一个最小 helper 模拟二进制头 + JSON payload 的拼接。

**强烈建议选 A**——选 B 会引入"测试用解析器自身正确"的循环依赖。v2 应明确指示写测试时用 fixture,并把 fixture 文件路径(如 `tests/fixtures/kiro-stream/long-response.bin`)定下来。

---

## 落地顺序补充建议

v2 的落地顺序合理,但建议在第 1 步和第 2 步之间插入一步"**收集真实 fixture**"——发一版仅含 P0-2 + P0-3 的版本到测试环境,顺手抓 1~2 段真实流响应保存为 fixture。这样:

1. 后续单测有真实数据可用;
2. 在生产观察一段时间能验证"双计修复"是否解决了大多数 64K 报错;
3. 若仍有报错,fixture 能帮助定位是不是估算系数本身偏高。

---

## 与 v1 → v2 的差异核对

| Round-1 建议 | v2 采纳情况 | 备注 |
|---|---|---|
| P0-1 改多源 OR | ✅ L130-145 已落实 | 见 N5 抽象层关注点 |
| 删 `Math.min(60000)` | ✅ L173 已删 | 见 N3 文档补充 |
| `decoder.end()` 放 finally | ✅ L155-162 已落实 | 见 M1 笔误 |
| 跨协议 stop_reason 映射核验 | ✅ L143 已核 | 见 N1/N2 行号偏差 |
| P1-1 默认 300s + socket inactivity | ✅ L176-187 已落实 | 见 N4 首字节阶段 |
| P1-2 单一退出点 | ✅ L189-213 已落实 | 改写正确 |
| P2 提级到 P1 | ✅ L215-225 已落实 | 见 R2 fixture 方式未定 |
| 客户端断开 backlog | ✅ L238 已登记 | 见 R1 影响放大 |
| metering 脆弱 backlog | ✅ L239 已登记 | OK |
| 重复 content 过滤 backlog | ✅ L240 已登记 | OK |

**采纳完整度:10/10。** 没有偷工减料,质量好。

---

## 结论

修掉 **M1 笔误**后即可开始按 v2 落地顺序实施。N1-N5 在实施过程中顺手处理,R1/R2 在对应阶段(P1-1 落地、单测落地)提醒注意即可。**不需要 v3,直接进入实施阶段**。

待澄清一个问题:N4 提到的"首字节阶段不启用 socket inactivity"是否要做?如果作者觉得 30s 默认可接受、宁愿少改代码,**可以接受**——但需要在文档里写明"已知:Kiro 冷启动可能误判截断,可调 `KIRO_STREAM_INACTIVITY_MS`"。
