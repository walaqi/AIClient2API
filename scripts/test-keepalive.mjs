// SSE keep-alive 行为测试脚本 (绕过 jest/babel import.meta.url 阻塞)
// 直接驱动 src/utils/common.js handleStreamRequest, mock res / service。
//
// 场景:
//   A. 慢启动 — 上游延迟 2.5s 才 yield 首事件, keep-alive 间隔 1s,
//      期望写出 ≥1 条 ': ka ' 注释行, 之后停止。
//   B. 快启动 — 上游 50ms 就 yield, keep-alive 间隔 1s,
//      期望 0 条注释行 (timer 第一次 tick 之前已被 stopKeepalive 关停)。
//   C. axios 抛错 — 上游同步抛 Error, anyDataSent 必须 false,
//      finally 已关停 timer; 错误属性原样冒泡给调用方。
//   D. 重试递归 — currentRetry > 0 进入函数, 仍能观测到 keep-alive 写入,
//      验证启动逻辑放在 if (!isRetry) 块之外 (P0-1 不变量)。
//   E. retry-wait 心跳保活 — 直接驱动 waitWithKeepalive helper,
//      验证 7960ms 等待期间写出 ≥1 条 ': ka-retry ' 注释行, 返回 true。
//   F. retry-wait 中段 disconnect 早退 — 等待中途翻 clientDisconnected.value,
//      验证 helper 立即返回 false, 不再继续写心跳。
//
// 运行: npm run test:keepalive

import { EventEmitter } from 'node:events';
import { handleStreamRequest, waitWithKeepalive } from '../src/utils/common.js';

const KA_PREFIX = ': ka ';
const KA_RETRY_PREFIX = ': ka-retry ';
const FAIL = [];

function makeRes() {
    const res = new EventEmitter();
    res.headers = null;
    res.headWritten = false;
    res.writableEnded = false;
    res.destroyed = false;
    res.writes = [];
    res.writeHead = (status, headers) => {
        res.statusCode = status;
        res.headers = headers;
        res.headWritten = true;
    };
    res.write = (chunk) => {
        if (res.writableEnded || res.destroyed) return false;
        res.writes.push(String(chunk));
        return true;
    };
    res.end = (chunk) => {
        if (chunk) res.writes.push(String(chunk));
        res.writableEnded = true;
    };
    res.off = res.removeListener.bind(res);
    return res;
}

function makeService(generator) {
    return {
        generateContentStream: async (model, body) => generator(model, body),
    };
}

async function* delayedGen(delayMs, events) {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    for (const ev of events) yield ev;
}

async function* throwingGen(error) {
    // 立即抛错, 不 yield 任何事件 (yield* 是占位以保持 generator 形态)
    yield* (async function* () {})();
    throw error;
}

function countKeepalive(writes) {
    return writes.filter((w) => w.startsWith(KA_PREFIX)).length;
}

function countDataOrEvent(writes) {
    return writes.filter((w) => w.startsWith('data: ') || w.startsWith('event: ')).length;
}

function check(label, cond, detail) {
    if (cond) {
        console.log(`  ✔ ${label}`);
    } else {
        console.log(`  ✘ ${label}${detail ? ` — ${detail}` : ''}`);
        FAIL.push(label);
    }
}

const baseArgs = (res, service, retryContext = null) => [
    res,
    service,
    'claude-sonnet-4-test',
    { model: 'claude-sonnet-4-test', messages: [{ role: 'user', content: 'hi' }] },
    'claude-custom',
    'claude-custom',
    null,
    null,
    null, // providerPoolManager
    null, // pooluuid
    null,
    retryContext,
];

