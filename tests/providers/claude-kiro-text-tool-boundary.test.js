/**
 * 验证：在 toolUse 边界以及流末尾，generateContentStream 不会丢字。
 *
 * 历史 bug：当 streamApiReal 缓存的 text 末尾命中"反斜杠暂存"或
 * "<thinking> 安全裕量"时，紧接着到来的 toolUse 会直接 stop 文本块，
 * 残留 buffer 永远不会被发出，表现为下游收到的文本"末尾差几个字"。
 */

import { jest } from '@jest/globals';

// 避开 src/utils/tls-sidecar.js 中 import.meta.url 在 babel-jest 转译后为 undefined 导致的副作用 import 失败。
jest.mock('../../src/utils/tls-sidecar.js', () => ({
    __esModule: true,
    getTLSSidecar: () => null,
    default: null,
}));

// 截断依赖链：service-manager 间接拉到 ESM-only 包 `open`，会让 jest 解析失败。
// 测试只用到 KiroApiService 类定义本身，不需要真实 pool manager。
jest.mock('../../src/services/service-manager.js', () => ({
    __esModule: true,
    getProviderPoolManager: () => ({}),
}));

import { KiroApiService } from '../../src/providers/claude/claude-kiro.js';

// 收集 generator 的全部 yield
async function collect(gen) {
    const out = [];
    for await (const ev of gen) out.push(ev);
    return out;
}

// 构造一个绕过初始化的最小 KiroApiService 实例，并用预设事件序列替换 streamApiReal
function makeService(events) {
    const svc = new KiroApiService({});
    svc.isInitialized = true;
    svc.isExpiryDateNear = () => false;
    svc.estimateInputTokens = () => 100;
    svc._markCredentialNeedRefresh = () => {};
    // eslint-disable-next-line require-yield
    svc.streamApiReal = async function* () {
        for (const ev of events) yield ev;
    };
    return svc;
}

function textDeltas(events) {
    return events
        .filter(e => e.type === 'content_block_delta' && e.delta?.type === 'text_delta')
        .map(e => ({ index: e.index, text: e.delta.text }));
}

describe('generateContentStream — 文本/工具边界 flush', () => {
    test('非 thinking：buffer 末尾的反斜杠在 toolUse 到达前被 flush', async () => {
        const events = [
            { type: 'content', content: 'Hello \\' },
            {
                type: 'toolUse',
                toolUse: { name: 'foo', toolUseId: 't1', input: '{"a":1}', stop: true }
            },
            { type: '__kiroStreamEnd', truncated: false }
        ];
        const svc = makeService(events);
        const out = await collect(svc.generateContentStream('claude-sonnet-4-5', {}));

        const concat = textDeltas(out).map(d => d.text).join('');
        expect(concat).toBe('Hello \\');

        // 文本块的 stop 必须出现在 tool_use 的 start 之前
        const toolStartIdx = out.findIndex(
            e => e.type === 'content_block_start' && e.content_block?.type === 'tool_use'
        );
        expect(toolStartIdx).toBeGreaterThan(-1);
        const lastTextStopIdx = out
            .map((e, i) => ({ e, i }))
            .filter(({ e }) =>
                e.type === 'content_block_stop' && textDeltas(out).some(d => d.index === e.index)
            )
            .map(({ i }) => i)
            .pop();
        expect(lastTextStopIdx).toBeLessThan(toolStartIdx);
    });

    test('非 thinking：toolUse 之后再来文本，会开新的 text block（不再向已 stop 的块发 delta）', async () => {
        const events = [
            { type: 'content', content: 'before-tool' },
            {
                type: 'toolUse',
                toolUse: { name: 'foo', toolUseId: 't1', input: '{}', stop: true }
            },
            { type: 'content', content: 'after-tool' },
            { type: '__kiroStreamEnd', truncated: false }
        ];
        const svc = makeService(events);
        const out = await collect(svc.generateContentStream('claude-sonnet-4-5', {}));

        const deltas = textDeltas(out);
        const beforeIdx = deltas.find(d => d.text === 'before-tool')?.index;
        const afterIdx = deltas.find(d => d.text === 'after-tool')?.index;
        expect(beforeIdx).toBeDefined();
        expect(afterIdx).toBeDefined();
        // 关键：两段文本必须落在不同的 content block 上，且 after 的块号更大
        expect(afterIdx).not.toBe(beforeIdx);
        expect(afterIdx).toBeGreaterThan(beforeIdx);

        // 协议正确性：每个收到 delta 的 index 都应有对应的 content_block_start
        const startedIdxs = new Set(
            out.filter(e => e.type === 'content_block_start').map(e => e.index)
        );
        for (const d of deltas) expect(startedIdxs.has(d.index)).toBe(true);
    });

    test('thinking 模式：尚未出现 <thinking> 时的尾部裕量在 toolUse 前被 flush', async () => {
        // 思考模式下，若 content 末尾几字可能是部分 <thinking 的开头，
        // 解析器会把 START_TAG.length(=10) 字节内的尾巴留作"安全裕量"。
        // 当 <thinking> 始终未出现且 toolUse 紧接着到达时，必须把残留作为
        // text_delta flush 出去，而不是丢弃。
        const events = [
            // 9 个非空白字符的尾巴（小于 START_TAG.length=10），会被全数留作裕量。
            // 配合非空白前缀避免被 pendingTextBeforeThinking 吞。
            { type: 'content', content: 'visible:abcdefghi' },
            {
                type: 'toolUse',
                toolUse: { name: 'foo', toolUseId: 't1', input: '{}', stop: true }
            },
            { type: '__kiroStreamEnd', truncated: false }
        ];
        const svc = makeService(events);
        const out = await collect(svc.generateContentStream('claude-sonnet-4-5', {
            thinking: { type: 'enabled', budget_tokens: 1024 }
        }));

        const allText = textDeltas(out).map(d => d.text).join('');
        expect(allText).toBe('visible:abcdefghi');

        // 文本块的 stop 在 tool_use 的 start 之前
        const toolStartIdx = out.findIndex(
            e => e.type === 'content_block_start' && e.content_block?.type === 'tool_use'
        );
        const lastTextStopIdx = out
            .map((e, i) => ({ e, i }))
            .filter(({ e }) =>
                e.type === 'content_block_stop' && textDeltas(out).some(d => d.index === e.index)
            )
            .map(({ i }) => i)
            .pop();
        expect(lastTextStopIdx).toBeLessThan(toolStartIdx);
    });

    test('流末尾兜底：无 toolUse，只有反斜杠暂存，最终也能 flush 出来', async () => {
        const events = [
            { type: 'content', content: 'Done\\' },
            { type: '__kiroStreamEnd', truncated: false }
        ];
        const svc = makeService(events);
        const out = await collect(svc.generateContentStream('claude-sonnet-4-5', {}));

        const concat = textDeltas(out).map(d => d.text).join('');
        expect(concat).toBe('Done\\');

        // 没有工具调用，应当报告 end_turn
        const messageDelta = out.find(e => e.type === 'message_delta');
        expect(messageDelta?.delta?.stop_reason).toBe('end_turn');
    });
});
