import logger from '../../utils/logger.js';

export function normalizeKiroToolInput(input) {
    if (input === undefined || input === null) return '';
    if (typeof input === 'string') return input;
    if (typeof input === 'object') {
        try { return JSON.stringify(input); } catch (e) { return String(input); }
    }
    return String(input);
}

const PRELUDE_LEN = 12;
const MSG_CRC_LEN = 4;
const MIN_FRAME_LEN = PRELUDE_LEN + MSG_CRC_LEN;
const MAX_FRAME_LEN = 16 * 1024 * 1024; // AWS event-stream protocol max: 16 MB
const MAX_SYNC_LOSS_RATIO = 0.10;
const SYNC_LOSS_WARN_BYTES = 256;

export function parseAwsEventStreamFrames(buf) {
    const events = [];
    let pos = 0;
    let bytesSkipped = 0;
    const bufLen = buf.length;

    while (pos + PRELUDE_LEN <= bufLen) {
        const totalLen = buf.readUInt32BE(pos);
        const headersLen = buf.readUInt32BE(pos + 4);

        if (totalLen < MIN_FRAME_LEN || totalLen > MAX_FRAME_LEN
            || headersLen > totalLen - MIN_FRAME_LEN) {
            pos += 1;
            bytesSkipped += 1;
            if (bytesSkipped > Math.max(SYNC_LOSS_WARN_BYTES, bufLen * MAX_SYNC_LOSS_RATIO)) {
                logger.warn(`[Kiro Parse] Sync loss exceeded budget (skipped=${bytesSkipped}, bufLen=${bufLen}); discarding remaining buffer`);
                return { events, remaining: Buffer.alloc(0) };
            }
            continue;
        }

        if (pos + totalLen > bufLen) break;

        if (bytesSkipped > 0) {
            if (bytesSkipped >= SYNC_LOSS_WARN_BYTES) {
                logger.warn(`[Kiro Parse] Recovered frame after skipping ${bytesSkipped} bytes`);
            }
            bytesSkipped = 0;
        }

        const payloadStart = pos + PRELUDE_LEN + headersLen;
        const payloadEnd = pos + totalLen - MSG_CRC_LEN;
        const payloadBuf = buf.subarray(payloadStart, payloadEnd);
        const payload = payloadBuf.toString('utf8');

        try {
            const parsed = JSON.parse(payload);
            emitEventFromParsed(parsed, events);
        } catch (e) {
            const headerHex = buf.subarray(pos + PRELUDE_LEN, payloadStart).toString('hex').substring(0, 200);
            const payloadPreview = payload.substring(0, 200);
            logger.warn(`[Kiro Parse] Non-JSON payload frame skipped (payloadLen=${payloadBuf.length}, headerHex=${headerHex}, payloadPreview=${JSON.stringify(payloadPreview)})`);
        }

        pos += totalLen;
    }
    return { events, remaining: buf.subarray(pos) };
}

function emitEventFromParsed(parsed, events) {
    // TODO: 未来应改用 :event-type header 做分发，比 payload shape 启发式更权威
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
