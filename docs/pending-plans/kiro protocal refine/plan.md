# Kiro 上游 AWS event-stream 解析器重写 (v2.1，已并入 review-1 + review-2)

> **v2 修订记录**（吸收 [docs/pending-plans/kiro protocal refine/review-1.md](docs/pending-plans/kiro protocal refine/review-1.md)）:
> - **B1**：彻底删旧 `parseAwsEventStreamBuffer(string)`，**不保留 wrapper**；测试整体重写；验证步骤 2 改写
> - **B2**：补全 `KiroApiService.parseAwsEventStreamBuffer` 方法委托的迁移路径
> - **B3**：测试 helper 改造为合法 AWS header writer，并显式注入 `0x22 0x5c 0x7b 0x7d` 等问题字节作为 header value
> - **D1**：`Buffer.concat` 每 chunk O(n²) 已知，本轮不优化，加注释 + 上限保护
> - **D2**：sync-loss 跳字节增加**上界 + WARN 阈值**
> - **D3**：payload 非 JSON 时**至少 logger.warn 一条带 header hex 摘要**，避免吞 Kiro error 帧
> - **D4**：`emitEventFromParsed` 加 TODO 注释，标注未来用 `:event-type` 替代 shape 启发式
> - **D5**：fixture 抓取改 `KIRO_CAPTURE_RAW=/path/to/file` 环境变量门控，避免人工删代码
> - **N1-N4**：删 `headersLen < 0` 多余判断、`MAX_FRAME_LEN` 注释、`decoderEnded` 显式列入删除清单、"bufferRemain WARN 消失"措辞收敛
>
> **v2.1 修订记录**（吸收 review-2 非阻塞项，实施时顺手修）:
> - **C1**：`await import('fs')` 移到 for-await 循环外一次性获取，避免热路径每 chunk 动态 import
> - **C2**：`bytesSkipped` 找回帧后**无条件重置为 0**（不论是否超过 WARN 阈值）
> - **C3**：测试 describe 名改为 `'事件分发 (payload shape → event type)'`，不引用内部函数名
> - **C4**：class thin delegator 保留，加一行注释说明理由（便于子类 override / mock）
> - **C5**：验证步骤 4 加前置条件：需先完成步骤 3 确认基本功能正常

---

## Context

[docs/pending-plans/429 cooling/sample-1.md](docs/pending-plans/429 cooling/sample-1.md) 与生产日志 `app-2026-05-15 (2).log:78-82` 共同确认：本项目此前观察到的所有"上游截断"现象（thinking-only / 文本中断 / tool_use 不全 / `output_tokens=0`）的根因不在 Kiro 后端，而在**本地的 AWS event-stream 解析器**。

### 关键证据

```
[Kiro Stream] Raw stream ended with remaining buffer (54288 bytes):
  {<binary>:event-type toolUseEvent:content-type application/json:message-type event{"input":"ler","name":"Agent","toolUseId":"..."}...
[Kiro Stream] Detected truncation: bufferRemain=54288, socketAborted=false
```

- 总流量 85,283 字节中 **54,288 字节（≈64%）解析失败**
- `socketAborted=false` —— 上游正常 FIN，数据完整发完
- 残留 buffer 里清楚可见 `:event-type` / `:content-type` / `:message-type` 等 AWS event-stream 帧头
- `tail.hex` 还原后是结构标准的完整帧：`[total_len:4][headers_len:4][prelude_crc:4][headers...][payload(JSON)][message_crc:4]`

### 根本原因

