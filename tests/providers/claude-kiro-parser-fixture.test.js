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
            expect(events.length).toBeGreaterThan(2);
            assertions(events);
        });
    });
}

fixtureSuite('pure-text', 'pure-text.bin', (events) => {
    const types = new Set(events.map(e => e.type));
    expect(types.has('content')).toBe(true);
    expect(types.has('metering')).toBe(true);
    // [F3]: 非流式聚合路径与流式同源, 都依赖 contextUsage 事件推导 inputTokens
    const ctx = events.filter(e => e.type === 'contextUsage');
    expect(ctx.length).toBeGreaterThanOrEqual(1);
    expect(typeof ctx[0].data.contextUsagePercentage).toBe('number');
    expect(ctx[0].data.contextUsagePercentage).toBeGreaterThan(0);
});

fixtureSuite('reasoning-text', 'reasoning-text.bin', (events) => {
    expect(new Set(events.map(e => e.type)).has('reasoning')).toBe(true);
});

fixtureSuite('single-tool', 'single-tool.bin', (events) => {
    const toolUses = events.filter(e => e.type === 'toolUse');
    expect(toolUses.length).toBeGreaterThanOrEqual(1);
    // Kiro 的 wire shape 把 stop:true 放在 toolUse 帧里，不会触发独立的 toolUseStop 事件
    expect(toolUses.some(e => e.data.stop === true)).toBe(true);
});

fixtureSuite('multi-tool', 'multi-tool.bin', (events) => {
    const toolUses = events.filter(e => e.type === 'toolUse');
    expect(toolUses.length).toBeGreaterThanOrEqual(2);
    expect(events.length).toBeGreaterThan(toolUses.length * 2);
    // [F3]: 非流式 cache 反算依赖 metering + contextUsage 同时存在
    const types = new Set(events.map(e => e.type));
    expect(types.has('metering')).toBe(true);
    expect(types.has('contextUsage')).toBe(true);
});
