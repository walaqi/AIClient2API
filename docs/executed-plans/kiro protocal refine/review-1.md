# 评审意见 Round 1 — Kiro AWS event-stream 解析器重写

评审对象：`/home/chris/.claude/plans/claude-code-generic-piglet.md`

## 总评

方向**正确且必要**。根因定位（binary header 字节命中 brace 状态机 + StringDecoder 提前 UTF-8 解码破坏字节流）与 `tail.hex` 实证完全一致，重写为按帧解析 + Buffer 全链路是唯一正确解。可以基本按此方案执行，但有若干**必须解决的矛盾点**与**应当加固的细节**。

---

## 阻塞性问题（必须修正后再实施）

### B1. 「删除旧函数」与「旧测试用例仍工作」自相矛盾

- 改动 1 明确：**删除** `parseAwsEventStreamBuffer(string)`，「所有调用点同步切到新函数」
- 改动 3 明确：现有用例「基于错误前提……整体重写」
- 但「验证步骤 2」却写：「`npm test -- claude-kiro-parser` 应全绿（旧用例通过 wrapper 仍工作）」

→ 没有 wrapper 的设计描述。请二选一：
- (a) 真的删旧函数 + 整体重写测试（推荐，与改动 1/3 一致）
- (b) 保留旧函数作为 thin wrapper 过渡期共存（需补充 wrapper 的语义定义）

并相应修正验证步骤的措辞。

### B2. 调用点 `this.parseAwsEventStreamBuffer` 是方法委托，不是直接导入

[claude-kiro.js:2267](src/providers/claude/claude-kiro.js#L2267) 通过 `this.parseAwsEventStreamBuffer(buffer)` 调用，说明 `KiroApiService` 上挂了一个方法。计划只提到「调用点同步切」，但没说明：

- 这个方法当前在 class 上的定义位置
- 是替换 method body、删除 method 改 direct import、还是新增 method
- 历史上是否有除 claude-kiro.js 外的其他调用方（需 grep 验证）

请补充："grep `parseAwsEventStreamBuffer` 全仓 → 处理点列表 → 每个点的迁移方式"。

### B3. 测试用例里 fake headers `':event-type\x07\x00\x05event'` 不是合法 AWS event-stream header

真实 header 格式是 `[name_len:1][name][value_type:1][value_len:2][value]`，且 `headers_len` 是整个 headers 区段字节数。当前 helper 写的是裸字符串，**碰巧** payload 起止偏移算对了（因为只用 `headersBuf.length`），但：

- 对「**核心回归用例**：header 段含 `0x22`/`0x5c`/`0x7b`」必须显式构造**包含这些字节作为 header value** 的 buffer，例如让 value 形如 `"{abc\}` 之类，否则不能证明真实修复了 bug
- 建议封装一个最小但合法的 header writer（writeHeader(name, str)），既便于测试也方便将来真正解析 header

不是阻塞功能本身，但**阻塞「这个测试能否证明 bug 被修」**。

---

## 重要细节（实施前明确）

### D1. `Buffer.concat` 每个 chunk 都执行 → O(n²)

```js
buffer = buffer.length === 0 ? chunkBuf : Buffer.concat([buffer, chunkBuf]);
```

当前样本 344 chunks / 85KB 无感，但长会话或大上下文场景下会放大。两个可选优化：

- 用 chunk list + 末尾一次性 concat（解析时按需）
- 用环形 / growable buffer（如 `BufferList` 风格）

建议至少在 plan 里**显式记一笔「已知 O(n²)，本轮不优化，超过 X MB 再回头」**，避免后续被当 bug 翻出来。

### D2. 帧头 sanity 失败时「跳 1 字节」缺少上界

如果由于 socket 提前关或某个奇异 case 真的丢同步，最坏情况会 byte-by-byte 扫整段 buffer 找下一帧。建议：

- 增加 metrics / WARN 日志：「连续 N 次跳字节才找回帧」时告警（说明同步丢失，不是个例容错）
- 给 `pos += 1` 加上限：若一次解析里跳过的字节数 > buffer 长度的某比例（如 10%），直接告警 + 丢弃 + return remaining=Buffer.alloc(0)，防止脏 buffer 永远卡住后续 chunk

### D3. payload 不是 JSON 时「静默跳过」会丢异常事件

AWS event-stream 里 `:message-type` 可以是 `event`/`error`/`exception`：

- `error` 帧 payload 常为空 → 静默 OK
- `exception` 帧 payload 通常是 JSON → 当前逻辑能命中 JSON.parse 成功路径
- 但若 payload 是非 JSON 的纯文本错误，**静默跳过会让 Kiro 端的 error 在我们这边消失**

建议：在 JSON.parse 失败分支至少 `logger.debug` 一条带帧 header 概要的日志（不需要解 header，只 dump 前 N 字节 hex 即可），便于事后回查。

### D4. 不解 header 的折损

计划写「我们现在不需要 header 内容」。但事件分发当前完全靠 payload shape 启发式判断（content / reasoning / toolUse / toolUseInput / toolUseStop / contextUsage / metering）。Kiro 上游帧的 `:event-type` header **是最权威的分发依据**。建议：

- 本轮**仍走 payload shape**，不阻塞落地
- 但在 plan「不在本次范围」里把「将 :event-type 引入分发以替代 shape 启发式」明确列为下一步，并在 `emitEventFromParsed` 处留 TODO 注释，避免半年后再有人踩一次「shape 判断撞型」的坑

### D5. fixture 抓取方案落地建议

「临时 `fs.appendFileSync` + 跑一次 + 移除」流程脆弱、易遗忘。建议：

- 改成读环境变量开关 `KIRO_CAPTURE_RAW=/tmp/xxx.bin`，仅在该变量存在时写文件
- 这样代码可常驻仓库，不需要「捕获后立即移除」这种依赖人工纪律的步骤

---

## 次要 / 文字性

- N1. `headersLen < 0` 不可能成立（`readUInt32BE` 返回无符号 32 位），条件可删，留 `>` 上界即可
- N2. 「`MAX_FRAME_LEN = 16MB`」上界依据需要一句话注释（不然 reviewer 看不出是哪里来的数）
- N3. 计划里说「不需要 `decoder.end()`」是对的，但同时也应明确：原 `decoderEnded` 标志位、`try/finally` 中的兜底 `decoder.end()` 一并删掉（计划已含，但只在「顺带清理」一行带过，建议显式列 diff 删除范围）
- N4. 「预期影响」一节断言「所有 `bufferRemain>0` WARN 应消失」过强。某些极端 chunk 边界（最后一帧未收完 + socket FIN）理论上仍可能短暂残留 1 帧。建议改为「应基本消失，残留 < 1 个完整帧大小」

---

## 验证步骤补强

现有 7 步偏「主流程跑通」，建议加：

- **8. 字节级回归**：用改动 1 helper 构造一个 `headers` 内含 `{ " \\` 三种字节的帧，跑新解析器，断言 payload JSON 被正确解出（B3 的形式化）
- **9. fixture 完整性反向断言**：除了 `remaining.length === 0`，还应断言 `events` 中含 `__messageStop`/`contextUsage`/`metering` 至少各 1 个（视抓取请求而定），确保**不是因为提前 break 而 remaining 为 0**

---

## 结论

**建议状态：需修订后再实施。** 阻塞项 B1/B2/B3 解决后即可进入编码；D 项酌情吸收，N 项随手改。