async function scenarioA() {
    console.log('\n[A] 慢启动: 12s 后 yield 首事件, KA=5000ms (= 钳位下限)');
    const res = makeRes();
    const service = makeService(() =>
        delayedGen(12000, [
            { type: 'message_start', message: { id: 'msg_1' } },
            { type: 'message_stop' },
        ])
    );
    const retryContext = { CONFIG: { STREAM_KEEPALIVE_INTERVAL_MS: 5000 } };
    await handleStreamRequest(...baseArgs(res, service, retryContext));
    const ka = countKeepalive(res.writes);
    const data = countDataOrEvent(res.writes);
    check('keep-alive ≥1 次', ka >= 1, `实际 ${ka}`);
    check('真实 SSE 事件 ≥1', data >= 1, `实际 ${data}`);
    check('SSE 头含 X-Accel-Buffering: no', res.headers?.['X-Accel-Buffering'] === 'no');
    // 校验顺序: 首条 ': ka ...' 应早于首条 'event: '/'data: '
    const firstKa = res.writes.findIndex((w) => w.startsWith(KA_PREFIX));
    const firstReal = res.writes.findIndex(
        (w) => w.startsWith('data: ') || w.startsWith('event: ')
    );
    check('keep-alive 在首个真实事件之前', firstKa >= 0 && firstKa < firstReal);
}

async function scenarioB() {
    console.log('\n[B] 快启动: 50ms 后 yield, KA=5000ms');
    const res = makeRes();
    const service = makeService(() =>
        delayedGen(50, [
            { type: 'message_start', message: { id: 'msg_2' } },
            { type: 'message_stop' },
        ])
    );
    const retryContext = { CONFIG: { STREAM_KEEPALIVE_INTERVAL_MS: 5000 } };
    await handleStreamRequest(...baseArgs(res, service, retryContext));
    const ka = countKeepalive(res.writes);
    check('keep-alive 0 次', ka === 0, `实际 ${ka}`);
}

async function scenarioC() {
    console.log('\n[C] 上游 axios 抛错, 无任何 yield');
    const res = makeRes();
    const upstreamErr = new Error('Simulated upstream 403');
    upstreamErr.shouldSwitchCredential = false; // 阻断重试链, 直接冒泡
    upstreamErr.status = 403;
    const service = makeService(() => throwingGen(upstreamErr));
    const retryContext = {
        CONFIG: { STREAM_KEEPALIVE_INTERVAL_MS: 5000 },
        maxRetries: 0, // 关闭重试避免污染断言
    };
    await handleStreamRequest(...baseArgs(res, service, retryContext));
    const ka = countKeepalive(res.writes);
    // 关键不变量: keep-alive timer 已在 finally 关停, 不会无限 tick
    check('axios 抛错路径未触发 keep-alive 持续 tick (≤1)', ka <= 1, `实际 ${ka}`);
    // 没有真实流式事件 (因为 axios 还没 200 OK)
    check('无 message_start data 行 (anyDataSent 应为 false)',
        !res.writes.some((w) => w.includes('"type":"message_start"')),
        '泄漏了 message_start');
}

async function scenarioD() {
    console.log('\n[D] 重试递归 (currentRetry=1) 仍启动 keep-alive');
    const res = makeRes();
    // 模拟父级已写过头
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Transfer-Encoding': 'chunked',
        'X-Accel-Buffering': 'no',
    });
    const service = makeService(() =>
        delayedGen(12000, [
            { type: 'message_start', message: { id: 'msg_3' } },
            { type: 'message_stop' },
        ])
    );
    const retryContext = {
        CONFIG: { STREAM_KEEPALIVE_INTERVAL_MS: 5000 },
        currentRetry: 1,
        maxRetries: 5,
        anyDataSent: false,
        clientDisconnected: { value: false },
    };
    await handleStreamRequest(...baseArgs(res, service, retryContext));
    const ka = countKeepalive(res.writes);
    check('重试递归路径 keep-alive ≥1 次 (P0-1)', ka >= 1, `实际 ${ka}`);
}

