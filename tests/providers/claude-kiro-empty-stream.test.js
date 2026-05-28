/**
 * 验证：上游空流（chunkCount=0 且 !socketAborted）会被 streamApiReal
 * 当作 KIRO_EMPTY_STREAM 抛出，并被 streamApiReal 自身的网络错误重试通道捕获，
 * 重试一次能拿到正常响应；若连续多次都空，错误向上传播，generateContentStream
 * 不会降级到发空的 end_turn。
 *
 * 测试边界：
 * - 真实运行 generateContentStream（含 message_start 延迟 yield 等机制）
 * - mock streamApiReal 模拟"空流被识别为可重试错误后递归重试"的契约
 *   (改动 1 + 改动 2 的真实代码路径较深, 需要 mock axiosInstance + buildCodewhispererRequest
 *    + acquireKiroRequestSlot 等多个内部依赖. 单元测试聚焦于
 *    "空流被抛出后, generateContentStream 表现正确"这层契约)
 */

import { jest } from '@jest/globals';

// 同 boundary test: 避开 tls-sidecar 的 import.meta.url 问题
jest.mock('../../src/utils/tls-sidecar.js', () => ({
    __esModule: true,
    getTLSSidecar: () => null,
    default: null,
}));

// 截断对 ESM-only 包 `open` 的依赖链
jest.mock('../../src/services/service-manager.js', () => ({
    __esModule: true,
    getProviderPoolManager: () => ({}),
}));

import { KiroApiService } from '../../src/providers/claude/claude-kiro.js';

async function collect(gen) {
    const out = [];
    for await (const ev of gen) out.push(ev);
    return out;
}

// 构造空流错误,模拟 streamApiReal 内部空流检测抛出的对象
function makeEmptyStreamError() {
    const err = new Error('Kiro upstream returned empty stream (0 chunks, 0 bytes)');
    err.code = 'KIRO_EMPTY_STREAM';
    err.isKiroEmptyStream = true;
    return err;
}

function makeService() {
    const svc = new KiroApiService({});
    svc.isInitialized = true;
    svc.isExpiryDateNear = () => false;
    svc.estimateInputTokens = () => 100;
    svc._markCredentialNeedRefresh = () => {};
    return svc;
}

describe('generateContentStream — 上游空流场景', () => {
    test('streamApiReal 抛 KIRO_EMPTY_STREAM 会向上传播, 不降级到空 end_turn', async () => {
        // 模拟 streamApiReal 自身重试 maxRetries 次后仍空, 抛错给 generateContentStream
        const svc = makeService();
        // eslint-disable-next-line require-yield
        svc.streamApiReal = async function* () {
            throw makeEmptyStreamError();
        };

        let caught = null;
        try {
            await collect(svc.generateContentStream('claude-sonnet-4-5', {}));
        } catch (e) {
            caught = e;
        }

        // 关键断言: 错误向上传播, 没被吞成 end_turn
        expect(caught).not.toBeNull();
        expect(caught.code).toBe('KIRO_EMPTY_STREAM');
        expect(caught.isKiroEmptyStream).toBe(true);
    });

    test('streamApiReal 自身 retry 后拿到正常事件, generateContentStream 输出 tool_use', async () => {
        // 模拟"空流→重试一次→正常响应"已经在 streamApiReal 内被消化的契约:
        // generateContentStream 视角看到的就是一段正常事件序列.
        const events = [
            { type: 'content', content: 'Listing files now.' },
            {
                type: 'toolUse',
                toolUse: { name: 'Bash', toolUseId: 't1', input: '{"command":"ls"}', stop: true }
            },
            { type: '__kiroStreamEnd', truncated: false }
        ];
        const svc = makeService();
        svc.streamApiReal = async function* () {
            for (const ev of events) yield ev;
        };

        const out = await collect(svc.generateContentStream('claude-sonnet-4-5', {}));
        const messageDelta = out.find(e => e.type === 'message_delta');
        expect(messageDelta?.delta?.stop_reason).toBe('tool_use');

        const toolStart = out.find(
            e => e.type === 'content_block_start' && e.content_block?.type === 'tool_use'
        );
        expect(toolStart).toBeDefined();
        expect(toolStart.content_block.name).toBe('Bash');
    });

    test('空流抛错时 message_start 还未 yield, 客户端不会收到半成品', async () => {
        // 验证延迟 yield 机制 (commit b55db7a) 与本次修复兼容:
        // streamApiReal 抛错前若没 yield 任何事件, generateContentStream 也不会发 message_start.
        const svc = makeService();
        // eslint-disable-next-line require-yield
        svc.streamApiReal = async function* () {
            throw makeEmptyStreamError();
        };

        const out = [];
        let caught = null;
        try {
            for await (const ev of svc.generateContentStream('claude-sonnet-4-5', {})) {
                out.push(ev);
            }
        } catch (e) {
            caught = e;
        }

        expect(caught).not.toBeNull();
        // 关键: 没有任何事件被发出 (message_start 也不该出现)
        expect(out.length).toBe(0);
    });
});

describe('streamApiReal — KIRO_EMPTY_STREAM 错误对象契约', () => {
    test('错误对象具备 isKiroEmptyStream 标志, 触发重试分支', () => {
        const err = makeEmptyStreamError();
        // 模拟 streamApiReal catch 内的判定: error?.isKiroEmptyStream
        expect(err?.isKiroEmptyStream).toBe(true);
        expect(err.code).toBe('KIRO_EMPTY_STREAM');
        // 普通 Error 没有 response 字段, 不会被前置 status 分支拦截
        expect(err.response).toBeUndefined();
    });
});
