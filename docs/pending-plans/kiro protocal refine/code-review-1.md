# 代码审核 Round 1 — Kiro AWS event-stream 解析器重写

> 审核范围：plan v2.1 第一轮实施。

---

## Context

[plan.md (v2.1)](plan.md) 完成第一轮实施。本次审核核对：
- 是否按 plan 落地（B1/B2/B3/C1-C5/D1-D5/N1-N4）
- 实现是否存在新引入的逻辑/正确性问题
- 测试是否真实覆盖了 plan 声称的路径

审核对象：
- [src/providers/claude/aws-event-stream-parser.js](../../../src/providers/claude/aws-event-stream-parser.js) — 解析器重写
- [src/providers/claude/claude-kiro.js](../../../src/providers/claude/claude-kiro.js) — chunk 处理改 Buffer
- [tests/providers/claude-kiro-parser.test.js](../../../tests/providers/claude-kiro-parser.test.js) — 测试整体重写

---

## 总评

实施基本贴合 plan v2.1。Plan 中所有阻塞项（B1/B2/B3）和大多数重要细节都已落地：旧 wrapper 完全删除、StringDecoder 全链路移除、`emitEventFromParsed` 抽出、`KIRO_CAPTURE_RAW` 环境变量门控、sync-loss 上界、非 JSON payload WARN 都已实现，B3 核心回归用例（header 含 `0x22 0x5c 0x7b 0x7d` 字节）写法正确。

但发现 **2 个需要补回的实施漏项**和 **1 处测试覆盖虚假绿**：D1 约定的 O(n²) 注释丢失、sync-loss discard 路径测试不能实际触发该路径、多个 WARN 日志路径无 logger 断言。

**建议状态：补完 issue 2/3/4 后即可视为本轮完成，进入 `npm start` 实测阶段。**

---

## 一、Plan 项落地核对