async function scenarioE() {
    console.log('\n[E] retry-wait 心跳保活: waitWithKeepalive(7960ms, 5000ms, clientDisconnected)');
    const res = makeRes();
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Transfer-Encoding': 'chunked',
        'X-Accel-Buffering': 'no',
    });
    const clientDisconnected = { value: false };
    const t0 = Date.now();
    const ok = await waitWithKeepalive(res, 7960, 5000, clientDisconnected);
    const elapsed = Date.now() - t0;
    const kaRetry = res.writes.filter((w) => w.startsWith(KA_RETRY_PREFIX)).length;
    check('返回 true (等满)', ok === true);
    // 上界放宽到 +3500ms — 此 scenario 跑在 A (12s) + D (12s) 之后, WSL2 timer 队列偶发漂移
    check('实际等待 ≈7960ms (±3500ms 容忍 timer 漂移)', elapsed >= 7460 && elapsed <= 11460, `实际 ${elapsed}ms`);
    check('期间写出 ≥1 条 ka-retry', kaRetry >= 1, `实际 ${kaRetry}`);
}

async function scenarioF() {
    console.log('\n[F] retry-wait 中段 disconnect: 800ms 后翻 clientDisconnected.value=true');
    const res = makeRes();
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Transfer-Encoding': 'chunked',
        'X-Accel-Buffering': 'no',
    });
    const clientDisconnected = { value: false };
    const t0 = Date.now();
    setTimeout(() => { clientDisconnected.value = true; }, 800);
    // delayMs=8000, intervalMs=1000 → heartbeatMs=max(2000, min(1000, 4000))=2000
    // 第一个 tick=2000ms, 醒来时 disconnect 已在 800ms 触发, 立即 return false
    const ok = await waitWithKeepalive(res, 8000, 1000, clientDisconnected);
    const elapsed = Date.now() - t0;
    check('返回 false (早退)', ok === false);
    check('实际耗时 ≤ 一个心跳 tick (~2000ms, 给 1500ms 缓冲)', elapsed < 3500, `实际 ${elapsed}ms`);
    check('远小于 8000ms 完整窗口', elapsed < 6000, `实际 ${elapsed}ms`);
}

async function scenarioG() {
    console.log('\n[G] Unary 路径 (clientDisconnected=null): 不写心跳');
    const res = makeRes();
    const t0 = Date.now();
    // delay=4000, intervalMs=1000 → heartbeatMs=max(2000, min(1000, 2000))=2000
    // res.destroyed 在 500ms 触发, 第一次 tick 醒来 (~2000ms) 立即 return false
    setTimeout(() => { res.destroyed = true; }, 500);
    const ok = await waitWithKeepalive(res, 4000, 1000, null);
    const elapsed = Date.now() - t0;
    const kaRetry = res.writes.filter((w) => w.startsWith(KA_RETRY_PREFIX)).length;
    check('返回 false (res.destroyed 触发早退)', ok === false);
    check('Unary 不写任何心跳注释', kaRetry === 0, `实际 ${kaRetry}`);
    check('实际耗时 ≤ 一个心跳 tick (~2000ms, 给 1500ms 缓冲)', elapsed < 3500, `实际 ${elapsed}ms`);
    check('远小于 4000ms 完整窗口', elapsed < 3500, `实际 ${elapsed}ms`);
}

async function main() {
    console.log('SSE keep-alive 行为测试');
    try {
        await scenarioA();
        await scenarioB();
        await scenarioC();
        await scenarioD();
        await scenarioE();
        await scenarioF();
        await scenarioG();
    } catch (e) {
        console.error('\n[FATAL] 测试驱动本身崩溃:', e);
        process.exit(2);
    }
    console.log('');
    if (FAIL.length === 0) {
        console.log('✅ 全部场景通过');
        process.exit(0);
    } else {
        console.log(`❌ ${FAIL.length} 项失败:`);
        for (const f of FAIL) console.log(`   - ${f}`);
        process.exit(1);
    }
}

main();
