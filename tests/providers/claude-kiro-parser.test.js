import { parseAwsEventStreamFrames, normalizeKiroToolInput } from '../../src/providers/claude/aws-event-stream-parser.js';
import logger from '../../src/utils/logger.js';

/**
 * AWS event-stream header encoding:
 *   [name_len:1][name][value_type:1][value_len:2 BE][value]
 * value_type 7 = string
 */
function writeStringHeader(name, valueBytes) {
    const nameBuf = Buffer.from(name, 'ascii');
    const valBuf = Buffer.isBuffer(valueBytes) ? valueBytes : Buffer.from(valueBytes, 'utf8');
    const buf = Buffer.alloc(1 + nameBuf.length + 1 + 2 + valBuf.length);
    let p = 0;
    buf.writeUInt8(nameBuf.length, p); p += 1;
    nameBuf.copy(buf, p); p += nameBuf.length;
    buf.writeUInt8(7, p); p += 1;
    buf.writeUInt16BE(valBuf.length, p); p += 2;
    valBuf.copy(buf, p);
    return buf;
}

function makeFrame(payload, headersBuf = null) {
    const payloadBuf = Buffer.from(payload, 'utf8');
    const headers = headersBuf || Buffer.concat([
        writeStringHeader(':event-type', 'event'),
        writeStringHeader(':content-type', 'application/json'),
        writeStringHeader(':message-type', 'event'),
    ]);
    const totalLen = 12 + headers.length + payloadBuf.length + 4;
    const buf = Buffer.alloc(totalLen);
    buf.writeUInt32BE(totalLen, 0);
    buf.writeUInt32BE(headers.length, 4);
    buf.writeUInt32BE(0, 8);
    headers.copy(buf, 12);
    payloadBuf.copy(buf, 12 + headers.length);
    buf.writeUInt32BE(0, totalLen - 4);
    return buf;
}

describe('parseAwsEventStreamFrames', () => {
    test('单帧 round-trip: content 事件', () => {
        const frame = makeFrame('{"content":"hello"}');
        const { events, remaining } = parseAwsEventStreamFrames(frame);
        expect(events).toEqual([{ type: 'content', data: 'hello' }]);
        expect(remaining.length).toBe(0);
    });

    test('多帧批量: content + reasoning + metering', () => {
        const buf = Buffer.concat([
            makeFrame('{"content":"a"}'),
            makeFrame('{"text":"think"}'),
            makeFrame('{"unit":"tokens","usage":42}'),
        ]);
        const { events, remaining } = parseAwsEventStreamFrames(buf);
        expect(events).toHaveLength(3);
        expect(events[0]).toEqual({ type: 'content', data: 'a' });
        expect(events[1]).toEqual({ type: 'reasoning', data: 'think' });
        expect(events[2]).toEqual({ type: 'metering', data: { unit: 'tokens', usage: 42 } });
        expect(remaining.length).toBe(0);
    });

    test('帧未收完: events 部分产出, remaining 是剩余 Buffer', () => {
        const full = Buffer.concat([makeFrame('{"content":"a"}'), makeFrame('{"content":"b"}')]);
        const truncated = full.subarray(0, full.length - 5);
        const { events, remaining } = parseAwsEventStreamFrames(truncated);
        expect(events).toHaveLength(1);
        expect(events[0].data).toBe('a');
        expect(remaining.length).toBeGreaterThan(0);
    });

    test('帧头数值非法: 跳 1 字节继续找帧', () => {
        const garbage = Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff]);
        const buf = Buffer.concat([garbage, makeFrame('{"content":"ok"}')]);
        const { events } = parseAwsEventStreamFrames(buf);
        expect(events).toHaveLength(1);
        expect(events[0].data).toBe('ok');
    });

    test('sync-loss 未超阈值 → 跳字节后仍能恢复 frame', () => {
        const garbage = Buffer.alloc(200, 0xff);
        const frame = makeFrame('{"content":"x"}');
        const buf = Buffer.concat([garbage, frame]);
        const { events, remaining } = parseAwsEventStreamFrames(buf);
        expect(events).toHaveLength(1);
        expect(events[0].data).toBe('x');
        expect(remaining.length).toBe(0);
    });

    test('sync-loss 超阈值 → 丢弃 buffer + WARN', () => {
        const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
        try {
            // garbage 必须 > Math.max(SYNC_LOSS_WARN_BYTES=256, bufLen*0.10) = 256
            // 且尾部不带可恢复 frame, 否则会先命中 frame, bytesSkipped 被重置
            const garbage = Buffer.alloc(300, 0xff);
            const { events, remaining } = parseAwsEventStreamFrames(garbage);
            expect(events).toEqual([]);
            expect(remaining.length).toBe(0);
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Sync loss exceeded budget'));
        } finally {
            warnSpy.mockRestore();
        }
    });

    test('sync-loss 跳 ≥256 字节后恢复 frame → WARN recovered', () => {
        const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
        try {
            // 256 字节 garbage 不会触发 discard (需要 > 阈值, 实际跳 256 字节命中 frame 时仍未越界)
            // 实际验证: bufLen = 256 + frame_len ≈ 290, 阈值 = max(256, 290*0.1=29) = 256
            // bytesSkipped 累积到 256 时 256 > 256 为 false, 继续; 找到 frame 后 bytesSkipped >= 256 触发 recovered WARN
            const garbage = Buffer.alloc(256, 0xff);
            const frame = makeFrame('{"content":"recovered"}');
            const buf = Buffer.concat([garbage, frame]);
            const { events } = parseAwsEventStreamFrames(buf);
            expect(events).toHaveLength(1);
            expect(events[0].data).toBe('recovered');
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Recovered frame after skipping'));
        } finally {
            warnSpy.mockRestore();
        }
    });

    test('跨 chunk 拼接: 帧中间切, 第二次调用还原', () => {
        const frame = makeFrame('{"content":"split"}');
        const cut = Math.floor(frame.length / 2);
        const part1 = frame.subarray(0, cut);
        const part2 = frame.subarray(cut);

        const r1 = parseAwsEventStreamFrames(part1);
        expect(r1.events).toHaveLength(0);
        expect(r1.remaining.length).toBe(part1.length);

        const combined = Buffer.concat([r1.remaining, part2]);
        const r2 = parseAwsEventStreamFrames(combined);
        expect(r2.events).toHaveLength(1);
        expect(r2.events[0].data).toBe('split');
        expect(r2.remaining.length).toBe(0);
    });

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

    test('空 buffer 返回空结果', () => {
        const { events, remaining } = parseAwsEventStreamFrames(Buffer.alloc(0));
        expect(events).toEqual([]);
        expect(remaining.length).toBe(0);
    });

    test('buffer 小于 prelude 长度时返回整个 buffer 作为 remaining', () => {
        const small = Buffer.from([0x00, 0x00, 0x00]);
        const { events, remaining } = parseAwsEventStreamFrames(small);
        expect(events).toEqual([]);
        expect(remaining.length).toBe(3);
    });
});