[src/providers/claude/aws-event-stream-parser.js:25-118](src/providers/claude/aws-event-stream-parser.js#L25-L118) 用 `indexOf('{')` + brace 计数 + 字符串/转义状态机解析，**完全忽略 AWS event-stream 帧结构**。AWS 帧 header 段是二进制，可能随机出现 `0x22 (")` / `0x5c (\)` / `0x7b ({)` / `0x7d (})`，当 binary header 里碰巧出现 `"`，状态机进入 `inString=true`，后续 `{`/`}` 全被吞，brace 永远不平衡 → 当前帧解析失败 → searchStart 推进 1 字节 → 下一帧又撞同样问题 → buffer 越积越多。

雪上加霜：[src/providers/claude/claude-kiro.js:2223,2264](src/providers/claude/claude-kiro.js#L2223) 用 `StringDecoder('utf8')` 把 chunk 预先 UTF-8 解码，二进制 header 字节在 0x80-0xff 范围会被识别为非法 UTF-8 被替换为 U+FFFD，**从字节流上破坏了帧的可恢复性**。

---

## 关键文件

- [src/providers/claude/aws-event-stream-parser.js](src/providers/claude/aws-event-stream-parser.js) —— 解析器主体重写
- [src/providers/claude/claude-kiro.js](src/providers/claude/claude-kiro.js) —— 调用方 chunk 处理改 Buffer
- [tests/providers/claude-kiro-parser.test.js](tests/providers/claude-kiro-parser.test.js) —— 单元测试整体重写
- [tests/fixtures/kiro-stream/](tests/fixtures/kiro-stream/) —— 现为空，需新增真实帧 fixture

### 现有调用点全集（B2 调查结果）

```
src/providers/claude/aws-event-stream-parser.js:25    export function parseAwsEventStreamBuffer
src/providers/claude/claude-kiro.js:24                import { parseAwsEventStreamBuffer as awsParseEventStreamBuffer }
src/providers/claude/claude-kiro.js:2165-2168         class method parseAwsEventStreamBuffer (thin delegator)
src/providers/claude/claude-kiro.js:2267              this.parseAwsEventStreamBuffer(buffer) 流式调用
tests/providers/claude-kiro-parser.test.js (多处)      直接 import 测试
```

无其他生产调用方。

---

## 改动 1：parser 模块重写

[src/providers/claude/aws-event-stream-parser.js](src/providers/claude/aws-event-stream-parser.js)：

- **新增** `parseAwsEventStreamFrames(buf: Buffer): { events, remaining: Buffer }`
- **删除** `parseAwsEventStreamBuffer(string)`，**不保留 wrapper**
- **保留** `normalizeKiroToolInput`
- **新增** `emitEventFromParsed(parsed, events)`：把现有事件分发 if/else 链（[aws-event-stream-parser.js:73-112](src/providers/claude/aws-event-stream-parser.js#L73-L112)）抽出来，便于未来替换分发逻辑

```js
const PRELUDE_LEN = 12;     // total_len(4) + headers_len(4) + prelude_crc(4)
const MSG_CRC_LEN = 4;
const MIN_FRAME_LEN = PRELUDE_LEN + MSG_CRC_LEN;  // 16: 空 header 空 payload
// AWS event-stream 协议规定单帧最大 16MB (AWS Encore SDK 同上界)
const MAX_FRAME_LEN = 16 * 1024 * 1024;
// 同步丢失保护：一次 parse 调用累计跳字节超此比例就放弃整 buffer
const MAX_SYNC_LOSS_RATIO = 0.10;
// 单次跳字节告警阈值
const SYNC_LOSS_WARN_BYTES = 256;

export function parseAwsEventStreamFrames(buf) {
    const events = [];
    let pos = 0;
    let bytesSkipped = 0;
    const totalLen0 = buf.length;

    while (pos + PRELUDE_LEN <= buf.length) {
        const totalLen = buf.readUInt32BE(pos);
        const headersLen = buf.readUInt32BE(pos + 4);

        // sanity check（注：UInt32BE 不可能为负，无需 < 0 判断）
        if (totalLen < MIN_FRAME_LEN || totalLen > MAX_FRAME_LEN
            || headersLen > totalLen - MIN_FRAME_LEN) {
            pos += 1;
            bytesSkipped += 1;
            // D2: sync-loss 上界保护
            if (bytesSkipped > Math.max(SYNC_LOSS_WARN_BYTES, totalLen0 * MAX_SYNC_LOSS_RATIO)) {
                logger.warn(`[Kiro Parse] Sync loss exceeded budget (skipped=${bytesSkipped}, bufLen=${totalLen0}); discarding remaining buffer`);
                return { events, remaining: Buffer.alloc(0) };
            }
            continue;
        }

        // 帧不完整：等下次 chunk
        if (pos + totalLen > buf.length) break;

        // C2: 找回帧后无条件重置（不论是否超过 WARN 阈值）
        if (bytesSkipped > 0) {
            if (bytesSkipped >= SYNC_LOSS_WARN_BYTES) {
                logger.warn(`[Kiro Parse] Recovered frame after skipping ${bytesSkipped} bytes`);
            }
            bytesSkipped = 0;
        }

        // payload 区域: [pos+12+headersLen, pos+totalLen-4)
        const payloadStart = pos + PRELUDE_LEN + headersLen;
        const payloadEnd = pos + totalLen - MSG_CRC_LEN;
        const payloadBuf = buf.subarray(payloadStart, payloadEnd);
        const payload = payloadBuf.toString('utf8');

        try {
            const parsed = JSON.parse(payload);
            emitEventFromParsed(parsed, events);
        } catch (e) {
            // D3: 非 JSON payload 至少 WARN，不静默吞
            // Kiro 的 error / exception 控制帧 payload 可能不是 JSON
            const headerHex = buf.subarray(pos + PRELUDE_LEN, payloadStart).toString('hex').substring(0, 200);
            const payloadPreview = payload.substring(0, 200);
            logger.warn(`[Kiro Parse] Non-JSON payload frame skipped (payloadLen=${payloadBuf.length}, headerHex=${headerHex}, payloadPreview=${JSON.stringify(payloadPreview)})`);
        }

        pos += totalLen;
    }
    return { events, remaining: buf.subarray(pos) };
}

function emitEventFromParsed(parsed, events) {
    // TODO(D4): 未来应改用 :event-type header 做分发，比 payload shape 启发式更权威。
    // 现阶段沿用 shape 判断保持行为兼容。
    if (parsed.content !== undefined && !parsed.followupPrompt) {
        events.push({ type: 'content', data: parsed.content });
    } else if (typeof parsed.text === 'string' && !parsed.name && !parsed.toolUseId && parsed.content === undefined) {
        events.push({ type: 'reasoning', data: parsed.text });
    } else if (parsed.name && parsed.toolUseId) {
        events.push({ type: 'toolUse', data: { name: parsed.name, toolUseId: parsed.toolUseId, input: normalizeKiroToolInput(parsed.input), stop: parsed.stop || false } });
    } else if (parsed.input !== undefined && !parsed.name) {
        events.push({ type: 'toolUseInput', data: { toolUseId: parsed.toolUseId, input: normalizeKiroToolInput(parsed.input) } });
    } else if (parsed.stop !== undefined && parsed.contextUsagePercentage === undefined) {
        events.push({ type: 'toolUseStop', data: { stop: parsed.stop } });
    } else if (parsed.contextUsagePercentage !== undefined) {
        events.push({ type: 'contextUsage', data: { contextUsagePercentage: parsed.contextUsagePercentage } });
    } else if (parsed.unit !== undefined && parsed.usage !== undefined) {
        events.push({ type: 'metering', data: { unit: parsed.unit, usage: parsed.usage } });
    } else {
        logger?.debug?.('[Kiro Parse] Unrecognized event JSON:', JSON.stringify(parsed).substring(0, 500));
    }
}
```

### 不做 CRC 校验

AWS SDK 默认也不在应用层强制 CRC；引入 CRC32 polyfill 性价比低；容错策略（sync-loss 上界）已能从坏帧恢复。

---

## 改动 2：claude-kiro.js 流式 chunk 处理改 Buffer

### 2.1 导入与类方法迁移（B2）

[claude-kiro.js:24](src/providers/claude/claude-kiro.js#L24)：
```js
- import { parseAwsEventStreamBuffer as awsParseEventStreamBuffer } from './aws-event-stream-parser.js';
+ import { parseAwsEventStreamFrames as awsParseEventStreamFrames } from './aws-event-stream-parser.js';
```

[claude-kiro.js:2165-2168](src/providers/claude/claude-kiro.js#L2165-L2168) 类方法整体重命名 + 委托新函数：
```js
- parseAwsEventStreamBuffer(buffer) {
-     return awsParseEventStreamBuffer(buffer);
- }
+ // C4: 保留 thin delegator 便于子类 override 和测试 mock
+ parseAwsEventStreamFrames(buf) {
+     return awsParseEventStreamFrames(buf);
+ }
```

[claude-kiro.js:2267](src/providers/claude/claude-kiro.js#L2267) 调用点：
```js
- const { events, remaining } = this.parseAwsEventStreamBuffer(buffer);
+ const { events, remaining } = this.parseAwsEventStreamFrames(buffer);
```

### 2.2 chunk 处理改 Buffer（核心）

[claude-kiro.js:2223-2306](src/providers/claude/claude-kiro.js#L2223-L2306)：

**删除清单（N3 显式列出）**：
- `import { StringDecoder } from 'string_decoder'`（L11，grep 确认无其他用法后删）
- `const decoder = new StringDecoder('utf8')`（L2223）
- `let decoderEnded = false`（L2226）
- `buffer += decoder.write(chunk)`（L2264）
- `buffer += decoder.end()`（L2289, L2294，包括 try/finally 兜底）

**新增/改写**：
```js
let buffer = Buffer.alloc(0);
let lastRawChunk = null;        // 已存在，保留
let totalRawBytes = 0;
let chunkCount = 0;

// D5: fixture 捕获开关，由环境变量门控，常驻仓库无副作用
const captureRawPath = process.env.KIRO_CAPTURE_RAW;
let captureFs = null;  // C1: 循环外一次性获取，避免热路径每 chunk 动态 import
if (captureRawPath) {
    captureFs = await import('fs');
    logger.info(`[Kiro Stream] KIRO_CAPTURE_RAW enabled, writing to ${captureRawPath}`);
}

for await (const chunk of stream) {
    const chunkBuf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

    // D5: 抓 fixture（仅当环境变量设置时）
    if (captureFs) {
        try {
            captureFs.appendFileSync(captureRawPath, chunkBuf);
        } catch (e) { logger.warn(`[Kiro Stream] KIRO_CAPTURE_RAW write failed: ${e.message}`); }
    }

    lastRawChunk = chunkBuf;
    totalRawBytes += chunkBuf.length;
    chunkCount += 1;

    // D1: 已知 O(n²) 拼接，本轮不做 BufferList 优化；
    // 当前样本量（< 1MB）无感，未来若日志显示 totalRawBytes > 10MB 才需要重构
    buffer = buffer.length === 0 ? chunkBuf : Buffer.concat([buffer, chunkBuf]);

    const { events, remaining } = this.parseAwsEventStreamFrames(buffer);
    buffer = remaining;
    // ... events 分发逻辑不变
}

// 流尾诊断：buffer.length / lastRawChunk hex 等保留
if (buffer.length > 0) {
    logger.warn(`[Kiro Stream] Raw stream ended with remaining buffer (${buffer.length} bytes): ${buffer.subarray(0, 200).toString('utf8')}`);
}
```

注：payload UTF-8 解码在帧内做（`payloadBuf.toString('utf8')`），不存在跨 chunk 多字节字符问题——因为 AWS 帧 boundary 总是在 payload 之后/之前，不会切到 UTF-8 字符中间。

---

## 改动 3：单元测试整体重写

[tests/providers/claude-kiro-parser.test.js](tests/providers/claude-kiro-parser.test.js) **整体重写**（旧用例基于 string + 无帧前提，与新 API 不匹配，全部删除）。

### 3.1 测试 helper（B3 重点）

构造**完全合法**的 AWS event-stream 帧 Buffer，header 可显式注入任意字节：

```js
/**
 * AWS event-stream header 编码:
 *   [name_len:1][name][value_type:1][value_len:2 BE][value]
 * value_type 7 = string
 */
function writeStringHeader(name, valueBytes) {
    const nameBuf = Buffer.from(name, 'ascii');
    const valBuf = Buffer.isBuffer(valueBytes) ? valueBytes : Buffer.from(valueBytes, 'binary');
    const buf = Buffer.alloc(1 + nameBuf.length + 1 + 2 + valBuf.length);
    let p = 0;
    buf.writeUInt8(nameBuf.length, p); p += 1;
    nameBuf.copy(buf, p); p += nameBuf.length;
    buf.writeUInt8(7, p); p += 1;                  // string type
    buf.writeUInt16BE(valBuf.length, p); p += 2;
    valBuf.copy(buf, p);
    return buf;
}

function makeFrame(payload, headersBuf = null) {
    const payloadBuf = Buffer.from(payload, 'utf8');
    const defaultHeaders = headersBuf || Buffer.concat([
        writeStringHeader(':event-type', 'event'),
        writeStringHeader(':content-type', 'application/json'),
        writeStringHeader(':message-type', 'event'),
    ]);
    const totalLen = 12 + defaultHeaders.length + payloadBuf.length + 4;
    const buf = Buffer.alloc(totalLen);
    buf.writeUInt32BE(totalLen, 0);
    buf.writeUInt32BE(defaultHeaders.length, 4);
    buf.writeUInt32BE(0, 8);          // prelude_crc 占位
    defaultHeaders.copy(buf, 12);
    payloadBuf.copy(buf, 12 + defaultHeaders.length);
    buf.writeUInt32BE(0, totalLen - 4);  // msg_crc 占位
    return buf;
}
```

### 3.2 用例集

```js
describe('parseAwsEventStreamFrames', () => {
    test('单帧 round-trip: content 事件', () => { ... });
    test('多帧批量: content + toolUse + metering', () => { ... });
    test('帧未收完: events 部分产出, remaining 是剩余 Buffer', () => {
        const full = Buffer.concat([makeFrame('{"content":"a"}'), makeFrame('{"content":"b"}')]);
        const truncated = full.subarray(0, full.length - 5);  // 切掉最后一帧的尾巴
        const { events, remaining } = parseAwsEventStreamFrames(truncated);
        expect(events).toHaveLength(1);
        expect(remaining.length).toBeGreaterThan(0);
    });
    test('帧头数值非法: 跳 1 字节继续找帧', () => {
        const garbage = Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff]);
        const buf = Buffer.concat([garbage, makeFrame('{"content":"ok"}')]);
        const { events } = parseAwsEventStreamFrames(buf);
        expect(events).toHaveLength(1);
    });
    test('sync-loss 超 10% 时丢弃 buffer + WARN', () => { ... });
    test('跨 chunk 拼接: 帧中间切, 第二次调用还原', () => { ... });

    // === B3 核心回归用例 ===
    test('header value 含 0x22 0x5c 0x7b 0x7d 字节, payload 仍能正确解出', () => {
        const evilHeader = writeStringHeader(':custom', Buffer.from([0x22, 0x5c, 0x7b, 0x7d, 0x22, 0x7b]));
        const headers = Buffer.concat([
            writeStringHeader(':event-type', 'event'),
            evilHeader,
        ]);
        const frame = makeFrame('{"content":"survived"}', headers);
        const { events, remaining } = parseAwsEventStreamFrames(frame);
        expect(events).toEqual([{ type: 'content', data: 'survived' }]);
        expect(remaining.length).toBe(0);
    });
});

describe('事件分发 (payload shape → event type)', () => {
    test('toolUse / toolUseInput / toolUseStop 各自被正确分类', () => { ... });
    test('contextUsagePercentage / metering 区分', () => { ... });
    test('非 JSON payload 触发 WARN 日志 (mock logger 断言)', () => { ... });
});
```

### 3.3 Fixture 集成测试

按用户决定，**用 `KIRO_CAPTURE_RAW` 环境变量门控（D5）**：

1. 跑 `KIRO_CAPTURE_RAW=/tmp/kiro-capture.bin npm start`，发一次完整的 Claude Code 请求（含 thinking + tool_use + 文本响应）
2. 把 `/tmp/kiro-capture.bin` 移到 `tests/fixtures/kiro-stream/sample-1.bin`
3. 写测试：
   ```js
   describe('parseAwsEventStreamFrames fixture', () => {
       test('真实 Kiro 响应完整解析, 无 remaining', () => {
           const fixture = fs.readFileSync('tests/fixtures/kiro-stream/sample-1.bin');
           const { events, remaining } = parseAwsEventStreamFrames(fixture);
           expect(remaining.length).toBe(0);              // 完整解析
           expect(events.length).toBeGreaterThan(20);     // 至少 20 个事件
           // 反向断言（N9）：不是因为提前 break 而是真正解完
           const types = new Set(events.map(e => e.type));
           expect(types.has('content') || types.has('reasoning')).toBe(true);
           expect(types.has('metering')).toBe(true);      // 流末通常有 metering
       });
   });
   ```

---

## 验证步骤

1. **静态自查**：
   - `grep parseAwsEventStreamFrames src/ tests/` 至少在 parser/claude-kiro/test 各出现
   - `grep parseAwsEventStreamBuffer src/ tests/` 应为空（已完全删除）
   - `grep StringDecoder src/providers/claude/claude-kiro.js` 应为空
2. **跑新测试**：`npm test -- claude-kiro-parser` 全绿（旧用例已删，新用例覆盖合成帧 + B3 回归 + fixture）
3. **运行项目**：`npm start`
4. **抓 fixture**（C5: 前置条件——步骤 3 确认 `npm start` 能正常启动且基本请求不报错后再执行）：`KIRO_CAPTURE_RAW=/tmp/kiro-capture.bin npm start`，跑一次 Claude Code 请求，搬到 `tests/fixtures/`
5. **复现原 bug 场景**：用 Claude Code 发触发多 tool_use 的请求
6. **观察日志**，确认：
   - `[Kiro Stream] Raw stream ended with remaining buffer (X bytes)` 基本消失（最多残留 < 1 帧大小，N4）
   - `[Kiro Stream] Detected truncation: bufferRemain>0, socketAborted=false` 不再出现
   - tool_use / thinking-only / `output_tokens=0` 等历史现象不再发生
7. **回归**：跑常规 Claude Code 任务（写代码、读文件、grep），确认无新引入的解析错误
8. **字节级回归（B3 验证）**：单测里的 "header value 含 0x22 0x5c 0x7b 0x7d" 用例必须通过——这是本次 bug 的最小复现
9. **Fixture 反向断言**：除了 `remaining.length === 0`，还断言 events 含 `metering` 等至少 1 个 —— 确保不是因为提前 break 而 remaining=0

---

## 不在本次范围

- **CRC 校验**：AWS SDK 默认也跳，容错策略已能恢复
- **AWS header 完整解析 + `:event-type` 驱动事件分发**：本轮仍用 payload shape 启发式（保持行为兼容），TODO 注释已在 `emitEventFromParsed` 顶部留下（D4），下个 release 处理
- **`Buffer.concat` O(n²) 优化**：当前样本 < 1MB 无感，留注释 + 上限保护（D1），未来超 10MB 再用 BufferList 重构
- **`isQuotaExhausted` 未使用** 的 TS 诊断（与本次无关）

---

## 预期影响

修复后：

- 所有"莫名截断"现象（thinking-only / 文本中断 / tool_use 不全 / `output_tokens=0`）**应基本消除**（N4 收敛措辞：极端边角下，最后 1 帧未收完 + socket FIN 可能短暂残留 < 1 帧大小）
- 解析器对 binary header 字节免疫
- Kiro 的 error / exception 控制帧不再被静默吞，转为 WARN 日志便于排查（D3）
- sync-loss 场景有明确保护和告警，不会让脏 buffer 永远卡死后续 chunk（D2）
- fixture 抓取流程不再依赖人工删代码（D5）

---

# Round 2: Fixture 抓取与集成测试 (轻量方案)

## R2 Context

Round 1 完成解析器重写并经用户实测有效，并在 [docs/pending-plans/kiro protocal refine/code-review-1.md](docs/pending-plans/kiro protocal refine/code-review-1.md) 的 issue 2/3/4 全部修订完成（21/21 测试通过）。Round 2 补完 plan 3.3 主动延后的 fixture 集成测试。

当前 `KIRO_CAPTURE_RAW` 语义有缺陷：`appendFileSync` + 单一固定路径意味着**多次请求的 chunk 会串成同一个 .bin**，整体既不是合法单 stream，也不能被 `parseAwsEventStreamFrames(buf)` 当 fixture 解。

走轻量路径：把 `KIRO_CAPTURE_RAW` 改成"目录路径"，每请求一文件；不引入管理端 UI（UI 方案另起 PR）。

## R2 改动

### R2-1: capture 机制改造 — 目录语义 + 每请求一文件

复用 [claude-kiro.js:2196](src/providers/claude/claude-kiro.js#L2196) 已经生成的 `amz-sdk-invocation-id` uuid 作为请求 ID。

**Step 1**：把 [claude-kiro.js:2196-2198](src/providers/claude/claude-kiro.js#L2196-L2198) 的 uuid 提到局部变量，方便后面文件名复用：

```js
const invocationId = uuidv4();
const headers = {
    'Authorization': `Bearer ${token}`,
    'amz-sdk-invocation-id': invocationId,
};
```

**Step 2**：[claude-kiro.js:2228-2234](src/providers/claude/claude-kiro.js#L2228-L2234) capture 初始化改 directory 语义：

```js
const captureRawDir = process.env.KIRO_CAPTURE_RAW;
let captureFs = null;
let captureFilePath = null;
if (captureRawDir) {
    const fsModule = await import('fs');
    captureFs = fsModule.default || fsModule;
    captureFs.mkdirSync(captureRawDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    captureFilePath = `${captureRawDir}/kiro-${stamp}-${invocationId.substring(0, 8)}.bin`;
    logger.info(`[Kiro Stream] KIRO_CAPTURE_RAW enabled, writing to ${captureFilePath}`);
}
```

**Step 3**：[claude-kiro.js:2269-2270](src/providers/claude/claude-kiro.js#L2269-L2270) chunk 写入改用 `captureFilePath`：

```js
if (captureFs && captureFilePath) {
    try { captureFs.appendFileSync(captureFilePath, chunkBuf); } catch (e) { /* ignore */ }
}
```

**不保留对"单文件路径"的向后兼容**：`KIRO_CAPTURE_RAW` 是 round 1 才新增，未正式发布，无外部用户依赖。

### R2-2: 新增 fixture 集成测试 — `describe.skip` 优雅降级

新文件 `tests/providers/claude-kiro-parser-fixture.test.js`。

如果对应 fixture 不存在，对应 suite 自动 skip，避免 CI 在 fixture 提交前红灯。

```js
import * as fs from 'fs';
import * as path from 'path';
import { parseAwsEventStreamFrames } from '../../src/providers/claude/aws-event-stream-parser.js';

const FIXTURE_DIR = path.join(process.cwd(), 'tests/fixtures/kiro-stream');

function fixtureSuite(name, file, assertions) {
    const filePath = path.join(FIXTURE_DIR, file);
    const d = fs.existsSync(filePath) ? describe : describe.skip;
    d(`fixture: ${name}`, () => {
        test('完整解析无 remaining + 场景断言', () => {
            const buf = fs.readFileSync(filePath);
            const { events, remaining } = parseAwsEventStreamFrames(buf);
            expect(remaining.length).toBe(0);
            // 反向断言：events 数量必须显著大于 0，避免「提前 break + remaining=0」的虚假绿
            expect(events.length).toBeGreaterThan(2);
            assertions(events);
        });
    });
}

fixtureSuite('pure-text', 'pure-text.bin', (events) => {
    const types = new Set(events.map(e => e.type));
    expect(types.has('content')).toBe(true);
    expect(types.has('metering')).toBe(true);
});

fixtureSuite('reasoning-text', 'reasoning-text.bin', (events) => {
    expect(new Set(events.map(e => e.type)).has('reasoning')).toBe(true);
});

fixtureSuite('single-tool', 'single-tool.bin', (events) => {
    expect(events.filter(e => e.type === 'toolUse').length).toBeGreaterThanOrEqual(1);
    expect(events.filter(e => e.type === 'toolUseStop').length).toBeGreaterThanOrEqual(1);
});

fixtureSuite('multi-tool', 'multi-tool.bin', (events) => {
    const toolUses = events.filter(e => e.type === 'toolUse');
    expect(toolUses.length).toBeGreaterThanOrEqual(2);   // 原 bug 复现场景
    expect(events.length).toBeGreaterThan(toolUses.length * 2);
});
```

### R2-3: gitignore 检查

[.gitignore](.gitignore) 当前忽略 `logs/` `node_modules`、各类 token / config。`tests/fixtures/kiro-stream/*.bin` 不在忽略列表内，默认会被 git add（这是期望行为）。临时抓取目录 `/tmp/kiro-capture/` 在 `/tmp` 下，不需要 ignore。无需改动。

## R2 验证步骤

1. **改造代码** R2-1（3 处 edit），跑：`npx jest tests/providers/claude-kiro-parser.test.js --no-coverage` 21/21 应继续通过（不影响 round 1 测试）
2. **新增 fixture 测试文件** R2-2，跑：`npx jest tests/providers/claude-kiro-parser-fixture.test.js --no-coverage` 此时 4 个 suite 全部 `skipped`（fixture 还没抓）
3. **抓 fixture**（用户操作）：
   ```bash
   mkdir -p /tmp/kiro-capture
   KIRO_CAPTURE_RAW=/tmp/kiro-capture npm start
   ```
4. **顺序触发 4 个场景**（每个等响应完成再发下一个，避免文件命名时间戳冲突）：
   - **pure-text**：问 "什么是闭包"
   - **reasoning-text**：让 Claude 分析 "归并排序的时间复杂度推导"（鼓励 thinking）
   - **single-tool**：让 Claude "读 README.md 第一段"
   - **multi-tool**：让 Claude "grep 项目里所有 logger.warn 然后告诉我前 3 处"（**只读不写**）
5. **整理为 fixture**：
   ```bash
   ls -lat /tmp/kiro-capture/   # 按时间倒序，最新在上
   mkdir -p tests/fixtures/kiro-stream
   # 按抓取时间从老到新匹配上面 4 个场景，重命名搬过去：
   cp /tmp/kiro-capture/<场景1的bin> tests/fixtures/kiro-stream/pure-text.bin
   cp /tmp/kiro-capture/<场景2的bin> tests/fixtures/kiro-stream/reasoning-text.bin
   cp /tmp/kiro-capture/<场景3的bin> tests/fixtures/kiro-stream/single-tool.bin
   cp /tmp/kiro-capture/<场景4的bin> tests/fixtures/kiro-stream/multi-tool.bin
   ```
6. **跑 fixture 测试**：`npx jest tests/providers/claude-kiro-parser-fixture.test.js --no-coverage` 4 个 suite 应全绿，**无 skipped**
7. **跑全量测试**：`npm test` 应无解析器相关回归
8. **检查 fixture 大小**：`ls -la tests/fixtures/kiro-stream/` 单文件 < 100 KB（避免仓库膨胀）；超大就重抓更精简的场景
9. **commit**：fixture .bin + R2 代码改动 + 测试文件一起 commit，进入 PR

## R2 范围外（明确推迟）

- **管理端 UI 抓取面板**：另起 PR；初版方案见上一轮回复（fixture-capture.js + section-fixtures.html + 内存开关 + 列表/下载/删除）
- **PII 内容审查**：用户决定跳过
- **抓取磁盘上限保护**：轻量方案不实现，依赖手动控制（`/tmp` 满了系统会抗议）
- **多 provider 复用 capture 抽象**：UI 方案才需要；当前 Kiro 单 provider 用环境变量足够