| Plan 项 | 状态 | 位置 / 备注 |
|--------|------|------------|
| B1 删旧 wrapper | ✅ | `grep parseAwsEventStreamBuffer src/ tests/` 全空 |
| B2 类方法迁移 | ✅ | [claude-kiro.js:2165](../../../src/providers/claude/claude-kiro.js#L2165) 改名，[L2275](../../../src/providers/claude/claude-kiro.js#L2275) 调用点同步 |
| B3 测试 helper 合法 | ✅ | [claude-kiro-parser.test.js:8](../../../tests/providers/claude-kiro-parser.test.js#L8) `writeStringHeader`，B3 用例 [L103](../../../tests/providers/claude-kiro-parser.test.js#L103) |
| C1 `await import('fs')` 出循环 | ⚠️ 实质 OK，写法冗余 | 见 [issue 1](#issue-1-low--动态-import-写法冗余) |
| C2 找回帧后无条件重置 bytesSkipped | ✅ | [aws-event-stream-parser.js:46](../../../src/providers/claude/aws-event-stream-parser.js#L46) |
| C3 describe 名不引用内部函数 | ✅ | 改用 `'事件分发 (payload shape → event type)'` |
| C4 thin delegator + 注释 | ✅ | [claude-kiro.js:2164](../../../src/providers/claude/claude-kiro.js#L2164) |
| C5 验证步骤顺序 | n/a | 不影响代码 |
| D1 `Buffer.concat` O(n²) 注释 | ❌ 漏 | 见 [issue 2](#issue-2-low--d1-约定的-on²-注释缺失) |
| D2 sync-loss 上界 | ✅ 代码 / ❌ 测试 | 实现正确，但测试未真正触发，见 [issue 3](#issue-3-medium--sync-loss-discard-路径未被实测覆盖) |
| D3 非 JSON payload WARN | ✅ 代码 / ⚠️ 测试无断言 | 见 [issue 4](#issue-4-medium--多个-warn-路径缺少-logger-断言) |
| D4 `emitEventFromParsed` TODO 注释 | ✅ | [aws-event-stream-parser.js:69](../../../src/providers/claude/aws-event-stream-parser.js#L69) |
| D5 `KIRO_CAPTURE_RAW` 门控 | ✅ | [claude-kiro.js:2229-2234](../../../src/providers/claude/claude-kiro.js#L2229-L2234), [L2268-2270](../../../src/providers/claude/claude-kiro.js#L2268-L2270) |
| `StringDecoder` 全链路移除 | ✅ | `grep StringDecoder/decoderEnded` 全空 |

---

## 二、待补强（按严重度）

### Issue 1 (LOW) — 动态 import 写法冗余

[claude-kiro.js:2232](../../../src/providers/claude/claude-kiro.js#L2232)：

```js
captureFs = (await import('fs')).default || await import('fs');
```

第一个 `(await import('fs')).default` 通常已经能拿到 fs 对象（Node 给 CJS 模块自动生成 default export），`||` 后的第二次 `await import('fs')` 几乎不可能触发；即便触发，namespace 对象本身也带 `appendFileSync`，没必要再 fallback。等于做了**两次** `await import` 来求一个相同结果。

**建议简化**为一次 import + 一次取值：

```js
const fsModule = await import('fs');
captureFs = fsModule.default || fsModule;
```

或顶层加一句 `import * as fsCapture from 'fs'`，热路径内只判断 `if (captureRawPath) fsCapture.appendFileSync(...)`。

非阻塞，仅风格 / 微小性能问题。

---

### Issue 2 (LOW) — D1 约定的 O(n²) 注释缺失

[claude-kiro.js:2272](../../../src/providers/claude/claude-kiro.js#L2272)：

```js
buffer = buffer.length === 0 ? chunkBuf : Buffer.concat([buffer, chunkBuf]);
```

Plan v2.1 改动 2.2 显式约定要在此处加注释：「已知 O(n²)，本轮不做 BufferList 优化；当前样本量（< 1MB）无感，未来若日志显示 totalRawBytes > 10MB 才需要重构」。

实施时漏掉。**建议**补回，否则后续 reviewer 会重新踩一次「这里能不能优化」的问题，并且历史决定会被遗忘。

---

### Issue 3 (MEDIUM) — sync-loss discard 路径未被实测覆盖

[tests/providers/claude-kiro-parser.test.js:78-84](../../../tests/providers/claude-kiro-parser.test.js#L78-L84)：

```js
test('sync-loss 超 10% 时丢弃 buffer + 返回空 remaining', () => {
    const garbage = Buffer.alloc(200, 0xff);
    const frame = makeFrame('{"content":"x"}');
    const buf = Buffer.concat([garbage, frame]);
    const { events, remaining } = parseAwsEventStreamFrames(buf);
    expect(remaining.length).toBe(0);
});
```

代入解析器实际行为：

- `bufLen ≈ 200 + frame_len ≈ 250`
- 触发阈值 = `Math.max(SYNC_LOSS_WARN_BYTES=256, bufLen * 0.10 ≈ 25)` = **256**
- 实际跳过字节最多 = 200（garbage 长度，之后命中合法帧）
- **200 < 256 → 永远不会进入 discard 分支**

→ 解析器自然走完 garbage、找到 frame、解析后 `pos` 推到末尾，`remaining = buf.subarray(pos)` 自然 0。**测试断言对错误路径同样为真，等于对 discard 路径零覆盖。**

**风险**：将来若 discard 分支被破坏（比如 `return { events, remaining: Buffer.alloc(0) }` 的 `remaining` 写错），这个测试**不会失败**。

**建议改写**：让 garbage 大于阈值、且其后**不带可恢复帧**：

```js
test('sync-loss 超阈值 → discard buffer', () => {
    const garbage = Buffer.alloc(300, 0xff);   // 大于 256
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const { events, remaining } = parseAwsEventStreamFrames(garbage);
    expect(events).toEqual([]);
    expect(remaining.length).toBe(0);  // 因 discard 而非自然消耗
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Sync loss exceeded budget'));
    warnSpy.mockRestore();
});
```

并保留原来的「200 字节 garbage + frame」用例作为「能从 sync-loss 中恢复」正向测试，把名字改为 `'sync-loss 未超阈值 → 跳字节后仍能恢复 frame'`。

---

### Issue 4 (MEDIUM) — 多个 WARN 日志路径缺少 logger 断言

Plan 3.2 用例集对 D3 写明了「非 JSON payload 触发 WARN 日志 (mock logger 断言)」，当前实现 [test:167-172](../../../tests/providers/claude-kiro-parser.test.js#L167-L172)：

```js
test('非 JSON payload 不抛异常, 返回空 events', () => {
    const frame = makeFrame('this is not json at all');
    const { events, remaining } = parseAwsEventStreamFrames(frame);
    expect(events).toEqual([]);
    expect(remaining.length).toBe(0);
});
```

只断言「不抛 + events 空」，**没有断言 `logger.warn` 被调用**。同样：

- `[Kiro Parse] Recovered frame after skipping ${bytesSkipped} bytes` 路径无断言
- `[Kiro Parse] Sync loss exceeded budget` 路径见 [issue 3](#issue-3-medium--sync-loss-discard-路径未被实测覆盖)
- `[Kiro Parse] Unrecognized event JSON` debug 路径无断言（debug 级别可不强求）

**风险**：这些 WARN 是排查现网截断 bug 的关键信号源（plan「预期影响」第 3 点专门提到「Kiro 的 error/exception 控制帧不再被静默吞，转为 WARN 日志」）；如果哪天被 silent 注释掉或 logger 接口换名，测试不会发现，又退化回原来"莫名截断"的诊断盲区。

**建议**：在每个 WARN 路径用例里加：

```js
const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
// ... 触发用例
expect(warnSpy).toHaveBeenCalledWith(
    expect.stringContaining('Non-JSON payload frame skipped')
);
warnSpy.mockRestore();
```

至少覆盖：
- `Non-JSON payload frame skipped`
- `Recovered frame after skipping`
- `Sync loss exceeded budget`

---

### Issue 5 (LOW) — 移除了 null-chunk 防御

旧代码：
```js
if (chunk && chunk.length > 0) {
    lastRawChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    ...
}
```

新代码 [claude-kiro.js:2261](../../../src/providers/claude/claude-kiro.js#L2261)：
```js
const chunkBuf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
if (chunkBuf.length > 0) { ... }
```

边界差异：

| chunk 值 | 旧行为 | 新行为 |
|---------|-------|--------|
| `null` | 跳过 | `Buffer.from(null)` → TypeError 抛出 |
| `undefined` | 跳过 | `Buffer.from(undefined)` → TypeError 抛出 |
| `''` 空字符串 | 跳过 | `Buffer.from('')` 长度 0，进 if 不执行 |
| 正常 Buffer | 处理 | 处理 |

axios stream 实践中几乎不会发 null/undefined chunk，但 plan 没要求移除该防御。一旦真发生（异常网络栈/proxy/中间件），会让 stream 循环意外抛异常。

**建议**改成：
```js
if (!chunk) continue;
const chunkBuf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
if (chunkBuf.length > 0) { ... }
```

非阻塞。

---

### Issue 6 — Fixture 集成测试未实现（plan 主动延后项）

Plan 3.3 的 fixture 测试（读 `tests/fixtures/kiro-stream/sample-1.bin` → 断言 `remaining=0` + 含 metering 等）当前 test 文件无对应 describe block。

按 plan 验证步骤 4，这是**主动延后**到「`npm start` 实测一次 → 抓 fixture → 移文件 → 写测试」的步骤，不算实施漏项。

**建议**：在跑完 `npm start` 验证、`KIRO_CAPTURE_RAW` 抓到 fixture 后再补上，保留作为 round 2 / 后续 PR 的尾巴。

---

## 三、文字性 / 微调

### N1. JSDoc + 一行注释略冗余

[claude-kiro.js:2160-2167](../../../src/providers/claude/claude-kiro.js#L2160-L2167)：

```js
/**
 * 解析 AWS Event Stream 二进制帧，提取所有完整的 JSON 事件
 * 返回 { events: 解析出的事件数组, remaining: 未处理完的 Buffer }
 */
// thin delegator 保留便于子类 override 和测试 mock
parseAwsEventStreamFrames(buf) {
    return awsParseEventStreamFrames(buf);
}
```

JSDoc 块和单行注释相邻、信息正交但无层级。**建议**合并为一段 JSDoc：

```js
/**
 * 委托到 `awsParseEventStreamFrames`，保留为 method 是为了便于子类 override 和测试 mock。
 * 入参：Buffer。返回：{ events, remaining: Buffer }。
 */
parseAwsEventStreamFrames(buf) {
    return awsParseEventStreamFrames(buf);
}
```

非阻塞。

### N2. 旧文件头 JSDoc 完全删除

旧 `aws-event-stream-parser.js:1-13` 有一段说明「为什么抽到独立模块」和「单一退出点」。新文件无任何 module-level 注释。

「单一退出点」内容确实过时该删，但「为什么抽到独立模块（便于单元测试，无需启动 service / 加载 ESM-only 模块）」仍然成立，**建议**保留一两行（或合到 README）。否则未来读者会不理解为什么不直接放在 claude-kiro.js 里。

非阻塞。

### N3. 流尾 WARN 用 utf8 解码可读性差

[claude-kiro.js:2316](../../../src/providers/claude/claude-kiro.js#L2316)：

```js
logger.warn(`[Kiro Stream] Raw stream ended with remaining buffer (${buffer.length} bytes): ${buffer.subarray(0, 200).toString('utf8')}`);
```

如果 buffer 残留正好是二进制 header 字节（`0x80-0xff` 段），utf8 toString 会产生 U+FFFD 替换字符，现场看 log 时会看到一串 ` `，无法定位卡在什么字节边界。下面紧接的 lastRawChunk diagnostic（[L2319-2323](../../../src/providers/claude/claude-kiro.js#L2319-L2323)）已经 dump hex+ascii，建议这条 WARN 一致处理：

```js
const head = buffer.subarray(0, 200);
logger.warn(
    `[Kiro Stream] Raw stream ended with remaining buffer (${buffer.length} bytes), ` +
    `head.hex=${head.toString('hex')}, head.utf8=${JSON.stringify(head.toString('utf8'))}`
);
```

非阻塞。便于现网定位「到底卡在什么字节边界上」。

---

## 四、回归健全性快查（基于代码 review 推断，需 `npm test` 实测确认）

| 测试用例 | 推断结果 |
|---------|---------|
| 单帧 round-trip | ✅ |
| 多帧批量 (content + reasoning + metering) | ✅ |
| 帧未收完 → remaining 保留 | ✅ |
| 帧头非法 → 跳 1 字节继续 | ✅ |
| sync-loss 超阈值丢弃 | ❌ 用例不能触发该路径，见 issue 3 |
| 跨 chunk 拼接（cut at frame mid） | ✅ |
| **B3 核心回归（header 含 `0x22 0x5c 0x7b 0x7d`）** | ✅ |
| 空 buffer / 短于 prelude | ✅ |
| 各 event 类型分发 | ✅ |
| 非 JSON payload 不抛 | ✅（但缺 logger 断言） |
| `normalizeKiroToolInput` 边界 | ✅ |

---

## 五、建议下一步

1. **补 issue 2**：claude-kiro.js:2272 加 plan D1 约定的 O(n²) 注释。
2. **补 issue 3**：把 sync-loss 测试改为真正能触发 discard 的版本（garbage ≥ 257 字节、不带可恢复 frame），原用例改名保留作为「能从 sync-loss 中恢复」的正向测试。
3. **补 issue 4**：每个 WARN 路径加 `jest.spyOn(logger, 'warn')` 断言。
4. **顺手改**：issue 1（动态 import 写法）、issue 5（null-chunk 防御）、N1（注释合并）、N3（流尾 WARN 加 hex）。
5. **跑测试**：`npm test -- claude-kiro-parser` 全绿。
6. **实测**：`npm start` → 触发多 tool_use 的 Claude Code 请求 → 看 `[Kiro Stream] Raw stream ended with remaining buffer` 是否基本消失。
7. **抓 fixture**：`KIRO_CAPTURE_RAW=/tmp/kiro-capture.bin npm start` → 移到 `tests/fixtures/kiro-stream/sample-1.bin` → 补 plan 3.3 的 fixture 集成测试（round 2 范畴）。

issue 2/3/4 补完 + 步骤 5/6 实测通过，本轮 plan 即可视为完成。issue 6 / N 项 可作为本 PR 顺手清理或下一个 PR 处理，**不阻塞 merge**。

---

## 结论

**审核结论：通过，附 issue 2/3/4 修订要求。**

- B1/B2/B3 阻塞项全部正确实施
- C/D/N 系列绝大多数已落地
- 实施漏项：D1 注释（issue 2）
- 测试质量问题：sync-loss 路径假绿（issue 3）、WARN 路径无断言（issue 4）
- 其余皆为风格 / 健壮性 / 可读性微调，不阻塞 merge

修订路径短小、风险低，建议**当轮完成**而非推到 round 2。