describe('事件分发 (payload shape → event type)', () => {
    test('toolUse 事件被正确分类', () => {
        const frame = makeFrame('{"name":"Bash","toolUseId":"t1","input":"ls"}');
        const { events } = parseAwsEventStreamFrames(frame);
        expect(events[0].type).toBe('toolUse');
        expect(events[0].data.name).toBe('Bash');
        expect(events[0].data.toolUseId).toBe('t1');
        expect(events[0].data.input).toBe('ls');
    });

    test('toolUseInput 事件被正确分类', () => {
        const frame = makeFrame('{"toolUseId":"t1","input":"more data"}');
        const { events } = parseAwsEventStreamFrames(frame);
        expect(events[0].type).toBe('toolUseInput');
        expect(events[0].data.input).toBe('more data');
    });

    test('toolUseStop 事件被正确分类', () => {
        const frame = makeFrame('{"stop":true}');
        const { events } = parseAwsEventStreamFrames(frame);
        expect(events[0].type).toBe('toolUseStop');
        expect(events[0].data.stop).toBe(true);
    });

    test('contextUsage 事件被正确分类', () => {
        const frame = makeFrame('{"contextUsagePercentage":75}');
        const { events } = parseAwsEventStreamFrames(frame);
        expect(events[0].type).toBe('contextUsage');
        expect(events[0].data.contextUsagePercentage).toBe(75);
    });

    test('metering 事件被正确分类', () => {
        const frame = makeFrame('{"unit":"credits","usage":100}');
        const { events } = parseAwsEventStreamFrames(frame);
        expect(events[0].type).toBe('metering');
        expect(events[0].data).toEqual({ unit: 'credits', usage: 100 });
    });

    test('非 JSON payload 不抛异常, 返回空 events 且 WARN', () => {
        const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
        try {
            const frame = makeFrame('this is not json at all');
            const { events, remaining } = parseAwsEventStreamFrames(frame);
            expect(events).toEqual([]);
            expect(remaining.length).toBe(0);
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Non-JSON payload frame skipped'));
        } finally {
            warnSpy.mockRestore();
        }
    });
});

describe('normalizeKiroToolInput', () => {
    test('null/undefined → 空字符串', () => {
        expect(normalizeKiroToolInput(null)).toBe('');
        expect(normalizeKiroToolInput(undefined)).toBe('');
    });

    test('string 原样返回', () => {
        expect(normalizeKiroToolInput('hello')).toBe('hello');
    });

    test('object → JSON.stringify', () => {
        expect(normalizeKiroToolInput({ a: 1 })).toBe('{"a":1}');
    });

    test('number → String()', () => {
        expect(normalizeKiroToolInput(42)).toBe('42');
    });
});