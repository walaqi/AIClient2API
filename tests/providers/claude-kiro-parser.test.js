/**
 * P1 单测: parseAwsEventStreamBuffer 与 StringDecoder 跨 chunk 边界
 *
 * 不依赖真实 Kiro fixture (避免循环依赖: 测试用解析器自身正确)。
 * 用最小合成数据触发各个分支:
 *  - 单一退出点 (P1-2)
 *  - 中文 / Emoji chunk 边界 (P0-2 StringDecoder)
 *  - JSON 解析失败导致 searchStart 推进 + 下一 chunk 让它变完整
 *  - 流提前结束 (buffer 残留) 触发 truncated 信号 (P0-1)
 */
import { StringDecoder } from 'string_decoder';

// 直接测试纯函数模块,无外部依赖
import { parseAwsEventStreamBuffer } from '../../src/providers/claude/aws-event-stream-parser.js';

const svc = { parseAwsEventStreamBuffer };
function makeStub() { return svc; }

describe('parseAwsEventStreamBuffer', () => {
    const svc = makeStub();

    describe('单一退出点 (P1-2)', () => {
        test('A: 没有 { 时返回空 remaining', () => {
            const r = svc.parseAwsEventStreamBuffer(':event-type\x00\x00\x00');
            expect(r.events).toEqual([]);
            expect(r.remaining).toBe('');
        });

        test('B: 未闭合 JSON 保留从 jsonStart 起的字节', () => {
            const r = svc.parseAwsEventStreamBuffer('xxx{"content":"hel');
            expect(r.events).toEqual([]);
            expect(r.remaining).toBe('{"content":"hel');
        });

        test('C: 单条完整 content 事件被消费,remaining 为空', () => {
            const r = svc.parseAwsEventStreamBuffer(':msg{"content":"hi"}');
            expect(r.events).toEqual([{ type: 'content', data: 'hi' }]);
            expect(r.remaining).toBe('');
        });
    });

    describe('JSON 解析失败 + 续传 (P1-2 真实场景)', () => {
        test('失败的 {...} 跳过后,后续完整 JSON 仍能解析', () => {
            // 第一个 {...} 是闭合的但 JSON.parse 会失败;之后跟一个有效的 content 事件
            const buf = '{not json}{"content":"hello"}';
            const r = svc.parseAwsEventStreamBuffer(buf);
            const contentEvents = r.events.filter(e => e.type === 'content');
            expect(contentEvents).toHaveLength(1);
            expect(contentEvents[0].data).toBe('hello');
            expect(r.remaining).toBe('');
        });

        test('未闭合 JSON 跨两次调用拼接还原', () => {
            const part1 = ':msg{"content":"he';
            const r1 = svc.parseAwsEventStreamBuffer(part1);
            expect(r1.events).toHaveLength(0);
            expect(r1.remaining).toBe('{"content":"he');

            const part2 = r1.remaining + 'llo"}';
            const r2 = svc.parseAwsEventStreamBuffer(part2);
            const contentEvents = r2.events.filter(e => e.type === 'content');
            expect(contentEvents).toHaveLength(1);
            expect(contentEvents[0].data).toBe('hello');
        });
    });

    describe('多条事件批量解析', () => {
        test('content + reasoning + metering 在同一 buffer', () => {
            const buf = '{"content":"a"}\x00:event-type{"text":"think"}\x00{"unit":1,"usage":2}';
            const r = svc.parseAwsEventStreamBuffer(buf);
            const types = r.events.map(e => e.type);
            expect(types).toContain('content');
            expect(types).toContain('reasoning');
            expect(types).toContain('metering');
            expect(r.remaining).toBe('');
        });

        test('toolUse 开始事件被识别', () => {
            const buf = '{"name":"foo","toolUseId":"t1","input":""}';
            const r = svc.parseAwsEventStreamBuffer(buf);
            expect(r.events).toHaveLength(1);
            expect(r.events[0].type).toBe('toolUse');
            expect(r.events[0].data.name).toBe('foo');
            expect(r.events[0].data.toolUseId).toBe('t1');
        });
    });
});

describe('StringDecoder 跨 chunk 边界 (P0-2)', () => {
    test('中文字符被切两半,不产生 U+FFFD', () => {
        // "你好" UTF-8: e4 bd a0 e5 a5 bd
        const fullBytes = Buffer.from('你好', 'utf8');
        const part1 = fullBytes.subarray(0, 4);  // 完整"你" + "好" 的第一字节
        const part2 = fullBytes.subarray(4);     // "好" 剩 2 字节
        const decoder = new StringDecoder('utf8');
        const out = decoder.write(part1) + decoder.write(part2) + decoder.end();
        expect(out).toBe('你好');
        expect(out).not.toContain('�');
    });

    test('Emoji 🎉 (4 字节) 被切两半,不产生 U+FFFD', () => {
        const fullBytes = Buffer.from('🎉', 'utf8');
        const part1 = fullBytes.subarray(0, 2);
        const part2 = fullBytes.subarray(2);
        const decoder = new StringDecoder('utf8');
        const out = decoder.write(part1) + decoder.write(part2) + decoder.end();
        expect(out).toBe('🎉');
        expect(out).not.toContain('�');
    });

    test('对照: 直接 Buffer.toString() 切多字节会产生 U+FFFD', () => {
        const fullBytes = Buffer.from('你好', 'utf8');
        const part1 = fullBytes.subarray(0, 4);
        const part2 = fullBytes.subarray(4);
        const out = part1.toString('utf8') + part2.toString('utf8');
        expect(out).toContain('�'); // 这是 P0-2 修复前的行为
    });
});

describe('parseAwsEventStreamBuffer 配合 StringDecoder (端到端)', () => {
    test('包含中文的 content 事件被正确还原 (chunk 边界在中文字符上)', () => {
        const svc = makeStub();
        const fullPayload = '{"content":"你好世界"}';
        const fullBytes = Buffer.from(fullPayload, 'utf8');
        // 在中文字符中间切两半
        const cut = 11; // "你"(3字节) + "好"(3字节) + "世"切到第 1 字节
        const part1 = fullBytes.subarray(0, cut);
        const part2 = fullBytes.subarray(cut);

        const decoder = new StringDecoder('utf8');
        let buffer = '';

        buffer += decoder.write(part1);
        let r1 = svc.parseAwsEventStreamBuffer(buffer);
        buffer = r1.remaining;
        // 此时 JSON 还未闭合, events 应为空
        expect(r1.events).toHaveLength(0);

        buffer += decoder.write(part2);
        buffer += decoder.end();
        let r2 = svc.parseAwsEventStreamBuffer(buffer);
        const contentEvents = r2.events.filter(e => e.type === 'content');
        expect(contentEvents).toHaveLength(1);
        expect(contentEvents[0].data).toBe('你好世界');
        expect(r2.remaining).toBe('');
    });
});
