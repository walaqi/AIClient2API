import { atomicWriteFile } from '../../utils/file-lock.js';
import axios from 'axios';
import logger from '../../utils/logger.js';
import { v4 as uuidv4 } from 'uuid';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as http from 'http';
import * as https from 'https';
import { getProviderModels } from '../provider-models.js';
import { 
    countTextTokens as countTextTokensUtil, 
    estimateInputTokens as estimateInputTokensUtil, 
    countTokensAnthropic as countTokensUtil,
    processContent as processContentUtil,
    getContentText as getContentTextUtil
} from '../../utils/token-utils.js';
import { configureAxiosProxy, configureTLSSidecar, isTLSSidecarEnabledForProvider, parseProxyUrl } from '../../utils/proxy-utils.js';
import { isRetryableNetworkError, MODEL_PROVIDER, formatExpiryLog } from '../../utils/common.js';
import { getProviderPoolManager } from '../../services/service-manager.js';
import { calculateCacheTokens } from '../../utils/model-pricing.js';
import { parseAwsEventStreamFrames as awsParseEventStreamFrames } from './aws-event-stream-parser.js';
import { isIncompleteFileToolCall } from './kiro-tool-validators.js';

const KIRO_THINKING = {
    MIN_BUDGET_TOKENS: 1024,
    MAX_BUDGET_TOKENS: 1024*8,
    DEFAULT_BUDGET_TOKENS: 20000,
    START_TAG: '<thinking>',
    END_TAG: '</thinking>',
    MODE_TAG: '<thinking_mode>',
    MAX_LEN_TAG: '<max_thinking_length>',
    EFFORT_TAG: '<thinking_effort>',
};

const KIRO_CONSTANTS = {
    REFRESH_URL: 'https://prod.{{region}}.auth.desktop.kiro.dev/refreshToken',
    REFRESH_IDC_URL: 'https://oidc.{{region}}.amazonaws.com/token',
    // BASE_URL: 'https://runtime.{{region}}.kiro.dev/generateAssistantResponse',
    BASE_URL: 'https://q.{{region}}.amazonaws.com/generateAssistantResponse',
    DEFAULT_MODEL_NAME: 'claude-sonnet-4-5',
    AXIOS_TIMEOUT: 120000, // 2 minutes timeout for normal (non-stream) requests
    STREAM_TOTAL_TIMEOUT: 300000, // 5 minutes total timeout for stream requests (overridable via CONFIG.KIRO_STREAM_TIMEOUT_MS)
    STREAM_INACTIVITY_TIMEOUT: 120000, // 60s socket inactivity (after first byte) (overridable via CONFIG.KIRO_STREAM_INACTIVITY_MS)
    TOKEN_REFRESH_TIMEOUT: 15000, // 15 seconds timeout for token refresh (shorter to avoid blocking)
    USER_AGENT: 'KiroIDE',
    KIRO_VERSION: '0.12.155',
    CONTENT_TYPE_JSON: 'application/json',
    ACCEPT_JSON: 'application/json',
    AUTH_METHOD_SOCIAL: 'social',
    CHAT_TRIGGER_TYPE_MANUAL: 'MANUAL',
    ORIGIN_AI_EDITOR: 'AI_EDITOR',
    ORIGIN_CLI: 'CLI',
    AGENT_MODE_SPEC: 'spec',
    AGENT_MODE_VIBE: 'vibe',
    TOTAL_CONTEXT_TOKENS: 200000, // Claude Sonnet 4.5 actual context is 200K
};

// Kiro 0.12.x 三端点表 — CodeWhisperer (主) → AmazonQ (回退) → AmazonQCLI (仅在 preferredEndpoint='amazonq-cli' 时单独使用)
// 参考: Kiro-account-manager kiroApi.ts:111-132
const KIRO_ENDPOINTS = [
    {
        name: 'CodeWhisperer',
        url: 'https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse',
        origin: 'AI_EDITOR'
    },
    {
        name: 'AmazonQ',
        url: 'https://q.us-east-1.amazonaws.com/generateAssistantResponse',
        origin: 'AI_EDITOR'
    },
    {
        name: 'AmazonQCLI',
        url: 'https://q.us-east-1.amazonaws.com/SendMessageStreaming',
        origin: 'CLI'
    }
];

/**
 * 返回当次请求需要尝试的端点顺序。
 * - 默认 (preferredEndpoint 缺省 / 'codewhisperer' / 'amazonq'): 取 CodeWhisperer + AmazonQ 两个端点，按 preferredEndpoint 决定哪个优先。
 *   AmazonQCLI 默认不在回退列表里 (origin 不同, payload 形态不同)。
 * - 'amazonq-cli': 仅返回 AmazonQCLI, 没有回退。调用方必须按其规则裁剪 payload (剥离 agentContinuationId / agentTaskType, origin=CLI)。
 * @param {string} [preferredEndpoint] - 'codewhisperer' | 'amazonq' | 'amazonq-cli' | undefined
 * @returns {Array<{name:string,url:string,origin:string}>}
 */
function getSortedEndpoints(preferredEndpoint) {
    const cw = KIRO_ENDPOINTS[0];
    const aq = KIRO_ENDPOINTS[1];
    const cli = KIRO_ENDPOINTS[2];

    if (preferredEndpoint === 'amazonq-cli') {
        return [cli];
    }
    if (preferredEndpoint === 'amazonq') {
        return [aq, cw];
    }
    // 默认: CodeWhisperer 优先, 失败回退 AmazonQ
    return [cw, aq];
}

/**
 * 为每次端点尝试调整 payload 的 origin 字段。
 * AmazonQCLI 端点要求 origin='CLI' 并且必须剥离 agentContinuationId / agentTaskType (服务端 SendMessageStreaming 不接受这两个字段)。
 * 其他两个端点保持 origin='AI_EDITOR' 即可。该函数返回一个 *浅克隆* 的 payload, 不会修改入参。
 * 参考: Kiro-account-manager kiroApi.ts:1163-1166
 * @param {Object} payload
 * @param {string} origin - 'AI_EDITOR' | 'CLI'
 * @returns {Object} 调整后的 payload
 */
function applyPayloadOrigin(payload, origin) {
    if (!payload || !payload.conversationState) return payload;
    // 浅克隆: 只有需要变更的层级会被替换
    const cloned = { ...payload, conversationState: { ...payload.conversationState } };
    const cm = cloned.conversationState.currentMessage;
    if (cm?.userInputMessage) {
        cloned.conversationState.currentMessage = {
            ...cm,
            userInputMessage: { ...cm.userInputMessage, origin }
        };
    }
    if (origin === 'CLI') {
        delete cloned.conversationState.agentContinuationId;
        delete cloned.conversationState.agentTaskType;
    }
    return cloned;
}

// ============= Sanitize 管线 (Kiro 0.12.x) =============
// 7 步管线 + validateConversation 终检, 顺序 load-bearing
// 参考: Kiro-account-manager kiroApi.ts:368-778

const KIRO_HELLO_MESSAGE = Object.freeze({
    userInputMessage: { content: 'Hello', origin: 'AI_EDITOR' }
});
const KIRO_CONTINUE_MESSAGE = Object.freeze({
    userInputMessage: { content: 'Continue', origin: 'AI_EDITOR' }
});
const KIRO_UNDERSTOOD_MESSAGE = Object.freeze({
    assistantResponseMessage: { content: 'understood' }
});

function isKiroUserInputMessage(message) {
    return message != null && message.userInputMessage != null;
}

function isKiroAssistantResponseMessage(message) {
    return message != null && message.assistantResponseMessage != null;
}

function kiroHasToolUses(message) {
    return Boolean(message?.assistantResponseMessage?.toolUses?.length);
}

function kiroHasToolResults(message) {
    return Boolean(message?.userInputMessage?.userInputMessageContext?.toolResults?.length);
}

function kiroHasMatchingToolResults(toolUses, toolResults) {
    if (!toolUses || !toolUses.length) return true;
    if (!toolResults || !toolResults.length) return false;
    const usesAllResolved = toolUses.every(tu =>
        toolResults.some(tr => tr.toolUseId === tu.toolUseId)
    );
    const resultsAllUsed = toolResults.every(tr =>
        toolUses.some(tu => tu.toolUseId === tr.toolUseId)
    );
    return usesAllResolved && resultsAllUsed;
}

function createFailedToolResult(toolUseId) {
    return {
        toolUseId,
        content: [{ text: 'Tool execution failed' }],
        status: 'error'
    };
}

function createFailedToolUseMessage(toolUseIds) {
    return {
        userInputMessage: {
            content: '',
            origin: 'AI_EDITOR',
            userInputMessageContext: {
                toolResults: toolUseIds.map(createFailedToolResult)
            }
        }
    };
}

function stripInvalidToolResults(message) {
    if (message?.userInputMessage?.content?.trim()) {
        const { userInputMessageContext: _drop, ...rest } = message.userInputMessage;
        return { userInputMessage: rest };
    }
    return null;
}

function ensureStartsWithUserMessage(messages) {
    if (messages.length === 0 || isKiroUserInputMessage(messages[0])) return messages;
    return [KIRO_HELLO_MESSAGE, ...messages];
}

function ensureEndsWithUserMessage(messages) {
    if (messages.length === 0) return [KIRO_HELLO_MESSAGE];
    if (isKiroUserInputMessage(messages[messages.length - 1])) return messages;
    return [...messages, KIRO_CONTINUE_MESSAGE];
}

function ensureAlternatingMessages(messages) {
    if (messages.length <= 1) return messages;
    const result = [messages[0]];
    for (let i = 1; i < messages.length; i++) {
        const prev = result[result.length - 1];
        const cur = messages[i];
        if (isKiroUserInputMessage(prev) && isKiroUserInputMessage(cur)) {
            result.push(KIRO_UNDERSTOOD_MESSAGE);
        } else if (isKiroAssistantResponseMessage(prev) && isKiroAssistantResponseMessage(cur)) {
            result.push(KIRO_CONTINUE_MESSAGE);
        }
        result.push(cur);
    }
    return result;
}

function relocateToolResultMessages(messages) {
    const assistantToolUseIndexes = [];
    const toolResultIndexById = new Map();
    for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        if (isKiroAssistantResponseMessage(m) && kiroHasToolUses(m)) {
            assistantToolUseIndexes.push(i);
        } else if (isKiroUserInputMessage(m) && kiroHasToolResults(m)) {
            for (const tr of m.userInputMessage.userInputMessageContext.toolResults) {
                if (tr.toolUseId && !toolResultIndexById.has(tr.toolUseId)) {
                    toolResultIndexById.set(tr.toolUseId, i);
                }
            }
        }
    }
    if (assistantToolUseIndexes.length === 0) return messages;

    const result = [];
    const usedIndexes = new Set();
    for (let i = 0; i < messages.length; i++) {
        if (usedIndexes.has(i)) continue;
        const m = messages[i];
        result.push(m);
        usedIndexes.add(i);
        if (isKiroAssistantResponseMessage(m) && kiroHasToolUses(m)) {
            for (const tu of m.assistantResponseMessage.toolUses) {
                const trIndex = toolResultIndexById.get(tu.toolUseId);
                if (trIndex !== undefined && trIndex !== i + 1 && !usedIndexes.has(trIndex)) {
                    const trMsg = messages[trIndex];
                    if (trMsg) {
                        result.push(trMsg);
                        usedIndexes.add(trIndex);
                    }
                }
            }
        }
    }
    return result;
}

function removeInvalidToolResultMessages(messages) {
    const result = [];
    for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        const prev = i > 0 ? messages[i - 1] : null;
        if (!isKiroUserInputMessage(m) || !kiroHasToolResults(m)) {
            result.push(m);
            continue;
        }
        if (!prev || !isKiroAssistantResponseMessage(prev) || !kiroHasToolUses(prev)) {
            const stripped = stripInvalidToolResults(m);
            if (stripped) result.push(stripped);
            continue;
        }
        const validIds = new Set(
            (prev.assistantResponseMessage.toolUses || []).map(tu => tu.toolUseId).filter(Boolean)
        );
        const seen = new Set();
        const trs = m.userInputMessage.userInputMessageContext.toolResults || [];
        const filtered = trs.filter(tr => {
            if (!tr.toolUseId || !validIds.has(tr.toolUseId) || seen.has(tr.toolUseId)) return false;
            seen.add(tr.toolUseId);
            return true;
        });
        if (filtered.length === trs.length) {
            result.push(m);
        } else if (filtered.length > 0) {
            result.push({
                userInputMessage: {
                    ...m.userInputMessage,
                    userInputMessageContext: {
                        ...m.userInputMessage.userInputMessageContext,
                        toolResults: filtered
                    }
                }
            });
        } else {
            const stripped = stripInvalidToolResults(m);
            if (stripped) result.push(stripped);
        }
    }
    return result;
}

function ensureValidToolUsesAndResults(messages) {
    const result = [];
    for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        result.push(m);

        if (!isKiroAssistantResponseMessage(m) || !kiroHasToolUses(m)) continue;

        const next = i + 1 < messages.length ? messages[i + 1] : null;
        const toolUses = m.assistantResponseMessage.toolUses || [];
        const toolUseIds = toolUses.map((tu, idx) => tu.toolUseId || `toolUse_${idx + 1}`);

        if (!next || !isKiroUserInputMessage(next) || !kiroHasToolResults(next)) {
            result.push(createFailedToolUseMessage(toolUseIds));
            continue;
        }

        const matches = kiroHasMatchingToolResults(
            toolUses,
            next.userInputMessage.userInputMessageContext.toolResults
        );
        if (matches) continue;

        // 是否有别的 assistant(toolUse) 能完美对上 next 的 toolResults? 是则放过 next, 留给后续 i 处理
        const someoneElseMatches = messages.some((cand, idx) => (
            idx !== i
            && isKiroAssistantResponseMessage(cand)
            && kiroHasToolUses(cand)
            && kiroHasMatchingToolResults(
                cand.assistantResponseMessage.toolUses,
                next.userInputMessage.userInputMessageContext.toolResults
            )
        ));
        if (someoneElseMatches) continue;

        // 用现有的+补 failed 凑齐
        const existing = next.userInputMessage.userInputMessageContext.toolResults || [];
        const validSet = new Set(toolUseIds);
        const used = new Set();
        const completed = existing.filter(tr => {
            if (!tr.toolUseId || !validSet.has(tr.toolUseId) || used.has(tr.toolUseId)) return false;
            used.add(tr.toolUseId);
            return true;
        });
        for (const id of toolUseIds) {
            if (!used.has(id)) completed.push(createFailedToolResult(id));
        }
        result.push({
            userInputMessage: {
                ...next.userInputMessage,
                userInputMessageContext: {
                    ...next.userInputMessage.userInputMessageContext,
                    toolResults: completed
                }
            }
        });
        i++;
    }
    return result;
}

function removeEmptyUserMessages(messages) {
    if (messages.length <= 1) return messages;
    const firstUserIdx = messages.findIndex(isKiroUserInputMessage);
    return messages.filter((m, idx) => {
        if (isKiroAssistantResponseMessage(m)) return true;
        if (isKiroUserInputMessage(m) && idx === firstUserIdx) return true;
        if (isKiroUserInputMessage(m)) {
            const hasContent = (m.userInputMessage.content || '').trim() !== '';
            return hasContent || kiroHasToolResults(m);
        }
        return true;
    });
}

function validateKiroConversation(messages) {
    const errors = [];
    if (messages.length === 0 || !isKiroUserInputMessage(messages[0])) {
        errors.push('STARTS_WITH_USER_MESSAGE:index=0');
    }
    if (messages.length === 0 || !isKiroUserInputMessage(messages[messages.length - 1])) {
        errors.push(`ENDS_WITH_USER_MESSAGE:index=${Math.max(messages.length - 1, 0)}`);
    }
    for (let i = 1; i < messages.length; i++) {
        const prev = messages[i - 1];
        const cur = messages[i];
        if (isKiroUserInputMessage(prev) && isKiroUserInputMessage(cur)) {
            errors.push(`ALTERNATING_MESSAGES:index=${i}`);
            break;
        }
        if (isKiroAssistantResponseMessage(prev) && isKiroAssistantResponseMessage(cur)) {
            errors.push(`ALTERNATING_MESSAGES:index=${i}`);
            break;
        }
    }
    for (let i = 0; i < messages.length - 1; i++) {
        const m = messages[i];
        const next = messages[i + 1];
        if (
            isKiroAssistantResponseMessage(m)
            && kiroHasToolUses(m)
            && (!isKiroUserInputMessage(next) || !kiroHasMatchingToolResults(
                m.assistantResponseMessage.toolUses,
                next?.userInputMessage?.userInputMessageContext?.toolResults
            ))
        ) {
            errors.push(`TOOL_USES_AND_RESULTS:index=${i + 1}`);
            break;
        }
        if (
            isKiroAssistantResponseMessage(m)
            && !kiroHasToolUses(m)
            && isKiroUserInputMessage(next)
            && kiroHasToolResults(next)
        ) {
            errors.push(`TOOL_RESULTS_AND_NO_USES:index=${i}`);
            break;
        }
    }
    for (let i = 1; i < messages.length; i++) {
        const prev = messages[i - 1];
        const cur = messages[i];
        if (
            !isKiroAssistantResponseMessage(prev)
            || !kiroHasToolUses(prev)
            || !isKiroUserInputMessage(cur)
            || !kiroHasToolResults(cur)
        ) continue;
        const toolUseIds = new Set(
            (prev.assistantResponseMessage.toolUses || []).map(tu => tu.toolUseId).filter(Boolean)
        );
        const seen = new Set();
        const invalid = (cur.userInputMessage.userInputMessageContext.toolResults || []).some(tr => {
            if (!tr.toolUseId || !toolUseIds.has(tr.toolUseId) || seen.has(tr.toolUseId)) return true;
            seen.add(tr.toolUseId);
            return false;
        });
        if (invalid) {
            errors.push(`TOOL_RESULTS_ORPHAN_IDS:index=${i}`);
            break;
        }
    }
    for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        if (
            isKiroUserInputMessage(m)
            && !(m.userInputMessage.content || '').trim()
            && !kiroHasToolResults(m)
        ) {
            errors.push(`NON_EMPTY_USER_MESSAGE:index=${i}`);
            break;
        }
    }
    return errors;
}

// Phase 2.4: orphan tool flatten — 当 history 中引用的 tool 名不在 current request tools 列表时
// 将 tool_use / tool_result 拍平成 XML 文本, 避免 Kiro 因 unknown tool 报 400.
function getKiroToolNames(tools) {
    const names = new Set();
    if (!Array.isArray(tools)) return names;
    for (const tool of tools) {
        if (tool && tool.toolSpecification && typeof tool.toolSpecification.name === 'string') {
            names.add(tool.toolSpecification.name);
        }
    }
    return names;
}

function stringifyKiroToolInput(input) {
    if (input === undefined) return '';
    if (typeof input === 'string') return input;
    try {
        return JSON.stringify(input);
    } catch {
        return String(input);
    }
}

function flattenKiroContent(content, extra) {
    const trimmed = (content || '').trim();
    if (!trimmed) return extra;
    if (!extra) return trimmed;
    return `${trimmed}\n\n${extra}`;
}

function formatKiroToolUses(toolUses) {
    if (!Array.isArray(toolUses)) return '';
    return toolUses.map(tu => [
        `<tool_use id="${tu.toolUseId}" name="${tu.name}">`,
        stringifyKiroToolInput(tu.input),
        '</tool_use>'
    ].filter(Boolean).join('\n')).join('\n\n');
}

function formatKiroToolResults(toolResults) {
    if (!Array.isArray(toolResults)) return '';
    return toolResults.map(tr => [
        `<tool_result id="${tr.toolUseId}" status="${tr.status}">`,
        Array.isArray(tr.content) ? tr.content.map(c => (c && c.text) || '').join('\n') : '',
        '</tool_result>'
    ].filter(Boolean).join('\n')).join('\n\n');
}

function normalizeKiroToolHistory(messages, tools) {
    const toolNames = getKiroToolNames(tools);
    const hasUnknownToolUse = messages.some(m =>
        m && m.assistantResponseMessage && Array.isArray(m.assistantResponseMessage.toolUses)
            && m.assistantResponseMessage.toolUses.some(tu => !toolNames.has(tu.name))
    );
    if (!hasUnknownToolUse) return messages;

    return messages.map(message => {
        if (message && message.assistantResponseMessage && Array.isArray(message.assistantResponseMessage.toolUses) && message.assistantResponseMessage.toolUses.length > 0) {
            const flat = {
                ...message.assistantResponseMessage,
                content: flattenKiroContent(message.assistantResponseMessage.content || '', formatKiroToolUses(message.assistantResponseMessage.toolUses))
            };
            delete flat.toolUses;
            return { assistantResponseMessage: flat };
        }
        if (message && message.userInputMessage && message.userInputMessage.userInputMessageContext
                && Array.isArray(message.userInputMessage.userInputMessageContext.toolResults)
                && message.userInputMessage.userInputMessageContext.toolResults.length > 0) {
            const ctx = { ...message.userInputMessage.userInputMessageContext };
            const trText = formatKiroToolResults(ctx.toolResults);
            delete ctx.toolResults;
            return {
                userInputMessage: {
                    ...message.userInputMessage,
                    content: flattenKiroContent(message.userInputMessage.content || '', trText),
                    userInputMessageContext: ctx
                }
            };
        }
        return message;
    });
}

// 7 步管线; 顺序 load-bearing (relocate 必须在 ensureValidToolUsesAndResults 之前)
function sanitizeKiroConversation(messages) {
    let s = [...messages];
    s = ensureStartsWithUserMessage(s);
    s = removeEmptyUserMessages(s);
    s = relocateToolResultMessages(s);
    s = removeInvalidToolResultMessages(s);
    s = ensureValidToolUsesAndResults(s);
    s = ensureAlternatingMessages(s);
    s = ensureEndsWithUserMessage(s);
    const errs = validateKiroConversation(s);
    if (errs.length > 0) {
        throw new Error(`Invalid Kiro conversation after sanitization: ${errs.join(', ')}`);
    }
    return s;
}

// Phase 2.6: token-buffer reserve + payload-size driven history trim.
// 参考: kiroApi.ts:38-77 + kiroApi.ts:783-821
const KIRO_TOKEN_BUFFER_RESERVE_DEFAULT = 50000;
const KIRO_TOKEN_BUFFER_RESERVE_MIN = 5000;
const KIRO_TOKEN_BUFFER_RESERVE_MAX = 150000;

function getKiroTokenBufferReserve(config) {
    const raw = config?.tokenBufferReserve;
    const numeric = Number(raw);
    if (!Number.isFinite(numeric)) return KIRO_TOKEN_BUFFER_RESERVE_DEFAULT;
    return Math.max(KIRO_TOKEN_BUFFER_RESERVE_MIN, Math.min(KIRO_TOKEN_BUFFER_RESERVE_MAX, numeric));
}

// UTF-8 byte / 3.5 — 与 kiroApi.ts 一致, 对中英混合略偏保守, 用于触发裁剪阈值是安全的
function estimateTokensFromString(str) {
    if (str == null) return 0;
    return Math.ceil(Buffer.byteLength(String(str), 'utf-8') / 3.5);
}

function estimatePayloadTokens(payload) {
    try {
        return estimateTokensFromString(JSON.stringify(payload));
    } catch {
        return 0;
    }
}

// 按 token 估算成对裁剪 history 最旧消息 (避免后端 CONTENT_LENGTH_EXCEEDS_THRESHOLD).
// 切点保证不破坏 toolUse↔toolResult 配对: assistant(toolUse) 必须连同后续 user(toolResult) 一起裁.
// 裁剪后用 ensureStartsWithUserMessage 兜底重新规范化.
function trimHistoryByTokens(payload, maxTokens) {
    if (!payload || !payload.conversationState) {
        return { trimmed: 0, finalTokens: estimatePayloadTokens(payload), iterations: 0 };
    }
    let history = payload.conversationState.history;
    if (!Array.isArray(history) || history.length === 0) {
        return { trimmed: 0, finalTokens: estimatePayloadTokens(payload), iterations: 0 };
    }

    let totalTrimmed = 0;
    let iterations = 0;
    let currentTokens = estimatePayloadTokens(payload);
    const MAX_ITERATIONS = 100;

    while (currentTokens > maxTokens && history.length >= 4 && iterations < MAX_ITERATIONS) {
        iterations++;
        let cutAt = 0;
        while (cutAt < history.length - 2) {
            const msg = history[cutAt];
            if (isKiroAssistantResponseMessage(msg) && kiroHasToolUses(msg)) {
                cutAt += 2;
            } else {
                cutAt += 1;
            }
            if (cutAt >= 2) break;
        }
        if (cutAt === 0) break;

        history = history.slice(cutAt);
        totalTrimmed += cutAt;

        history = ensureStartsWithUserMessage(history);
        payload.conversationState.history = history;
        currentTokens = estimatePayloadTokens(payload);
    }

    return { trimmed: totalTrimmed, finalTokens: currentTokens, iterations };
}

// Phase 3.1: conversationId 稳定化 — 同一会话的多轮请求复用同一个 conversationId, 让 Kiro 服务端 prompt cache 命中.
// 参考: kiroApi.ts:1015-1054
const KIRO_CONVERSATION_CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2h
const KIRO_CONVERSATION_CACHE_MAX = 256;
const kiroConversationCache = new Map(); // key -> { id, timestamp }

function fingerprintFromClaudeMessages(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return undefined;
    const head = messages.slice(0, 2).map(msg => {
        const role = msg?.role || '';
        const content = msg?.content;
        let text = '';
        if (typeof content === 'string') {
            text = content;
        } else if (Array.isArray(content)) {
            text = content.map(b => {
                if (!b) return '';
                if (typeof b === 'string') return b;
                if (b.type === 'text' && typeof b.text === 'string') return b.text;
                if (b.type === 'tool_use' && b.name) return `[tool_use:${b.name}]`;
                if (b.type === 'tool_result' && b.tool_use_id) return `[tool_result:${b.tool_use_id}]`;
                return '';
            }).join('');
        }
        return `${role}|${text.slice(0, 512)}`;
    }).join('::');
    if (!head) return undefined;
    return crypto.createHash('sha256').update(head).digest('hex').slice(0, 32);
}

function resolveConversationId(messages, sessionHint) {
    const key = sessionHint || fingerprintFromClaudeMessages(messages);
    if (!key) {
        return uuidv4();
    }

    const now = Date.now();
    const cached = kiroConversationCache.get(key);
    if (cached && (now - cached.timestamp) < KIRO_CONVERSATION_CACHE_TTL_MS) {
        cached.timestamp = now;
        return cached.id;
    }

    if (kiroConversationCache.size >= KIRO_CONVERSATION_CACHE_MAX) {
        const cutoff = now - KIRO_CONVERSATION_CACHE_TTL_MS;
        for (const [k, v] of kiroConversationCache) {
            if (v.timestamp < cutoff) kiroConversationCache.delete(k);
        }
        if (kiroConversationCache.size >= KIRO_CONVERSATION_CACHE_MAX) {
            // LRU eviction: drop oldest
            const oldestKey = kiroConversationCache.keys().next().value;
            if (oldestKey !== undefined) kiroConversationCache.delete(oldestKey);
        }
    }

    const id = uuidv4();
    kiroConversationCache.set(key, { id, timestamp: now });
    return id;
}

const KIRO_MAX_TOOL_NAME_LENGTH = 64;
let kiroThrottleQueue = Promise.resolve();
let kiroLastRequestStartedAt = 0;

// Phase 2.5: 双向 tool 名映射, FNV-1a base36 hash, ≤64 字符约束
// 参考: toolNameRegistry.ts
class KiroToolNameRegistry {
    constructor() {
        this.originalToKiro = new Map();
        this.kiroToOriginal = new Map();
    }

    toKiroName(name) {
        const existing = this.originalToKiro.get(name);
        if (existing) return existing;

        const baseName = name.length <= KIRO_MAX_TOOL_NAME_LENGTH ? name : this._shorten(name);
        const kiroName = this._ensureUnique(baseName, name);
        this.originalToKiro.set(name, kiroName);
        this.kiroToOriginal.set(kiroName, name);
        return kiroName;
    }

    toClientName(name) {
        return this.kiroToOriginal.get(name) || name;
    }

    _ensureUnique(baseName, originalName) {
        const existing = this.kiroToOriginal.get(baseName);
        if (!existing || existing === originalName) return baseName;

        const hash = this._hash(originalName);
        const suffix = `_${hash}`;
        const candidate = baseName.substring(0, Math.max(1, KIRO_MAX_TOOL_NAME_LENGTH - suffix.length)) + suffix;
        const candidateExisting = this.kiroToOriginal.get(candidate);
        if (!candidateExisting || candidateExisting === originalName) return candidate;

        throw new Error(`Tool name collision after shortening: ${originalName}`);
    }

    _shorten(name) {
        const hash = this._hash(name);
        const suffix = `_${hash}`;
        const readable = name.replace(/[^a-zA-Z0-9_-]/g, '_');
        const maxPrefixLength = KIRO_MAX_TOOL_NAME_LENGTH - suffix.length;
        return readable.substring(0, maxPrefixLength) + suffix;
    }

    _hash(value) {
        let hash = 2166136261;
        for (let i = 0; i < value.length; i++) {
            hash ^= value.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0).toString(36);
    }
}

function buildKiroToolNameMaps(tools) {
    const registry = new KiroToolNameRegistry();

    if (Array.isArray(tools)) {
        for (const tool of tools) {
            const originalName = tool?.name;
            if (!originalName) continue;
            registry.toKiroName(originalName);
        }
    }

    return {
        registry,
        aliasToOriginal: registry.kiroToOriginal,
        toKiroName: (name) => registry.toKiroName(name),
        fromKiroName: (name) => registry.toClientName(name)
    };
}

function restoreKiroToolCallNames(toolCalls, toolNameMaps) {
    if (!toolCalls || !toolNameMaps?.fromKiroName) {
        return toolCalls;
    }

    return toolCalls.map(toolCall => ({
        ...toolCall,
        function: {
            ...toolCall.function,
            name: toolNameMaps.fromKiroName(toolCall.function?.name)
        }
    }));
}

function getKiroRequestMinIntervalMs(config) {
    const value = Number(config?.KIRO_REQUEST_MIN_INTERVAL_MS);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

async function acquireKiroRequestSlot(config) {
    const minIntervalMs = getKiroRequestMinIntervalMs(config);
    if (minIntervalMs <= 0) {
        return () => {};
    }

    let releaseCurrent;
    const previous = kiroThrottleQueue.catch(() => {});
    kiroThrottleQueue = previous.then(() => new Promise(resolve => {
        releaseCurrent = resolve;
    }));

    await previous;

    const elapsedMs = Date.now() - kiroLastRequestStartedAt;
    const waitMs = Math.max(0, minIntervalMs - elapsedMs);
    if (waitMs > 0) {
        await new Promise(resolve => setTimeout(resolve, waitMs));
    }
    kiroLastRequestStartedAt = Date.now();

    let released = false;
    return () => {
        if (released) return;
        released = true;
        releaseCurrent();
    };
}

function normalizeKiroToolInput(input) {
    if (input === undefined || input === null) {
        return '';
    }
    if (typeof input === 'string') {
        return input;
    }
    if (typeof input === 'object') {
        try {
            return JSON.stringify(input);
        } catch (e) {
            return String(input);
        }
    }
    return String(input);
}

// Per-model context window sizes for accurate token estimation
const MODEL_CONTEXT_TOKENS = {
    "claude-opus-4-7": 1000000,
    "claude-opus-4-6": 1000000,
    "claude-opus-4-5": 1000000,
    "claude-opus-4-5-20251101": 1000000,
    "claude-sonnet-4-6": 200000,
    "claude-sonnet-4-5": 200000,
    "claude-sonnet-4-5-20250929": 200000,
    "claude-haiku-4-5": 200000,
    "claude-haiku-4-5-20251001": 200000,
};

function normalizeContextLength(value) {
    if (value === undefined || value === null || value === '') {
        return null;
    }

    const numericValue = Number(value);
    return Number.isFinite(numericValue) && numericValue > 0 ? numericValue : null;
}

function findCustomModelConfigForModel(model, config = {}) {
    const targetModel = typeof model === 'string'
        ? model.replace(/^[^:]+:/, '')
        : '';
    if (!targetModel) {
        return null;
    }

    const customModels = Array.isArray(config?.customModels) ? config.customModels : [];
    return customModels.find(({ id, alias, actualModel } = {}) =>
        id === targetModel || alias === targetModel || actualModel === targetModel
    ) || null;
}

function getContextTokensForModel(model, config = {}, fallbackModel = null) {
    const customModelConfig = findCustomModelConfigForModel(model, config) ||
        findCustomModelConfigForModel(fallbackModel, config);
    const configuredModelContextLength = normalizeContextLength(customModelConfig?.contextLength);
    if (configuredModelContextLength !== null) {
        return configuredModelContextLength;
    }

    return MODEL_CONTEXT_TOKENS[model] || MODEL_CONTEXT_TOKENS[fallbackModel] || KIRO_CONSTANTS.TOTAL_CONTEXT_TOKENS;
}
// 从 provider-models.js 获取支持的模型列表
const KIRO_MODELS = getProviderModels(MODEL_PROVIDER.KIRO_API);

// 完整的模型映射表
const FULL_MODEL_MAPPING = {
    "claude-haiku-4-5":"claude-haiku-4.5",
    "claude-opus-4-7":"claude-opus-4.7",
    "claude-opus-4-6":"claude-opus-4.6",
    "claude-sonnet-4-6":"claude-sonnet-4.6",
    "claude-opus-4-5":"claude-opus-4.5",
    "claude-opus-4-5-20251101":"claude-opus-4.5",
    "claude-sonnet-4-5": "claude-sonnet-4.5",
    "claude-sonnet-4-5-20250929": "claude-sonnet-4.5"
};

// 只保留 KIRO_MODELS 中存在的模型映射
const MODEL_MAPPING = Object.fromEntries(
    Object.entries(FULL_MODEL_MAPPING).filter(([key]) => KIRO_MODELS.includes(key))
);

// Phase 3.2: native thinking via additionalModelRequestFields 仅 Claude 4+ 支持.
// Claude 3.x 不支持该字段; 旧的 inline tag 注入路径会被新协议服务端拒绝, 故直接跳过.
function isClaudeFourOrLater(model) {
    if (typeof model !== 'string') return false;
    const lower = model.toLowerCase();
    return lower.startsWith('claude-opus-4') ||
        lower.startsWith('claude-sonnet-4') ||
        lower.startsWith('claude-haiku-4');
}

const KIRO_AUTH_TOKEN_FILE = "kiro-auth-token.json";

/**
 * Kiro API Service - Node.js implementation based on the Python ki2api
 * Provides OpenAI-compatible API for Claude Sonnet 4 via Kiro/CodeWhisperer
 */

/**
 * 根据当前配置生成唯一的机器码（Machine ID）
 * 确保每个配置对应一个唯一且不变的 ID
 * @param {Object} credentials - 当前凭证信息
 * @returns {string} SHA256 格式的机器码
 */
function generateMachineIdFromConfig(credentials) {
    // 优先级：节点UUID > profileArn > clientId > fallback
    const uniqueKey = credentials.uuid || credentials.profileArn || credentials.clientId || "KIRO_DEFAULT_MACHINE";
    return crypto.createHash('sha256').update(uniqueKey).digest('hex');
}

/**
 * 实时获取系统配置信息，用于生成 User-Agent
 * @returns {Object} 包含 osName, nodeVersion 等信息
 */
// ============ Kiro 0.12.x User-Agent helpers (IDE 与 CLI 两套) ============
// 参考: Kiro-account-manager kiroApi.ts:135-156
const AWS_SDK_VERSION = '1.0.34';
const AWS_STREAMING_API_VERSION = '1.0.34';

// 与 kiroApi.ts 保持一致: win32 保留 'win32', darwin 转 'macos', 其他归为 'linux'
function getKiroOsPlatform() {
    const p = os.platform();
    if (p === 'win32') return 'win32';
    if (p === 'darwin') return 'macos';
    return 'linux';
}

function getKiroOsRelease() {
    try {
        return os.release();
    } catch {
        return '10.0.0';
    }
}

function getKiroNodeVersion() {
    return (process.versions && process.versions.node) || process.version.replace(/^v/, '') || '22.0.0';
}

/**
 * 生成 IDE 模式的 user-agent (SOCIAL / Builder-ID 账号使用)
 * 形如: aws-sdk-js/1.0.34 ua/2.1 os/<plat>#<rel> lang/js md/nodejs#<ver> api/codewhispererstreaming#1.0.34 m/E KiroIDE-<ver>-<machineId>
 */
function getKiroUserAgent(machineId) {
    const plat = getKiroOsPlatform();
    const rel = getKiroOsRelease();
    const ver = getKiroNodeVersion();
    const suffix = machineId ? `KiroIDE-${KIRO_CONSTANTS.KIRO_VERSION}-${machineId}` : `KiroIDE-${KIRO_CONSTANTS.KIRO_VERSION}`;
    return `aws-sdk-js/${AWS_SDK_VERSION} ua/2.1 os/${plat}#${rel} lang/js md/nodejs#${ver} api/codewhispererstreaming#${AWS_STREAMING_API_VERSION} m/E ${suffix}`;
}

/**
 * 生成 IDE 模式的 x-amz-user-agent
 * 形如: aws-sdk-js/1.0.34 KiroIDE <ver> <machineId>
 * 注意: machineId 缺省时形如 'KiroIDE-<ver>' (用 '-' 连接), 跟随 kiroApi.ts 行为。
 */
function getKiroAmzUserAgent(machineId) {
    const suffix = machineId ? `KiroIDE ${KIRO_CONSTANTS.KIRO_VERSION} ${machineId}` : `KiroIDE-${KIRO_CONSTANTS.KIRO_VERSION}`;
    return `aws-sdk-js/${AWS_SDK_VERSION} ${suffix}`;
}

// CLI 模式 user-agent (IDC 账号使用)。与 kiroApi.ts 一致, 自带 rust SDK 标识。
const KIRO_CLI_USER_AGENT = `aws-sdk-rust/1.3.9 os/${getKiroOsPlatform() === 'win32' ? 'windows' : getKiroOsPlatform()} lang/rust/1.87.0`;
const KIRO_CLI_AMZ_USER_AGENT = `aws-sdk-rust/1.3.9 ua/2.1 api/ssooidc/1.88.0 os/${getKiroOsPlatform() === 'win32' ? 'windows' : getKiroOsPlatform()} lang/rust/1.87.0 m/E app/AmazonQ-For-CLI`;

/**
 * 判断当前账号是否为 IDC (Identity Center / external IdP) 类型。
 * IDC 账号使用 vibe 模式 + Rust CLI User-Agent; 其他 (social / builder-id) 使用 spec 模式 + JS IDE User-Agent。
 */
function isKiroIdcAuth(authMethod) {
    if (!authMethod) return false;
    const v = String(authMethod).toLowerCase();
    return v === 'idc' || v === 'external_idp';
}

// Helper functions for tool calls and JSON parsing

function isQuoteCharAt(text, index) {
    if (index < 0 || index >= text.length) return false;
    const ch = text[index];
    return ch === '"' || ch === "'" || ch === '`';
}

function findRealTag(text, tag, startIndex = 0) {
    let searchStart = Math.max(0, startIndex);
    while (true) {
        const pos = text.indexOf(tag, searchStart);
        if (pos === -1) return -1;
        
        const hasQuoteBefore = isQuoteCharAt(text, pos - 1);
        const hasQuoteAfter = isQuoteCharAt(text, pos + tag.length);
        if (!hasQuoteBefore && !hasQuoteAfter) {
            return pos;
        }
        
        searchStart = pos + 1;
    }
}

function isWhitespaceOnly(text) {
    if (text === null || text === undefined) return true;
    return String(text).trim().length === 0;
}

/**
 * Find a "real" thinking end tag that is not quoted/backticked and is followed by '\n\n'.
 * This avoids prematurely closing a thinking block when the model mentions `</thinking>`
 * inside the thinking content.
 */
function findRealThinkingEndTag(buffer, startIndex = 0) {
    let searchStart = Math.max(0, startIndex);
    while (true) {
        const pos = findRealTag(buffer, KIRO_THINKING.END_TAG, searchStart);
        if (pos === -1) return -1;
        const after = buffer.slice(pos + KIRO_THINKING.END_TAG.length);
        if (after.startsWith('\n\n')) return pos;
        searchStart = pos + 1;
    }
}

/**
 * Find a "real" thinking end tag only when it is at the buffer end (after it is whitespace only).
 * This is used for boundary-event scenarios (tool_use starts immediately after thinking, or stream end).
 */
function findRealThinkingEndTagAtBufferEnd(buffer, startIndex = 0) {
    let searchStart = Math.max(0, startIndex);
    while (true) {
        const pos = findRealTag(buffer, KIRO_THINKING.END_TAG, searchStart);
        if (pos === -1) return -1;
        const after = buffer.slice(pos + KIRO_THINKING.END_TAG.length);
        if (isWhitespaceOnly(after)) return pos;
        searchStart = pos + 1;
    }
}

/**
 * 通用的括号匹配函数 - 支持多种括号类型
 * @param {string} text - 要搜索的文本
 * @param {number} startPos - 起始位置
 * @param {string} openChar - 开括号字符 (默认 '[')
 * @param {string} closeChar - 闭括号字符 (默认 ']')
 * @returns {number} 匹配的闭括号位置，未找到返回 -1
 */
function findMatchingBracket(text, startPos, openChar = '[', closeChar = ']') {
    if (!text || startPos >= text.length || text[startPos] !== openChar) {
        return -1;
    }

    let bracketCount = 1;
    let inString = false;
    let escapeNext = false;

    for (let i = startPos + 1; i < text.length; i++) {
        const char = text[i];

        if (escapeNext) {
            escapeNext = false;
            continue;
        }

        if (char === '\\' && inString) {
            escapeNext = true;
            continue;
        }

        if (char === '"' && !escapeNext) {
            inString = !inString;
            continue;
        }

        if (!inString) {
            if (char === openChar) {
                bracketCount++;
            } else if (char === closeChar) {
                bracketCount--;
                if (bracketCount === 0) {
                    return i;
                }
            }
        }
    }
    return -1;
}


/**
 * 尝试修复常见的 JSON 格式问题
 * @param {string} jsonStr - 可能有问题的 JSON 字符串
 * @returns {string} 修复后的 JSON 字符串
 */
function repairJson(jsonStr) {
    let repaired = jsonStr;
    // 移除尾部逗号
    repaired = repaired.replace(/,\s*([}\]])/g, '$1');
    // 为未引用的键添加引号
    repaired = repaired.replace(/([{,]\s*)([a-zA-Z0-9_]+?)\s*:/g, '$1"$2":');
    // 确保字符串值被正确引用
    repaired = repaired.replace(/:\s*([a-zA-Z0-9_]+)(?=[,\}\]])/g, ':"$1"');
    return repaired;
}

function repairToolInputJson(inputStr) {
    if (typeof inputStr !== 'string') return inputStr;
    try { JSON.parse(inputStr); return inputStr; } catch (e) {}
    const repaired = inputStr.replace(/\}(,\s*")/, '$1');
    try { JSON.parse(repaired); return repaired; } catch (e) {}
    return inputStr;
}

function getOutputReserveConfig(config) {
    let pressureFactor = Number.parseFloat(config?.OUTPUT_RESERVE_CONTEXT_PRESSURE);
    if (!Number.isFinite(pressureFactor) || pressureFactor < 1.0) pressureFactor = 1.0;
    else if (pressureFactor > 2.0) { pressureFactor = 2.0; }
    const truncateOn = config?.OUTPUT_RESERVE_TOOL_RESULT_TRUNCATE === true;
    let truncateMax = Number.parseInt(config?.OUTPUT_RESERVE_TOOL_RESULT_MAX_CHARS, 10);
    if (!Number.isFinite(truncateMax) || truncateMax < 1024) truncateMax = 8192;
    const adaptiveDesc = config?.OUTPUT_RESERVE_TOOL_DESC_ADAPTIVE === true;
    return { pressureFactor, truncateOn, truncateMax, adaptiveDesc };
}

const TOOL_RESULT_RATIOS = { Read: 0.5, Bash: 0.25, Grep: 0.8, Glob: 0.8 };

function truncateHeadTailByTool(text, maxLen, toolName) {
    if (!text || text.length <= maxLen) return { text, truncated: false };
    if (text.startsWith('data:image/') || text.startsWith('data:application/')) {
        return { text, truncated: false };
    }
    const headRatio = TOOL_RESULT_RATIOS[toolName] ?? 0.6;
    const placeholder = `\n\n...[omitted]...\n\n`;
    const budget = Math.max(0, maxLen - placeholder.length);
    const headLen = Math.floor(budget * headRatio);
    const tailLen = budget - headLen;
    return { text: text.slice(0, headLen) + placeholder + text.slice(-tailLen), truncated: true };
}

const ADAPTIVE_DESC_TABLE = [[5, 8192], [40, 4096], [90, 2048], [160, 1024]];

function pickAdaptiveDescBudget(n) {
    if (n <= ADAPTIVE_DESC_TABLE[0][0]) return ADAPTIVE_DESC_TABLE[0][1];
    const last = ADAPTIVE_DESC_TABLE[ADAPTIVE_DESC_TABLE.length - 1];
    if (n >= last[0]) return last[1];
    for (let i = 0; i < ADAPTIVE_DESC_TABLE.length - 1; i++) {
        const [n1, b1] = ADAPTIVE_DESC_TABLE[i];
        const [n2, b2] = ADAPTIVE_DESC_TABLE[i + 1];
        if (n >= n1 && n < n2) return Math.round(b1 + (n - n1) / (n2 - n1) * (b2 - b1));
    }
    return 8192;
}

/**
 * 从损坏的 JSON 中提取关键凭证字段
 * 当标准 JSON 解析和 repairJson 都失败时使用
 * @param {string} content - 文件内容
 * @returns {Object|null} 提取的凭证对象或 null
 */
function extractCredentialsFromCorruptedJson(content) {
    const extracted = {};

    // 定义需要提取的关键字段及其正则模式
    const fieldPatterns = {
        refreshToken: /"refreshToken"\s*:\s*"([^"]+)"/,
        accessToken: /"accessToken"\s*:\s*"([^"]+)"/,
        clientId: /"clientId"\s*:\s*"([^"]+)"/,
        clientSecret: /"clientSecret"\s*:\s*"([^"]+)"/,
        profileArn: /"profileArn"\s*:\s*"([^"]+)"/,
        region: /"region"\s*:\s*"([^"]+)"/,
        authMethod: /"authMethod"\s*:\s*"([^"]+)"/,
        expiresAt: /"expiresAt"\s*:\s*"([^"]+)"/,
        startUrl: /"startUrl"\s*:\s*"([^"]+)"/,
    };

    for (const [field, pattern] of Object.entries(fieldPatterns)) {
        const match = content.match(pattern);
        if (match && match[1]) {
            extracted[field] = match[1];
        }
    }

    // 至少需要 refreshToken 或 accessToken 才算有效
    if (extracted.refreshToken || extracted.accessToken) {
        logger.info(`[Kiro Auth] Extracted ${Object.keys(extracted).length} fields from corrupted JSON: ${Object.keys(extracted).join(', ')}`);
        return extracted;
    }

    return null;
}

/**
 * 解析单个工具调用文本
 * @param {string} toolCallText - 工具调用文本
 * @returns {Object|null} 解析后的工具调用对象或 null
 */
function parseSingleToolCall(toolCallText) {
    const namePattern = /\[Called\s+(\w+)\s+with\s+args:/i;
    const nameMatch = toolCallText.match(namePattern);

    if (!nameMatch) {
        return null;
    }

    const functionName = nameMatch[1].trim();
    const argsStartMarker = "with args:";
    const argsStartPos = toolCallText.toLowerCase().indexOf(argsStartMarker.toLowerCase());

    if (argsStartPos === -1) {
        return null;
    }

    const argsStart = argsStartPos + argsStartMarker.length;
    const argsEnd = toolCallText.lastIndexOf(']');

    if (argsEnd <= argsStart) {
        return null;
    }

    const jsonCandidate = toolCallText.substring(argsStart, argsEnd).trim();

    try {
        const repairedJson = repairJson(jsonCandidate);
        const argumentsObj = JSON.parse(repairedJson);

        if (typeof argumentsObj !== 'object' || argumentsObj === null) {
            return null;
        }

        const toolCallId = `call_${uuidv4().replace(/-/g, '').substring(0, 8)}`;
        return {
            id: toolCallId,
            type: "function",
            function: {
                name: functionName,
                arguments: JSON.stringify(argumentsObj)
            }
        };
    } catch (e) {
        logger.error(`Failed to parse tool call arguments: ${e.message}`, jsonCandidate);
        return null;
    }
}

function parseBracketToolCalls(responseText) {
    if (!responseText || !responseText.includes("[Called")) {
        return null;
    }

    const toolCalls = [];
    const callPositions = [];
    let start = 0;
    while (true) {
        const pos = responseText.indexOf("[Called", start);
        if (pos === -1) {
            break;
        }
        callPositions.push(pos);
        start = pos + 1;
    }

    for (let i = 0; i < callPositions.length; i++) {
        const startPos = callPositions[i];
        let endSearchLimit;
        if (i + 1 < callPositions.length) {
            endSearchLimit = callPositions[i + 1];
        } else {
            endSearchLimit = responseText.length;
        }

        const segment = responseText.substring(startPos, endSearchLimit);
        const bracketEnd = findMatchingBracket(segment, 0);

        let toolCallText;
        if (bracketEnd !== -1) {
            toolCallText = segment.substring(0, bracketEnd + 1);
        } else {
            // Fallback: if no matching bracket, try to find the last ']' in the segment
            const lastBracket = segment.lastIndexOf(']');
            if (lastBracket !== -1) {
                toolCallText = segment.substring(0, lastBracket + 1);
            } else {
                continue; // Skip this one if no closing bracket found
            }
        }
        
        const parsedCall = parseSingleToolCall(toolCallText);
        if (parsedCall) {
            toolCalls.push(parsedCall);
        }
    }
    return toolCalls.length > 0 ? toolCalls : null;
}

function deduplicateToolCalls(toolCalls) {
    const seen = new Set();
    const uniqueToolCalls = [];

    for (const tc of toolCalls) {
        const key = `${tc.function.name}-${tc.function.arguments}`;
        if (!seen.has(key)) {
            seen.add(key);
            uniqueToolCalls.push(tc);
        } else {
            logger.info(`Skipping duplicate tool call: ${tc.function.name}`);
        }
    }
    return uniqueToolCalls;
}

export class KiroApiService {
    constructor(config = {}) {
        this.isInitialized = false;
        this.config = config;
        this.credPath = config.KIRO_OAUTH_CREDS_DIR_PATH || path.join(os.homedir(), ".aws", "sso", "cache");
        this.credsBase64 = config.KIRO_OAUTH_CREDS_BASE64;
        this.uuid = config?.uuid;
        this._nodeName = config?.customName || (config?.uuid ? config.uuid.substring(0, 8) : 'unknown');
        // this.accessToken = config.KIRO_ACCESS_TOKEN;
        // this.refreshToken = config.KIRO_REFRESH_TOKEN;
        // this.clientId = config.KIRO_CLIENT_ID;
        // this.clientSecret = config.KIRO_CLIENT_SECRET;
        // this.authMethod = KIRO_CONSTANTS.AUTH_METHOD_SOCIAL;
        // this.refreshUrl = KIRO_CONSTANTS.REFRESH_URL;
        // this.refreshIDCUrl = KIRO_CONSTANTS.REFRESH_IDC_URL;
        // this.baseUrl = KIRO_CONSTANTS.BASE_URL;

        // Add kiro-oauth-creds-base64 and kiro-oauth-creds-file to config
        if (config.KIRO_OAUTH_CREDS_BASE64) {
            try {
                const decodedCreds = Buffer.from(config.KIRO_OAUTH_CREDS_BASE64, 'base64').toString('utf8');
                const parsedCreds = JSON.parse(decodedCreds);
                // Store parsedCreds to be merged in initializeAuth
                this.base64Creds = parsedCreds;
                logger.info('[Kiro] Successfully decoded Base64 credentials in constructor.');
            } catch (error) {
                logger.error(`[Kiro] Failed to parse Base64 credentials in constructor: ${error.message}`);
            }
        } else if (config.KIRO_OAUTH_CREDS_FILE_PATH) {
            this.credsFilePath = config.KIRO_OAUTH_CREDS_FILE_PATH;
        }

        this.modelName = KIRO_CONSTANTS.DEFAULT_MODEL_NAME;
        this.axiosInstance = null; // Initialize later in async method
        this.axiosSocialRefreshInstance = null;
    }
 
    async initialize() {
        if (this.isInitialized) return;
        logger.info('[Kiro] Initializing Kiro API Service...');
        // 注意：V2 读写分离架构下，初始化不再执行同步认证/刷新逻辑
        // 仅执行基础的凭证加载
        await this.loadCredentials();
        
        // 根据当前加载的凭证生成唯一的 Machine ID
        const machineId = generateMachineIdFromConfig({
            uuid: this.uuid,
            profileArn: this.profileArn,
            clientId: this.clientId
        });

        // 配置 HTTP/HTTPS agent 限制连接池大小，避免资源泄漏
        const httpAgent = new http.Agent({
            keepAlive: true,
            maxSockets: 100,        // 每个主机最多 100 个连接
            maxFreeSockets: 5,     // 最多保留 5 个空闲连接
            timeout: KIRO_CONSTANTS.AXIOS_TIMEOUT,
        });
        const httpsAgent = new https.Agent({
            keepAlive: true,
            maxSockets: 100,
            maxFreeSockets: 5,
            timeout: KIRO_CONSTANTS.AXIOS_TIMEOUT,
        });

        const isTLSSidecarEnabled = isTLSSidecarEnabledForProvider(this.config, this.config.MODEL_PROVIDER || MODEL_PROVIDER.KIRO_API);

        // Kiro 0.12.x: agent mode + User-Agent 由 authMethod 决定。
        // - SOCIAL / Builder-ID  → 'spec' + IDE JS User-Agent (官方 IDE 形态)
        // - IDC / external_idp   → 'vibe' + Rust CLI User-Agent (Q-For-CLI 形态)
        // 这里不要把 invocation-id 放到 axiosInstance 的默认 headers 里 —— 每个端点尝试都要重新生成,
        // 由 callApi / streamApiReal 的 per-request headers 负责覆盖。
        const isIdc = isKiroIdcAuth(this.authMethod);
        const agentMode = isIdc ? KIRO_CONSTANTS.AGENT_MODE_VIBE : KIRO_CONSTANTS.AGENT_MODE_SPEC;
        const userAgent = isIdc ? KIRO_CLI_USER_AGENT : getKiroUserAgent(machineId);
        const amzUserAgent = isIdc ? KIRO_CLI_AMZ_USER_AGENT : getKiroAmzUserAgent(machineId);

        const axiosConfig = {
            timeout: KIRO_CONSTANTS.AXIOS_TIMEOUT,
            headers: {
                'Content-Type': KIRO_CONSTANTS.CONTENT_TYPE_JSON,
                'Accept': KIRO_CONSTANTS.ACCEPT_JSON,
                'x-amzn-codewhisperer-optout': true,
                'x-amzn-kiro-agent-mode': agentMode,
                'x-amz-user-agent': amzUserAgent,
                'user-agent': userAgent,
                'Connection': 'close'
            },
        };

        // 如果启用了 TLS Sidecar，就不配置 httpAgent 和 httpsAgent，避免配置冲突
        if (!isTLSSidecarEnabled) {
            axiosConfig.httpAgent = httpAgent;
            axiosConfig.httpsAgent = httpsAgent;
            // 配置自定义代理
            configureAxiosProxy(axiosConfig, this.config, this.config.MODEL_PROVIDER || MODEL_PROVIDER.KIRO_API);
        }
        
        this.axiosInstance = axios.create(axiosConfig);

        // §1.2 临时打点: 拦 axios merge 之后的最终 headers, 接近 wire 形态
        this.axiosInstance.interceptors.request.use((cfg) => {
            try {
                const url = cfg.url || '';
                if (url.includes('codewhisperer') || url.includes('q.us-east-1.amazonaws.com')) {
                    const merged = (cfg.headers && typeof cfg.headers.toJSON === 'function')
                        ? cfg.headers.toJSON()
                        : { ...(cfg.headers || {}) };
                    if (merged.Authorization) merged.Authorization = '<redacted>';
                    if (merged.authorization) merged.authorization = '<redacted>';
                    logger.debug(`[Kiro] outbound headers (wire) url=${url}: ${JSON.stringify(merged)}`);
                }
            } catch (e) { /* never break the request */ }
            return cfg;
        });

        axiosConfig.headers = new Headers();
        axiosConfig.headers.set('Content-Type', KIRO_CONSTANTS.CONTENT_TYPE_JSON);
        this.axiosSocialRefreshInstance = axios.create(axiosConfig);
        this.isInitialized = true;
    }

    _applySidecar(axiosConfig) {
        return configureTLSSidecar(axiosConfig, this.config, this.config.MODEL_PROVIDER || MODEL_PROVIDER.KIRO_API);
    }

/**
 * 加载凭证信息（不执行刷新）
 */
async loadCredentials() {
    // 获取凭证文件路径
    const tokenFilePath = this.credsFilePath || path.join(this.credPath, KIRO_AUTH_TOKEN_FILE);

    // Helper to load credentials from a file
    const loadCredentialsFromFile = async (filePath) => {
        try {
            const fileContent = await fs.readFile(filePath, 'utf8');
            try {
                return JSON.parse(fileContent);
            } catch (parseError) {
                logger.warn('[Kiro Auth] JSON parse failed, attempting repair...');
                try {
                    const repaired = repairJson(fileContent);
                    const result = JSON.parse(repaired);
                    logger.info('[Kiro Auth] JSON repair successful');
                    return result;
                } catch (repairError) {
                    logger.warn('[Kiro Auth] JSON repair failed, attempting field extraction...');
                    // 尝试从损坏的 JSON 中提取关键字段
                    const extracted = extractCredentialsFromCorruptedJson(fileContent);
                    if (extracted) {
                        logger.info('[Kiro Auth] Field extraction successful, credentials recovered');
                        return extracted;
                    }
                    logger.error('[Kiro Auth] All recovery methods failed:', repairError.message);
                    return null;
                }
            }
        } catch (error) {
            if (error.code === 'ENOENT') {
                logger.debug(`[Kiro Auth] Credential file not found: ${filePath}`);
            } else {
                logger.warn(`[Kiro Auth] Failed to read credential file ${filePath}: ${error.message}`);
            }
            return null;
        }
    };

    try {
        let mergedCredentials = {};

        // Priority 1: Load from Base64 credentials if available
        if (this.base64Creds) {
            Object.assign(mergedCredentials, this.base64Creds);
            logger.info('[Kiro Auth] Successfully loaded credentials from Base64 (constructor).');
            this.base64Creds = null;
        }

        // 从文件加载
        const targetFilePath = tokenFilePath;
        const dirPath = path.dirname(targetFilePath);
        const targetFileName = path.basename(targetFilePath);

        logger.debug(`[Kiro Auth] Loading credentials from directory: ${dirPath}`);

        try {
            const targetCredentials = await loadCredentialsFromFile(targetFilePath);
            if (targetCredentials) {
                Object.assign(mergedCredentials, targetCredentials);
                logger.info(`[Kiro Auth] Successfully loaded OAuth credentials from ${targetFilePath}`);
            }

            const files = await fs.readdir(dirPath);
            for (const file of files) {
                if (file.endsWith('.json') && file !== targetFileName) {
                    const filePath = path.join(dirPath, file);
                    const credentials = await loadCredentialsFromFile(filePath);
                    if (credentials) {
                        credentials.expiresAt = mergedCredentials.expiresAt;
                        Object.assign(mergedCredentials, credentials);
                        logger.debug(`[Kiro Auth] Loaded Client credentials from ${file}`);
                    }
                }
            }
        } catch (error) {
            logger.warn(`[Kiro Auth] Error loading credentials from directory ${dirPath}: ${error.message}`);
        }

        // Apply loaded credentials. Force-refresh paths must not keep stale in-memory tokens.
        const applyCredential = (field) => {
            if (mergedCredentials[field] !== undefined && mergedCredentials[field] !== null) {
                this[field] = mergedCredentials[field];
            }
        };
        applyCredential('accessToken');
        applyCredential('refreshToken');
        applyCredential('clientId');
        applyCredential('clientSecret');
        applyCredential('authMethod');
        applyCredential('expiresAt');
        applyCredential('profileArn');
        applyCredential('region');
        applyCredential('idcRegion');

        if (!this.region) {
            logger.warn('[Kiro Auth] Region not found in credentials. Using default region us-east-1 for URLs.');
            this.region = 'us-east-1';
        }

        // idcRegion 用于 REFRESH_IDC_URL，如果未设置则使用 region
        if (!this.idcRegion) {
            this.idcRegion = this.region;
        }

        this.refreshUrl = (this.config.KIRO_REFRESH_URL || KIRO_CONSTANTS.REFRESH_URL).replace("{{region}}", this.region);
        this.refreshIDCUrl = (this.config.KIRO_REFRESH_IDC_URL || KIRO_CONSTANTS.REFRESH_IDC_URL).replace("{{region}}", this.idcRegion);
        this.baseUrl = (this.config.KIRO_BASE_URL || KIRO_CONSTANTS.BASE_URL).replace("{{region}}", this.region);
    } catch (error) {
        logger.warn(`[Kiro Auth] Error during credential loading: ${error.message}`);
    }
}

async initializeAuth(forceRefresh = false) {
    if (this.accessToken && !forceRefresh) {
        logger.debug('[Kiro Auth] Access token already available and not forced refresh.');
        return;
    }

    // 首先执行基础凭证加载
    await this.loadCredentials();

    // 只有在明确要求强制刷新，或者 AccessToken 确实缺失时，才执行刷新
    // 注意：在 V2 架构下，此方法主要由 PoolManager 的后台队列调用
    if (forceRefresh || (!this.accessToken && this.refreshToken)) {
        if (!this.refreshToken) {
            throw new Error('No refresh token available to refresh access token.');
        }

        const tokenFilePath = this.credsFilePath || path.join(this.credPath, KIRO_AUTH_TOKEN_FILE);
        await this._doTokenRefresh(this.saveCredentialsToFile.bind(this), tokenFilePath);
    }

    if (!this.accessToken) {
        throw new Error('No access token available after initialization and refresh attempts.');
    }
}

/**
 * Helper to save credentials
 */
async saveCredentialsToFile(filePath, newData) {
    let existingData = {};
    try {
        const fileContent = await fs.readFile(filePath, 'utf8');
        try {
            existingData = JSON.parse(fileContent);
        } catch (parseError) {
            logger.warn('[Kiro Auth] JSON parse failed, attempting repair...');
            try {
                const repaired = repairJson(fileContent);
                existingData = JSON.parse(repaired);
                logger.info('[Kiro Auth] JSON repair successful');
            } catch (repairError) {
                logger.warn('[Kiro Auth] JSON repair failed, attempting field extraction...');
                const extracted = extractCredentialsFromCorruptedJson(fileContent);
                if (extracted) {
                    existingData = extracted;
                    logger.info('[Kiro Auth] Field extraction successful');
                } else {
                    logger.error('[Kiro Auth] All recovery methods failed:', repairError.message);
                    existingData = {};
                }
            }
        }
    } catch (readError) {
        if (readError.code === 'ENOENT') {
            logger.debug(`[Kiro Auth] Token file not found, creating new one: ${filePath}`);
        } else {
            logger.warn(`[Kiro Auth] Could not read existing token file ${filePath}: ${readError.message}`);
        }
    }
    const mergedData = { ...existingData, ...newData };
    await atomicWriteFile(filePath, JSON.stringify(mergedData, null, 2), { encoding: 'utf8', mode: 0o600 });
    logger.info(`[Kiro Auth] Updated token file: ${filePath}`);
};

    /**
     * 执行实际的 token 刷新操作（内部方法）
     * @param {Function} saveCredentialsToFile - 保存凭证的函数
     * @param {string} tokenFilePath - 凭证文件路径
     */
    async _doTokenRefresh(saveCredentialsToFile, tokenFilePath, _retryOn502 = true) {
        try {
            const requestBody = {
                refreshToken: this.refreshToken,
            };

            const hasIdcClientCredentials = !!(this.clientId && this.clientSecret);
            const isSocialAuth = this.authMethod === KIRO_CONSTANTS.AUTH_METHOD_SOCIAL ||
                (!this.authMethod && !hasIdcClientCredentials);
            if (!this.authMethod) {
                this.authMethod = isSocialAuth ? KIRO_CONSTANTS.AUTH_METHOD_SOCIAL : 'builder-id';
                logger.warn(`[Kiro Auth] authMethod missing in credentials. Inferred ${this.authMethod} from available fields.`);
            }

            let refreshUrl = this.refreshUrl;
            if (!isSocialAuth) {
                refreshUrl = this.refreshIDCUrl;
                if (!hasIdcClientCredentials) {
                    throw new Error('IDC refresh requires clientId and clientSecret.');
                }
                requestBody.clientId = this.clientId;
                requestBody.clientSecret = this.clientSecret;
                requestBody.grantType = 'refresh_token';
            }

            let response = null;
            // 使用更短的超时时间进行 token 刷新，避免阻塞其他请求
            const refreshConfig = { timeout: KIRO_CONSTANTS.TOKEN_REFRESH_TIMEOUT };

            const axiosConfig = {
                method: 'post',
                url: refreshUrl,
                data: requestBody,
                ...refreshConfig
            };
            this._applySidecar(axiosConfig);

            try {
                if (isSocialAuth) {
                    response = await this.axiosSocialRefreshInstance.request(axiosConfig);
                    logger.info('[Kiro Auth] Token refresh social response: ok');
                } else {
                    response = await this.axiosInstance.request(axiosConfig);
                    logger.info('[Kiro Auth] Token refresh idc response: ok');
                }
            } catch (refreshErr) {
                if (_retryOn502 && refreshErr?.response?.status === 502) {
                    const proxyUrl = this.config.ACCOUNT_PROXY_URL;
                    if (proxyUrl && this.config.ACCOUNT_PROXY_DISABLED !== true) {
                        const rotated = this._rotateProxySession(proxyUrl);
                        if (rotated && this._applyProxyToInstances(rotated)) {
                            logger.warn(`[Kiro Auth][${this._nodeName}] refresh 502 from proxy, rotated session and retrying once: ${rotated.substring(rotated.indexOf('session-'), rotated.indexOf('-sessionduration') + 16)}`);
                            return await this._doTokenRefresh(saveCredentialsToFile, tokenFilePath, false);
                        }
                    }
                }
                throw refreshErr;
            }

            if (response.data && response.data.accessToken) {
                this.accessToken = response.data.accessToken;
                this.refreshToken = response.data.refreshToken || this.refreshToken;
                this.profileArn = response.data.profileArn || this.profileArn;
                const expiresIn = Number(response.data.expiresIn) || 3600;
                const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
                this.expiresAt = expiresAt;
                logger.info('[Kiro Auth] Access token refreshed successfully');

                const updatedTokenData = {
                    accessToken: this.accessToken,
                    refreshToken: this.refreshToken,
                    expiresAt: expiresAt,
                };
                if (this.profileArn) {
                    updatedTokenData.profileArn = this.profileArn;
                }
                await saveCredentialsToFile(tokenFilePath, updatedTokenData);

                // 刷新成功，重置 PoolManager 中的刷新状态并标记为健康
                const poolManager = getProviderPoolManager();
                if (poolManager && this.uuid) {
                    poolManager.resetProviderRefreshStatus(this.config.MODEL_PROVIDER || MODEL_PROVIDER.KIRO_API, this.uuid);
                }
            } else {
                throw new Error('Invalid refresh response: Missing accessToken');
            }
        } catch (error) {
            logger.error('[Kiro Auth] Token refresh failed:', error.message);
            throw new Error(`Token refresh failed: ${error.message}`);
        }
    }


    /**
     * Count tokens for a given text using Claude's official tokenizer
     * Static version for use without instance
     */
    static countTextTokens(text) {
        return countTextTokensUtil(text);
    }

    /**
     * Count tokens for a message request (compatible with Anthropic API)
     * Static version for use without instance
     */
    static countTokens(requestBody) {
        return countTokensUtil(requestBody);
    }

    /**
     * Calculate input tokens from request body
     * Static version for use without instance
     */
    static estimateInputTokens(requestBody) {
        return estimateInputTokensUtil(requestBody);
    }

    /**
     * Extract text content from OpenAI message format
     */
    getContentText(message) {
        return getContentTextUtil(message);
    }

    /**
     * 清洗 tool_use 的 input 对象，移除空字符串 key 等不合法字段
     * Kiro API 不接受空字符串 key 的 JSON 对象（如 {"": "value"}）
     */
    _sanitizeToolInput(input) {
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
            return input;
        }
        const sanitized = {};
        for (const [key, value] of Object.entries(input)) {
            if (key === '') {
                logger.info(`[Kiro] Removed empty-string key from tool input, value: ${String(value).substring(0, 100)}`);
                continue;
            }
            sanitized[key] = value;
        }
        return sanitized;
    }

    /**
     * 统一处理内容，将不同格式的内容转换为文本
     * @param {any} content - 内容对象或数组
     * @returns {string} 处理后的文本
     */
    processContent(content) {
        return processContentUtil(content);
    }

    _normalizeThinkingBudgetTokens(budgetTokens) {
        let value = Number(budgetTokens);
        if (!Number.isFinite(value) || value <= 0) {
            value = KIRO_THINKING.DEFAULT_BUDGET_TOKENS;
        }
        value = Math.floor(value);
        if (value < KIRO_THINKING.MIN_BUDGET_TOKENS) value = KIRO_THINKING.MIN_BUDGET_TOKENS;
        return Math.min(value, KIRO_THINKING.MAX_BUDGET_TOKENS);
    }

    _generateThinkingPrefix(thinking) {
        if (!thinking || typeof thinking !== 'object') return null;
        const type = String(thinking.type || '').toLowerCase().trim();

        if (type === 'enabled') {
            const budget = this._normalizeThinkingBudgetTokens(thinking.budget_tokens);
            return `<thinking_mode>enabled</thinking_mode><max_thinking_length>${budget}</max_thinking_length>`;
        }

        if (type === 'adaptive') {
            const effortRaw = typeof thinking.effort === 'string' ? thinking.effort : '';
            const effort = effortRaw.toLowerCase().trim();
            const normalizedEffort = (effort === 'low' || effort === 'medium' || effort === 'high') ? effort : 'high';
            return `<thinking_mode>adaptive</thinking_mode><thinking_effort>${normalizedEffort}</thinking_effort>`;
        }

        return null;
    }

    _hasThinkingPrefix(text) {
        if (!text) return false;
        return text.includes(KIRO_THINKING.MODE_TAG) || text.includes(KIRO_THINKING.MAX_LEN_TAG) || text.includes(KIRO_THINKING.EFFORT_TAG);
    }

    _toClaudeContentBlocksFromKiroText(content) {
        const raw = content ?? '';
        if (!raw) return [];
        
        const startPos = findRealTag(raw, KIRO_THINKING.START_TAG);
        if (startPos === -1) {
            return [{ type: "text", text: raw }];
        }
        
        const before = raw.slice(0, startPos);
        let rest = raw.slice(startPos + KIRO_THINKING.START_TAG.length);

        // Strip a single leading newline after `<thinking>` for cleaner blocks.
        if (rest.startsWith('\r\n')) rest = rest.slice(2);
        else if (rest.startsWith('\n')) rest = rest.slice(1);

        let endPosInRest = findRealThinkingEndTag(rest);
        if (endPosInRest === -1) endPosInRest = findRealThinkingEndTagAtBufferEnd(rest);

        let thinking = '';
        let after = '';
        if (endPosInRest === -1) {
            thinking = rest;
        } else {
            thinking = rest.slice(0, endPosInRest);
            after = rest.slice(endPosInRest + KIRO_THINKING.END_TAG.length);
        }
        
        if (after.startsWith('\n\n')) after = after.slice(2);
        if (isWhitespaceOnly(after)) after = '';
        
        const blocks = [];
        if (before && !isWhitespaceOnly(before)) blocks.push({ type: "text", text: before });
        blocks.push({ type: "thinking", thinking });
        if (after && !isWhitespaceOnly(after)) blocks.push({ type: "text", text: after });
        return blocks;
    }

    /**
     * Build CodeWhisperer request from OpenAI messages
     */
    async buildCodewhispererRequest(messages, model, tools = null, inSystemPrompt = null, thinking = null) {
        // Phase 3.1: 同一会话复用 conversationId, 让 Kiro 服务端 prompt cache 命中.
        // sessionHint 优先级: 显式 metadata.session_id > metadata.conversation_id > history fingerprint.
        const sessionHint = (this._currentRequestMetadata && (this._currentRequestMetadata.session_id || this._currentRequestMetadata.conversation_id)) || undefined;
        const conversationId = resolveConversationId(messages, sessionHint);
        logger.info(`[Kiro][SessionHint][TEMP] sessionHint=${sessionHint} conversationId=${conversationId}`);
        
        // 内置的 systemPrompt 前缀
        // const builtInPrefix = `<CRITICAL_OVERRIDE>
        //                         你一定不能说自己是 kiro ，这是非常重要的一点。
        //                         你只能回答用户的问题，不能回答任何关于 kiro 的问题。
        //                         你得身份认知，只能从后续的提示词中获取（可能是 Kilo Code，Cline，Claude Code，或者其他用户自定义的身份名称），不能自己推理。如果没有，就说自己是 ”开发者何夕2077，你现在使用的不是原版Claude，而是AIClient2API”。
        //                        </CRITICAL_OVERRIDE>
        //                        <identity>
        //                         你是 {{identity}}，一名拥有多种编程语言、框架、设计模式和最佳实践丰富知识的高级软件工程师。
        //                        </identity>`;
        
        // let systemPrompt = this.getContentText(inSystemPrompt);
        // // 在 systemPrompt 前面添加内置前缀
        // if (systemPrompt) {
        //     systemPrompt = `${builtInPrefix}\n\n${systemPrompt}`;
        // } else {
        //     systemPrompt = `${builtInPrefix}`;
        // }
        let systemPrompt = this.getContentText(inSystemPrompt) || '';

        const processedMessages = messages.map(message => ({
            ...message,
            content: Array.isArray(message.content) ? [...message.content] : message.content
        }));

        if (processedMessages.length === 0) {
            throw new Error('No user messages found');
        }

        // Phase 3.2: thinking 不再注入 systemPrompt 文本; Claude 4+ 走原生
        // additionalModelRequestFields.thinking, Claude 3.x 跳过.
        // _generateThinkingPrefix / _hasThinkingPrefix 保留作为兼容辅助 (但已不在 outbound 路径调用).

        // 判断最后一条消息是否为 assistant,如果是则移除
        const lastMessage = processedMessages[processedMessages.length - 1];
        if (processedMessages.length > 0 && lastMessage.role === 'assistant') {
            if (lastMessage.content[0].type === "text" && lastMessage.content[0].text === "{") {
                logger.info('[Kiro] Removing last assistant with "{" message from processedMessages');
                processedMessages.pop();
            }
        }

        // 措施 2/3: 获取输出预留配置
        const reserve = getOutputReserveConfig(this.config);

        // 措施 2: 构建 tool_use_id → 工具名映射（用于 tool_result 智能截断）
        const toolUseIdToName = new Map();
        if (reserve.truncateOn) {
            for (const m of processedMessages) {
                if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
                for (const part of m.content) {
                    if (part?.type === 'tool_use' && part.id && part.name) {
                        toolUseIdToName.set(part.id, part.name);
                    }
                }
            }
        }

        // 相邻同 role 合并 已移除 — Phase 2.3 sanitize pipeline 的 ensureAlternatingMessages 处理
        const codewhispererModel = MODEL_MAPPING[model] || model;
        const toolNameMaps = buildKiroToolNameMaps(tools);
        
        // Phase 2.5: web_search/websearch 过滤已移除 (commit 3e071d4 已迁移到 Kiro 原生 tool spec);
        // no_tool_available 占位也已移除 — 新 sanitize pipeline + normalizeToolHistory 已能处理空/未知 tool 场景.
        let toolsContext = {};
        if (tools && Array.isArray(tools) && tools.length > 0) {
            const MAX_DESCRIPTION_LENGTH = reserve.adaptiveDesc
                ? pickAdaptiveDescBudget(tools.filter(t => t.description?.trim()).length)
                : 1024*8;
            if (reserve.adaptiveDesc) {
                logger.info(`[Kiro] Adaptive tool desc: ${tools.length} tools -> ${MAX_DESCRIPTION_LENGTH} chars/tool`);
            }

            // 截断白名单：这些工具的 description 中部含有关键安全/正确性约束（如 Bash 的 git 安全协议、
            // NEVER skip hooks / NEVER force push 等），头尾保留策略会丢中部，因此对它们绕过截断。
            // 名称完全匹配（大小写敏感）。
            const TRUNCATION_WHITELIST = new Set([
                'Bash',
                'Write',
                'Edit',
                'Agent'
            ]);

            let truncatedCount = 0;
            let whitelistSkippedCount = 0;
            const kiroTools = tools
                .filter(tool => {
                    if (!tool.description || tool.description.trim() === '') {
                        logger.info(`[Kiro] Ignoring tool with empty description: ${tool.name}`);
                        return false;
                    }
                    return true;
                })
                .map(tool => {
                    let desc = tool.description || "";
                    const originalLength = desc.length;
                    const isWhitelisted = TRUNCATION_WHITELIST.has(tool.name);

                    if (desc.length > MAX_DESCRIPTION_LENGTH && isWhitelisted) {
                        whitelistSkippedCount++;
                        logger.info(`[Kiro] Whitelist: keeping tool '${tool.name}' description in full (${originalLength} chars, would have been truncated)`);
                    } else if (desc.length > MAX_DESCRIPTION_LENGTH) {
                        // 头 + 尾保留：工具描述的关键约束通常分布在开头（用途/总则）和结尾（边界规则），
                        // 中部多为示例。该策略丢中部保两端，比简单 substring 截尾损失小。
                        const placeholder = '\n\n...[omitted]...\n\n';
                        const budget = MAX_DESCRIPTION_LENGTH - placeholder.length;
                        const headLen = Math.floor(budget * 0.65);
                        const tailLen = budget - headLen;
                        let head = desc.slice(0, headLen);
                        const lastNL = head.lastIndexOf('\n');
                        if (lastNL > headLen * 0.8) head = head.slice(0, lastNL);
                        let tail = desc.slice(desc.length - tailLen);
                        const firstNL = tail.indexOf('\n');
                        if (firstNL > 0 && firstNL < tailLen * 0.2) tail = tail.slice(firstNL + 1);
                        desc = head + placeholder + tail;
                        truncatedCount++;
                        logger.info(`[Kiro] Truncated tool '${tool.name}' description (head+tail): ${originalLength} -> ${desc.length} chars`);
                    }

                    return {
                        toolSpecification: {
                            name: toolNameMaps.toKiroName(tool.name),
                            description: desc,
                            inputSchema: {
                                json: tool.input_schema || {}
                            }
                        }
                    };
                });

            if (truncatedCount > 0) {
                logger.info(`[Kiro] Truncated ${truncatedCount} tool description(s) to max ${MAX_DESCRIPTION_LENGTH} chars (head+tail policy)`);
            }
            if (whitelistSkippedCount > 0) {
                logger.info(`[Kiro] Skipped truncation for ${whitelistSkippedCount} whitelisted tool(s)`);
            }

            if (kiroTools.length > 0) {
                // Phase 3.3: 在 tools 列表末尾追加 cachePoint 标记, 启用服务端 prompt cache.
                // 参考: types.ts:308-316 (KiroToolWrapper union); 与 IDE 实际输出一致.
                kiroTools.push({ cachePoint: { type: 'default' } });
                toolsContext = { tools: kiroTools };
            }
        }

        // Phase 2.3: 构建完整 Kiro 格式对话 → sanitize → 切分尾部为 currentMessage
        // 参考: kiroApi.ts:891-916 (buildKiroPayload)
        const kiroMessages = [];

        // System prompt 作为 Human/AI pair 注入头部 (Kiro 0.12.x 缓存键稳定性)
        // 参考: translator.ts:733-749, 887-906
        if (systemPrompt) {
            const timestamp = new Date().toISOString();
            const executionDirective = `
<execution_discipline>
当用户要求执行特定任务时，你必须遵循以下纪律：
1. **目标锁定**：在整个会话中始终牢记用户的原始目标，不要在代码探索过程中迷失方向
2. **行动优先**：优先执行任务而非仅分析或总结，除非用户明确只要求分析
3. **计划执行**：为任务创建明确的步骤计划，逐步执行并标记完成状态
4. **禁止确认性收尾**：在任务未完成前，禁止输出"需要我继续吗？"、"需要深入分析吗？"等确认性问题
5. **持续推进**：如果发现部分任务已完成，立即继续执行剩余未完成的任务
6. **完整交付**：直到所有任务步骤都执行完毕才算完成
</execution_discipline>
`;
            const mutatedSystemPrompt = `[Context: Current time is ${timestamp}]\n\n${systemPrompt}\n\n${executionDirective}`;
            kiroMessages.push({
                userInputMessage: {
                    content: mutatedSystemPrompt,
                    userInputMessageContext: {},
                    origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR,
                    // Phase 3.3: 在 synthetic system-prompt user message 上挂 cachePoint, 与 tools 末尾一致,
                    // 配合稳定的 conversationId (Phase 3.1) 让服务端可复用 prompt cache.
                    cachePoint: { type: 'default' }
                }
            });
            kiroMessages.push({
                assistantResponseMessage: {
                    content: 'I will follow these instructions.'
                }
            });
        }

        // 处理所有消息(含最后一条) → Kiro 格式
        const keepImageThreshold = 5;
        for (let i = 0; i < processedMessages.length; i++) {
            const message = processedMessages[i];
            const distanceFromEnd = (processedMessages.length - 1) - i;
            const shouldKeepImages = distanceFromEnd <= keepImageThreshold;

            if (message.role === 'user') {
                let userInputMessage = {
                    content: '',
                    origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR
                };
                let imageCount = 0;
                let toolResults = [];
                let images = [];

                if (Array.isArray(message.content)) {
                    for (const part of message.content) {
                        if (part.type === 'text') {
                            userInputMessage.content += part.text;
                        } else if (part.type === 'tool_result') {
                            let trText = this.getContentText(part.content);
                            if (reserve.truncateOn && trText.length > reserve.truncateMax) {
                                const toolName = toolUseIdToName.get(part.tool_use_id) || '';
                                const r = truncateHeadTailByTool(trText, reserve.truncateMax, toolName);
                                if (r.truncated) {
                                    logger.info(`[Kiro] Truncated tool_result (tool=${toolName}, ${trText.length} -> ${r.text.length})`);
                                    trText = r.text;
                                }
                            }
                            toolResults.push({
                                content: [{ text: trText }],
                                status: 'success',
                                toolUseId: part.tool_use_id
                            });
                        } else if (part.type === 'image') {
                            if (shouldKeepImages) {
                                images.push({
                                    format: part.source.media_type.split('/')[1],
                                    source: { bytes: part.source.data }
                                });
                            } else {
                                imageCount++;
                            }
                        }
                    }
                } else {
                    userInputMessage.content = this.getContentText(message);
                }

                if (images.length > 0) {
                    userInputMessage.images = images;
                    if (distanceFromEnd > 0) {
                        logger.info(`[Kiro] Kept ${images.length} image(s) in recent history message (distance from end: ${distanceFromEnd})`);
                    }
                }

                if (imageCount > 0) {
                    const imagePlaceholder = `[此消息包含 ${imageCount} 张图片，已在历史记录中省略]`;
                    userInputMessage.content = userInputMessage.content
                        ? `${userInputMessage.content}\n${imagePlaceholder}`
                        : imagePlaceholder;
                    logger.info(`[Kiro] Replaced ${imageCount} image(s) with placeholder in old history message (distance from end: ${distanceFromEnd})`);
                }

                if (toolResults.length > 0) {
                    // 去重 — Kiro API 不接受重复的 toolUseId
                    const uniqueToolResults = [];
                    const seenIds = new Set();
                    for (const tr of toolResults) {
                        if (!seenIds.has(tr.toolUseId)) {
                            seenIds.add(tr.toolUseId);
                            uniqueToolResults.push(tr);
                        }
                    }
                    userInputMessage.userInputMessageContext = { toolResults: uniqueToolResults };
                }

                kiroMessages.push({ userInputMessage });
            } else if (message.role === 'assistant') {
                let assistantResponseMessage = { content: '' };
                let toolUses = [];
                let thinkingText = '';

                if (Array.isArray(message.content)) {
                    for (const part of message.content) {
                        if (part.type === 'text') {
                            assistantResponseMessage.content += part.text;
                        } else if (part.type === 'thinking') {
                            thinkingText += (part.thinking ?? part.text ?? '');
                        } else if (part.type === 'tool_use') {
                            toolUses.push({
                                input: this._sanitizeToolInput(part.input),
                                name: toolNameMaps.toKiroName(part.name),
                                toolUseId: part.id
                            });
                        }
                    }
                } else {
                    assistantResponseMessage.content = this.getContentText(message);
                }

                // Phase 3.2: history reasoningContent 必须丢弃 — 携带会触发 400
                // "Improperly formed request"; 也不再用 KIRO_THINKING.START_TAG/END_TAG
                // 包装为文本.思考块只在响应路径解析, 不回灌 history.
                void thinkingText;

                if (toolUses.length > 0) {
                    assistantResponseMessage.toolUses = toolUses;
                }

                kiroMessages.push({ assistantResponseMessage });
            }
        }

        // Phase 2.4: 先 flatten orphan tool_use/tool_result (引用了不在当前 tools 列表的 tool)
        const currentTools = (toolsContext && Array.isArray(toolsContext.tools)) ? toolsContext.tools : [];
        const normalized = normalizeKiroToolHistory(kiroMessages, currentTools);

        // 7-step sanitize: 保证 alternation, valid tool pairs, 以 user 结束
        let sanitized;
        try {
            sanitized = sanitizeKiroConversation(normalized);
        } catch (e) {
            logger.warn(`[Kiro] sanitizeKiroConversation failed: ${e.message} — falling back to unsanitized`);
            sanitized = normalized;
        }

        // 取尾部为 currentMessage (sanitize 保证最后是 userInputMessage)
        let currentMessageWrapper = sanitized[sanitized.length - 1];
        if (!currentMessageWrapper || !currentMessageWrapper.userInputMessage) {
            // 兜底:理论上 ensureEndsWithUserMessage 已保证不会到这
            logger.warn('[Kiro] sanitize did not yield trailing user message, synthesizing Continue');
            currentMessageWrapper = {
                userInputMessage: {
                    content: 'Continue',
                    origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR
                }
            };
            sanitized.push(currentMessageWrapper);
        }
        const history = sanitized.slice(0, -1);

        // 给 currentMessage 附加 modelId 和 tools (Phase 2.1: modelId 只在 currentMessage)
        const finalUserInputMessage = currentMessageWrapper.userInputMessage;
        finalUserInputMessage.modelId = codewhispererModel;
        if (Object.keys(toolsContext).length > 0 && toolsContext.tools) {
            finalUserInputMessage.userInputMessageContext = {
                ...(finalUserInputMessage.userInputMessageContext || {}),
                tools: toolsContext.tools
            };
        }

        const request = {
            conversationState: {
                agentTaskType: "vibe",
                chatTriggerType: KIRO_CONSTANTS.CHAT_TRIGGER_TYPE_MANUAL,
                conversationId: conversationId,
                currentMessage: { userInputMessage: finalUserInputMessage }
            }
        };

        if (history.length > 0) {
            request.conversationState.history = history;
        }


        if (this.authMethod === KIRO_CONSTANTS.AUTH_METHOD_SOCIAL) {
            request.profileArn = this.profileArn;
        }

        // Phase 3.2: native thinking via additionalModelRequestFields.
        // 仅 Claude 4+ 支持; Claude 3.x 跳过 (服务端会拒绝该字段).
        // 输入形态: { type: 'enabled', budget_tokens } | { type: 'adaptive', effort? } | { type: 'disabled' }
        // Kiro 0.12 服务端 enum 只接受 ["adaptive", "disabled"], 'enabled' 一并归到 'adaptive'.
        if (thinking && typeof thinking === 'object' && isClaudeFourOrLater(codewhispererModel)) {
            const ttype = String(thinking.type || '').toLowerCase().trim();
            if (ttype === 'enabled' || ttype === 'adaptive') {
                request.additionalModelRequestFields = {
                    thinking: { type: 'adaptive' }
                };
            }
            // type === 'disabled' 或未识别: 不下发 additionalModelRequestFields, 等同关闭
        }

        // Phase 2.6: token-budget driven history trim (避免后端 CONTENT_LENGTH_EXCEEDS_THRESHOLD).
        // effectiveLimit = model context window - buffer reserve, 至少保留 8K 给 currentMessage + tools + 输出.
        if (Array.isArray(request.conversationState.history) && request.conversationState.history.length > 0) {
            const bufferReserve = getKiroTokenBufferReserve(this.config);
            const ctxTokens = getContextTokensForModel(model, this.config, codewhispererModel);
            const effectiveLimit = Math.max(8000, ctxTokens - bufferReserve);
            const trimResult = trimHistoryByTokens(request, effectiveLimit);
            if (trimResult.trimmed > 0) {
                logger.info(`[Kiro] trimHistoryByTokens: cut ${trimResult.trimmed} message(s) over ${trimResult.iterations} iteration(s); finalTokens=${trimResult.finalTokens}, limit=${effectiveLimit} (ctx=${ctxTokens}, buffer=${bufferReserve})`);
            }
        }

        Object.defineProperty(request, '_kiroToolNameMaps', {
            value: toolNameMaps,
            enumerable: false
        });

        // 监控钩子：内部请求转换
        if (this.config?._monitorRequestId) {
            try {
                const { getPluginManager } = await import('../../core/plugin-manager.js');
                const pluginManager = getPluginManager();
                if (pluginManager) {
                    await pluginManager.executeHook('onInternalRequestConverted', {
                        requestId: this.config._monitorRequestId,
                        internalRequest: request,
                        converterName: 'buildCodewhispererRequest'
                    });
                }
            } catch (e) {
                logger.error('[Kiro] Error calling onInternalRequestConverted hook:', e.message);
            }
        }

        // fs.writeFile('claude-kiro-request'+Date.now()+'.json', JSON.stringify(request));
        return request;
    }

    parseEventStreamChunk(rawData, toolNameMaps = null) {
        const buf = Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData);
        let fullContent = '';
        let thinking = '';
        let meteringCredits = null;
        let contextUsagePercentage = null;
        const toolCalls = [];
        let currentToolCallDict = null;

        const finalizeCurrentToolCall = () => {
            if (!currentToolCallDict) return;
            try {
                const args = JSON.parse(currentToolCallDict.function.arguments);
                currentToolCallDict.function.arguments = JSON.stringify(args);
            } catch (e) {
                const repaired = repairToolInputJson(currentToolCallDict.function.arguments);
                try {
                    JSON.parse(repaired);
                    currentToolCallDict.function.arguments = repaired;
                } catch (e2) {
                    logger.warn(`[Kiro] Tool call arguments not valid JSON: ${currentToolCallDict.function.arguments}`);
                }
            }
            toolCalls.push(currentToolCallDict);
            currentToolCallDict = null;
        };

        const { events } = awsParseEventStreamFrames(buf);

        // 极少数情况下原始数据不是合法的 AWS event-stream 二进制帧
        // (如旧服务端文本 SSE 格式), 此时回退到旧的正则解析
        if (events.length === 0 && buf.length > 0) {
            logger.debug('[Kiro] AWS event-stream parser produced 0 events, falling back to legacy regex parser');
            return this._parseEventStreamChunkLegacy(buf.toString('utf8'), toolNameMaps);
        }

        for (const event of events) {
            if (event.type === 'content' && event.data) {
                fullContent += event.data;
            } else if (event.type === 'toolUse') {
                const data = event.data || {};
                // 切到不同 toolUseId 的工具调用前, 先把上一个收尾
                if (currentToolCallDict && currentToolCallDict.id !== data.toolUseId) {
                    finalizeCurrentToolCall();
                }
                if (!currentToolCallDict) {
                    currentToolCallDict = {
                        id: data.toolUseId,
                        type: 'function',
                        function: {
                            name: toolNameMaps?.fromKiroName ? toolNameMaps.fromKiroName(data.name) : data.name,
                            arguments: ''
                        }
                    };
                }
                if (data.input) {
                    currentToolCallDict.function.arguments += data.input;
                }
                if (data.stop) {
                    finalizeCurrentToolCall();
                }
            } else if (event.type === 'toolUseInput') {
                const data = event.data || {};
                if (currentToolCallDict && (!data.toolUseId || currentToolCallDict.id === data.toolUseId) && data.input) {
                    currentToolCallDict.function.arguments += data.input;
                }
            } else if (event.type === 'toolUseStop') {
                finalizeCurrentToolCall();
            } else if (event.type === 'reasoning' && event.data) {
                // Kiro 0.12 通过 reasoningContentEvent 单独推送思考链；非流式路径需要累加,
                // 由调用方根据 thinking 是否被请求决定是否产出 thinking content block。
                thinking += event.data;
            } else if (event.type === 'metering' && event.data && typeof event.data.usage === 'number') {
                // Kiro 0.12 metering.usage 是 credit 数 (number, 非 token 对象)。非流式聚合路径
                // 与流式路径保持一致: 累加 credit, 由 calculateCacheTokens 反算 cache_read / cache_creation。
                meteringCredits = (meteringCredits || 0) + event.data.usage;
            } else if (event.type === 'contextUsage' && event.data &&
                       typeof event.data.contextUsagePercentage === 'number') {
                // 非流式路径与流式同口径: 用上游 contextUsagePercentage 推 inputTokens,
                // 避免 estimateInputTokens 本地估算与 metering 反算 cache_read 不可比 ([F3])。
                contextUsagePercentage = event.data.contextUsagePercentage;
            }
        }

        // 流末尾仍有未关闭的工具调用 (服务端漏发 stop)
        if (currentToolCallDict) {
            finalizeCurrentToolCall();
        }

        // 兼容旧服务端在 content 文本中嵌入 [Called ... with args: {...}] 的格式
        const bracketToolCalls = parseBracketToolCalls(fullContent);
        if (bracketToolCalls) {
            toolCalls.push(...bracketToolCalls);
            for (const tc of bracketToolCalls) {
                const funcName = tc.function.name;
                const escapedName = funcName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const pattern = new RegExp(`\\[Called\\s+${escapedName}\\s+with\\s+args:\\s*\\{[^}]*(?:\\{[^}]*\\}[^}]*)*\\}\\]`, 'gs');
                fullContent = fullContent.replace(pattern, '');
            }
            fullContent = fullContent.trim();
        }

        const uniqueToolCalls = restoreKiroToolCallNames(deduplicateToolCalls(toolCalls), toolNameMaps);
        return { content: fullContent || '', toolCalls: uniqueToolCalls, thinking, meteringCredits, contextUsagePercentage };
    }

    _parseEventStreamChunkLegacy(rawStr, toolNameMaps = null) {
        let fullContent = '';
        const toolCalls = [];
        let currentToolCallDict = null;

        const sseEventRegex = /:message-typeevent(\{[^]*?(?=:event-type|$))/g;
        const legacyEventRegex = /event(\{.*?(?=event\{|$))/gs;

        let matches = [...rawStr.matchAll(sseEventRegex)];
        if (matches.length === 0) {
            matches = [...rawStr.matchAll(legacyEventRegex)];
        }

        for (const match of matches) {
            const potentialJsonBlock = match[1];
            if (!potentialJsonBlock || potentialJsonBlock.trim().length === 0) continue;

            let searchPos = 0;
            while ((searchPos = potentialJsonBlock.indexOf('}', searchPos + 1)) !== -1) {
                const jsonCandidate = potentialJsonBlock.substring(0, searchPos + 1).trim();
                try {
                    const eventData = JSON.parse(jsonCandidate);
                    if (eventData.name && eventData.toolUseId) {
                        if (!currentToolCallDict) {
                            currentToolCallDict = {
                                id: eventData.toolUseId,
                                type: 'function',
                                function: {
                                    name: toolNameMaps?.fromKiroName ? toolNameMaps.fromKiroName(eventData.name) : eventData.name,
                                    arguments: ''
                                }
                            };
                        }
                        if (eventData.input) {
                            currentToolCallDict.function.arguments += normalizeKiroToolInput(eventData.input);
                        }
                        if (eventData.stop) {
                            try {
                                const args = JSON.parse(currentToolCallDict.function.arguments);
                                currentToolCallDict.function.arguments = JSON.stringify(args);
                            } catch (e) {
                                const repaired = repairToolInputJson(currentToolCallDict.function.arguments);
                                try {
                                    JSON.parse(repaired);
                                    currentToolCallDict.function.arguments = repaired;
                                } catch (e2) {
                                    logger.warn(`[Kiro] Tool call arguments not valid JSON: ${currentToolCallDict.function.arguments}`);
                                }
                            }
                            toolCalls.push(currentToolCallDict);
                            currentToolCallDict = null;
                        }
                    } else if (eventData.toolUseId && eventData.input !== undefined && !eventData.name) {
                        if (currentToolCallDict && currentToolCallDict.id === eventData.toolUseId) {
                            currentToolCallDict.function.arguments += normalizeKiroToolInput(eventData.input);
                        }
                        if (eventData.stop && currentToolCallDict) {
                            try {
                                const args = JSON.parse(currentToolCallDict.function.arguments);
                                currentToolCallDict.function.arguments = JSON.stringify(args);
                            } catch (e) {
                                const repaired = repairToolInputJson(currentToolCallDict.function.arguments);
                                try {
                                    JSON.parse(repaired);
                                    currentToolCallDict.function.arguments = repaired;
                                } catch (e2) {
                                    logger.warn(`[Kiro] Tool call arguments not valid JSON: ${currentToolCallDict.function.arguments}`);
                                }
                            }
                            toolCalls.push(currentToolCallDict);
                            currentToolCallDict = null;
                        }
                    } else if (!eventData.followupPrompt && eventData.content) {
                        fullContent += eventData.content;
                    }
                    break;
                } catch (e) {
                    continue;
                }
            }
        }

        if (currentToolCallDict) toolCalls.push(currentToolCallDict);

        const bracketToolCalls = parseBracketToolCalls(fullContent);
        if (bracketToolCalls) {
            toolCalls.push(...bracketToolCalls);
            for (const tc of bracketToolCalls) {
                const funcName = tc.function.name;
                const escapedName = funcName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const pattern = new RegExp(`\\[Called\\s+${escapedName}\\s+with\\s+args:\\s*\\{[^}]*(?:\\{[^}]*\\}[^}]*)*\\}\\]`, 'gs');
                fullContent = fullContent.replace(pattern, '');
            }
            fullContent = fullContent.trim();
        }

        const uniqueToolCalls = restoreKiroToolCallNames(deduplicateToolCalls(toolCalls), toolNameMaps);
        return { content: fullContent || '', toolCalls: uniqueToolCalls, thinking: '', meteringCredits: null, contextUsagePercentage: null };
    }


    /**
     * 调用 API 并处理错误重试
     */
    async callApi(method, model, body, isRetry = false, retryCount = 0) {
        if (!this.isInitialized) await this.initialize();
        const maxRetries = this.config.REQUEST_MAX_RETRIES || 3;
        const baseDelay = this.config.REQUEST_BASE_DELAY || 1000; // 1 second base delay

        // 处理不同格式的请求体（messages 或 contents）
        let messages = body.messages;
        if (!messages && body.contents) {
            // 将 Gemini 格式的 contents 转换为 messages 格式
            messages = body.contents.map(content => ({
                role: content.role || 'user',
                content: content.parts?.map(part => part.text).join('') || ''
            }));
        }
        
        if (!messages || !Array.isArray(messages) || messages.length === 0) {
            throw new Error('No messages found in request body');
        }

        const requestData = await this.buildCodewhispererRequest(messages, model, body.tools, body.system, body.thinking);

        try {
            const token = this.accessToken; // Use the already initialized token
            const headers = {
                'Authorization': `Bearer ${token}`,
                'amz-sdk-invocation-id': `${uuidv4()}`,
                'amz-sdk-request': 'attempt=1; max=3',
            };

            // Kiro 0.12.x 三端点回退: 默认 CodeWhisperer → AmazonQ; KIRO_PREFERRED_ENDPOINT='amazonq-cli' 时仅用 AmazonQCLI
            const preferred = this.config?.KIRO_PREFERRED_ENDPOINT;
            const endpoints = getSortedEndpoints(preferred);
            const releaseThrottle = await acquireKiroRequestSlot(this.config);
            let response;
            let lastError = null;
            try {
                for (let i = 0; i < endpoints.length; i++) {
                    const endpoint = endpoints[i];
                    const isLastEndpoint = i === endpoints.length - 1;
                    const endpointPayload = applyPayloadOrigin(requestData, endpoint.origin);
                    const axiosConfig = {
                        method: 'post',
                        url: endpoint.url,
                        data: endpointPayload,
                        headers,
                        responseType: 'arraybuffer'
                    };
                    logger.debug(`[Kiro] outbound headers (callApi) endpoint=${endpoint.name}: perRequest=${JSON.stringify(axiosConfig.headers)} instanceDefaults=${JSON.stringify(this.axiosInstance?.defaults?.headers?.common || {})} instanceDefaultsPost=${JSON.stringify(this.axiosInstance?.defaults?.headers?.post || {})}`);
                    this._applySidecar(axiosConfig);
                    try {
                        response = await this.axiosInstance.request(axiosConfig);
                        if (i > 0) {
                            logger.info(`[Kiro][${this._nodeName}] Endpoint ${endpoint.name} succeeded after fallback from earlier 429.`);
                        }
                        break;
                    } catch (err) {
                        const st = err.response?.status;
                        if (st === 429 && !isLastEndpoint) {
                            const nextEp = endpoints[i + 1];
                            logger.warn(`[Kiro][${this._nodeName}] Endpoint ${endpoint.name} quota exhausted (429), trying ${nextEp.name}...`);
                            lastError = err;
                            continue;
                        }
                        throw err;
                    }
                }
            } finally {
                releaseThrottle();
            }
            if (!response) {
                throw lastError || new Error('All Kiro endpoints exhausted with no response');
            }
            response._kiroToolNameMaps = requestData._kiroToolNameMaps;
            return response;
        } catch (error) {
            const status = error.response?.status;
            const errorCode = error.code;
            const errorMessage = error.message || '';
            
            // 检查是否为可重试的网络错误
            const isNetworkError = isRetryableNetworkError(error);
            
            // Handle 401 (Unauthorized) - refresh UUID first, then try to refresh token
            if (status === 401 && !isRetry) {
                logger.info(`[Kiro][${this._nodeName}] Received 401. Refreshing UUID and triggering background refresh via PoolManager...`);
                
                // 1. 先刷新 UUID
                const newUuid = this._refreshUuid();
                if (newUuid) {
                    logger.info(`[Kiro] UUID refreshed: ${this.uuid} -> ${newUuid}`);
                    this.uuid = newUuid;
                }
                
                // 标记当前凭证为不健康（会自动进入刷新队列）
                this._markCredentialNeedRefresh('401 Unauthorized - Triggering auto-refresh');
                // Mark error for credential switch without recording error count
                error.shouldSwitchCredential = true;
                error.skipErrorCount = true;
                throw error;
            }
    
            // Handle 402 (Payment Required / Quota Exceeded) - verify usage and mark as unhealthy with recovery time
            if (status === 402 && !isRetry) {
                await this._handle402Error(error, 'callApi');
            }

            // Handle 403 (Forbidden). Most Kiro 403s are account/policy/quota/profile issues,
            // not expired access tokens, so do not blindly refresh.
            if (status === 403 && !isRetry) {
                this._handleForbiddenCredentialError(error, 'callApi');
                // Mark error for credential switch without recording error count
                error.shouldSwitchCredential = true;
                error.skipErrorCount = true;
                throw error;
            }
            
            // Handle 429 (Too Many Requests) - retry same credential, don't switch
            if (status === 429) {
                const retryAfter = this._getRetryAfter(error);
                const bodyText = this._getErrorResponseText(error);
                logger.warn(`[Kiro][${this._nodeName}] Received 429 (Too Many Requests). Retry-After=${retryAfter || 'none'}, Body=${(bodyText || '').substring(0, 800)}`);
                error.skipErrorCount = true;
                if (retryAfter) error.retryAfterMs = retryAfter;
                throw error;
            }

            // Handle 5xx server errors
            if (status >= 500 && status < 600) {
                const bodyText = this._getErrorResponseText(error);
                logger.warn(`[Kiro][${this._nodeName}] Received ${status} server error. Body=${(bodyText || '').substring(0, 800)}`);

                if (status === 502 && retryCount < maxRetries) {
                    const proxyRetry = this._tryRotateProxyAndRetryOn502(error, method, model, body, isRetry, retryCount);
                    if (proxyRetry) return proxyRetry;
                }

                error.shouldSwitchCredential = true;
                error.skipErrorCount = true;
                throw error;
            }

            // Handle network errors (ECONNRESET, ETIMEDOUT, etc.) with exponential backoff
            if (isNetworkError && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                const errorIdentifier = errorCode || errorMessage.substring(0, 50);
                logger.info(`[Kiro][${this._nodeName}] Network error (${errorIdentifier}). Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.callApi(method, model, body, isRetry, retryCount + 1);
            }

            if (error.response && error.response.data) { logger.error(`[Kiro][${this._nodeName}] 400 Response body:`, this._getErrorResponseText(error).substring(0, 500)); }
            logger.error(`[Kiro][${this._nodeName}] API call failed (Status: ${status}, Code: ${errorCode}):`, error.message);
            throw error;
        }
    }

    _getErrorResponseText(error) {
        const data = error?.response?.data;
        if (data === undefined || data === null) {
            return error?.message || '';
        }
        if (Buffer.isBuffer(data)) {
            return data.toString('utf8');
        }
        if (typeof data === 'string') {
            return data;
        }
        try {
            return JSON.stringify(data);
        } catch {
            return String(data);
        }
    }

    /**
     * 流式错误响应体读取：axios 用 responseType: 'stream' 时，error.response.data 是一个 Readable 流而不是 Buffer。
     * 需要异步读取流内容才能拿到上游真实错误消息（如 429 的 ThrottlingException、token limit、配额耗尽等）。
     */
    async _readErrorResponseBody(error, timeoutMs = 2000) {
        const data = error?.response?.data;
        if (data && typeof data.on === 'function') {
            try {
                const chunks = [];
                await new Promise((resolve) => {
                    data.on('data', (c) => chunks.push(c));
                    data.on('end', resolve);
                    data.on('error', resolve);
                    setTimeout(resolve, timeoutMs);
                });
                return Buffer.concat(chunks).toString('utf8');
            } catch (e) {
                return `(stream body read failed: ${e.message})`;
            }
        }
        return this._getErrorResponseText(error);
    }

    _getRetryAfter(error) {
        return error?.response?.headers?.['retry-after']
            || error?.response?.headers?.['Retry-After']
            || null;
    }

    _rotateProxySession(proxyUrl) {
        const regex = /session-([a-zA-Z0-9_]+)-sessionduration/;
        if (!regex.test(proxyUrl)) return null;
        const chars = 'abcdefghijklmnopqrstuvwxyz';
        let s = '';
        for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
        return proxyUrl.replace(regex, `session-${s}-sessionduration`);
    }

    _applyProxyToInstances(proxyUrl) {
        const pc = parseProxyUrl(proxyUrl);
        if (!pc) return false;

        this.config.ACCOUNT_PROXY_URL = proxyUrl;

        if (this.axiosInstance) {
            this.axiosInstance.defaults.httpAgent = pc.httpsAgent;
            this.axiosInstance.defaults.httpsAgent = pc.httpsAgent;
        }
        if (this.axiosSocialRefreshInstance) {
            this.axiosSocialRefreshInstance.defaults.httpAgent = pc.httpsAgent;
            this.axiosSocialRefreshInstance.defaults.httpsAgent = pc.httpsAgent;
        }

        try {
            const poolManager = getProviderPoolManager();
            if (poolManager) {
                poolManager._debouncedSave(this.config.MODEL_PROVIDER || MODEL_PROVIDER.KIRO_API);
            }
        } catch (e) {
            logger.debug(`[Kiro][${this._nodeName}] _applyProxyToInstances persist skipped: ${e.message}`);
        }
        return true;
    }

    _tryRotateProxyAndRetryOn502(error, method, model, body, isRetry, retryCount, isStream = false) {
        const status = error.response?.status;
        if (status !== 502) return null;
        const proxyUrl = this.config.ACCOUNT_PROXY_URL;
        if (!proxyUrl || this.config.ACCOUNT_PROXY_DISABLED === true) return null;
        const rotated = this._rotateProxySession(proxyUrl);
        if (!rotated) return null;

        if (!this._applyProxyToInstances(rotated)) return null;
        logger.warn(`[Kiro][${this._nodeName}] 502 from proxy, rotated session: ${rotated.substring(rotated.indexOf('session-'), rotated.indexOf('-sessionduration') + 16)}`);

        if (isStream) {
            return this.streamApiReal(method, model, body, isRetry, retryCount + 1);
        }
        return this.callApi(method, model, body, isRetry, retryCount + 1);
    }

    _isRefreshableForbidden(error) {
        const text = this._getErrorResponseText(error).toLowerCase();
        if (!text) return false;

        const nonRefreshablePatterns = [
            'temporarily is suspended',
            'temporarily suspended',
            'disabled',
            'violation of terms',
            'terms of service',
            'appeal',
            'quota',
            'limit exceeded',
            'payment required',
            'not authorized to access',
            'not allowed'
        ];
        if (nonRefreshablePatterns.some(pattern => text.includes(pattern))) {
            return false;
        }

        const tokenRelated = text.includes('token') ||
            text.includes('authorization') ||
            text.includes('authenticate') ||
            text.includes('credential');
        const refreshableAuthState = text.includes('expired') ||
            text.includes('invalid') ||
            text.includes('unauthorized');

        return tokenRelated && refreshableAuthState;
    }

    _handleForbiddenCredentialError(error, context) {
        const responseText = this._getErrorResponseText(error);
        const responseSnippet = responseText ? responseText.substring(0, 500) : '';

        if (responseSnippet) {
            logger.warn(`[Kiro] 403 response body (${context}): ${responseSnippet}`);
        }

        if (this._isRefreshableForbidden(error)) {
            logger.info(`[Kiro] Received token-related 403 in ${context}. Marking credential as needs refresh.`);
            this._markCredentialNeedRefresh(`403 Forbidden (${context}) - token-related${responseSnippet ? `: ${responseSnippet}` : ''}`, error);
        } else {
            logger.info(`[Kiro] Received non-refreshable 403 in ${context}. Marking credential as unhealthy without refresh.`);
            this._markCredentialUnhealthy(`403 Forbidden (${context})${responseSnippet ? `: ${responseSnippet}` : ''}`, error);
        }
    }

    /**
     * Helper method to refresh the current credential's UUID
     * Used when encountering 401 errors to get a fresh identity
     * @returns {string|null} - The new UUID, or null if refresh failed
     * @private
     */
    _refreshUuid() {
        const poolManager = getProviderPoolManager();
        if (poolManager && this.uuid) {
            const newUuid = poolManager.refreshProviderUuid(this.config.MODEL_PROVIDER || MODEL_PROVIDER.KIRO_API, {
                uuid: this.uuid
            });
            return newUuid;
        } else {
            logger.warn(`[Kiro] Cannot refresh UUID: poolManager=${!!poolManager}, uuid=${this.uuid}`);
            return null;
        }
    }

    /**
     * Helper method to mark the current credential as unhealthy
     * @param {string} reason - The reason for marking unhealthy
     * @param {Error} [error] - Optional error object to attach the marker to
     * @returns {boolean} - Whether the credential was successfully marked as unhealthy
     * @private
     */
    _markCredentialNeedRefresh(reason, error = null) {
        const poolManager = getProviderPoolManager();
        if (poolManager && this.uuid) {
            logger.info(`[Kiro] Marking credential ${this.uuid} as needs refresh. Reason: ${reason}`);
            // 使用新的 markProviderNeedRefresh 方法代替 markProviderUnhealthyImmediately
            poolManager.markProviderNeedRefresh(this.config.MODEL_PROVIDER || MODEL_PROVIDER.KIRO_API, {
                uuid: this.uuid
            });
            // Attach marker to error object to prevent duplicate marking in upper layers
            if (error) {
                error.credentialMarkedUnhealthy = true;
            }
            return true;
        } else {
            logger.warn(`[Kiro] Cannot mark credential as unhealthy: poolManager=${!!poolManager}, uuid=${this.uuid}`);
            return false;
        }
    }
    
    /**
     * Helper method to mark the current credential as unhealthy
     * @param {string} reason - The reason for marking unhealthy
     * @param {Error} [error] - Optional error object to attach the marker to
     * @returns {boolean} - Whether the credential was successfully marked as unhealthy
     * @private
     */
    _markCredentialUnhealthy(reason, error = null) {
        const poolManager = getProviderPoolManager();
        if (poolManager && this.uuid) {
            logger.info(`[Kiro] Marking credential ${this.uuid} as unhealthy. Reason: ${reason}`);
            poolManager.markProviderUnhealthyImmediately(this.config.MODEL_PROVIDER || MODEL_PROVIDER.KIRO_API, {
                uuid: this.uuid
            }, reason);
            // Attach marker to error object to prevent duplicate marking in upper layers
            if (error) {
                error.credentialMarkedUnhealthy = true;
            }
            return true;
        } else {
            logger.warn(`[Kiro] Cannot mark credential as unhealthy: poolManager=${!!poolManager}, uuid=${this.uuid}`);
            return false;
        }
    }

    /**
     * Helper method to mark the current credential as unhealthy with a scheduled recovery time
     * Used for quota exhaustion (402) where quota resets at a specific time (e.g., 1st of next month)
     * @param {string} reason - The reason for marking unhealthy
     * @param {Error} [error] - Optional error object to attach the marker to
     * @param {Date} [recoveryTime] - The time when the credential should be marked healthy again
     * @returns {boolean} - Whether the credential was successfully marked as unhealthy
     * @private
     */
    _markCredentialUnhealthyWithRecovery(reason, error = null, recoveryTime = null) {
        const poolManager = getProviderPoolManager();
        if (poolManager && this.uuid) {
            logger.info(`[Kiro] Marking credential ${this.uuid} as unhealthy with recovery time. Reason: ${reason}, Recovery: ${recoveryTime?.toISOString()}`);
            poolManager.markProviderUnhealthyWithRecoveryTime(this.config.MODEL_PROVIDER || MODEL_PROVIDER.KIRO_API, {
                uuid: this.uuid
            }, reason, recoveryTime);
            // Attach marker to error object to prevent duplicate marking in upper layers
            if (error) {
                error.credentialMarkedUnhealthy = true;
            }
            return true;
        } else {
            logger.warn(`[Kiro] Cannot mark credential as unhealthy: poolManager=${!!poolManager}, uuid=${this.uuid}`);
            return false;
        }
    }

    /**
     * 计算下月1日 00:00:00 UTC 时间
     * @returns {Date} 下月1日的 Date 对象
     * @private
     */
    _getNextMonthFirstDay() {
        const now = new Date();
        return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
    }

    /**
     * 处理 402 错误（配额耗尽）
     * 验证用量限制并标记凭证为不健康，设置恢复时间为下月1日
     * @param {Error} error - 原始错误对象
     * @param {string} context - 错误发生的上下文（如 'callApi', 'stream'）
     * @throws {Error} 抛出带有切换凭证标记的错误
     * @private
     */
    async _handle402Error(error, context = 'unknown') {
        logger.info(`[Kiro] Received 402 (Quota Exceeded) in ${context}. Verifying usage limits...`);
        try {
            // Verify usage limits to confirm quota exhaustion
            const usageLimits = await this.getUsageLimits();

            logger.info(`[Kiro] Quota confirmed exhausted: ${usageLimits?.usedCount}/${usageLimits?.limitCount}`);
            // Calculate recovery time: 1st day of next month at 00:00:00 UTC
            const nextMonth = this._getNextMonthFirstDay();
            this._markCredentialUnhealthyWithRecovery('402 Payment Required - Quota Exhausted', error, nextMonth);
        } catch (usageError) {
            logger.warn('[Kiro] Failed to verify usage limits:', usageError.message);
            // If we can't verify, still mark as unhealthy with recovery time
            const nextMonth = this._getNextMonthFirstDay();
            this._markCredentialUnhealthyWithRecovery('402 Payment Required - Quota Exceeded (unverified)', error, nextMonth);
        }
        // Mark error for credential switch without recording error count
        error.shouldSwitchCredential = true;
        error.skipErrorCount = true;
        throw error;
    }

    _processApiResponse(response) {
        const toolNameMaps = response?._kiroToolNameMaps;
        const rawBuffer = Buffer.isBuffer(response.data)
            ? response.data
            : Buffer.from(response.data ?? '', 'binary');
        // 文本视图仅用于 legacy bracket tool-call 扫描和 [Called marker 检测,这两者只关心 ASCII,
        // 即使 utf8 decode 把高字节替换为 U+FFFD 也不影响。真正的 event-stream 解析必须走 rawBuffer。
        const rawResponseText = rawBuffer.toString('utf8');
        if (rawResponseText.includes("[Called")) {
            logger.info("[Kiro] Raw response contains [Called marker.");
        }

        // 1. Parse structured events and bracket calls from parsed content
        const parsedFromEvents = this.parseEventStreamChunk(rawBuffer, toolNameMaps);
        let fullResponseText = parsedFromEvents.content;
        let allToolCalls = [...parsedFromEvents.toolCalls]; // clone
        const thinking = parsedFromEvents.thinking || '';
        const meteringCredits = parsedFromEvents.meteringCredits || null;
        const contextUsagePercentage = parsedFromEvents.contextUsagePercentage ?? null;
        //logger.info(`[Kiro] Found ${allToolCalls.length} tool calls from event stream parsing.`);

        // 2. Crucial fix from Python example: Parse bracket tool calls from the original raw response
        const rawBracketToolCalls = parseBracketToolCalls(rawResponseText);
        if (rawBracketToolCalls) {
            //logger.info(`[Kiro] Found ${rawBracketToolCalls.length} bracket tool calls in raw response.`);
            allToolCalls.push(...restoreKiroToolCallNames(rawBracketToolCalls, toolNameMaps));
        }

        // 3. Deduplicate all collected tool calls
        const uniqueToolCalls = deduplicateToolCalls(allToolCalls);
        //logger.info(`[Kiro] Total unique tool calls after deduplication: ${uniqueToolCalls.length}`);

        // 4. Clean up response text by removing all tool call syntax from the final text.
        // The text from parseEventStreamChunk is already partially cleaned.
        // We re-clean here with all unique tool calls to be certain.
        if (uniqueToolCalls.length > 0) {
            for (const tc of uniqueToolCalls) {
                const funcName = tc.function.name;
                const escapedName = funcName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const pattern = new RegExp(`\\[Called\\s+${escapedName}\\s+with\\s+args:\\s*\\{[^}]*(?:\\{[^}]*\\}[^}]*)*\\}\\]`, 'gs');
                fullResponseText = fullResponseText.replace(pattern, '');
            }
            fullResponseText = fullResponseText.trim();
        }
        
        // 5. Final content cleanup: convert escaped newlines to literal newlines (诊断：仅在检测到时解码并打日志)
        if (/(?<!\\)\\n/.test(fullResponseText)) {
            logger.warn(`[Kiro] Decoded escaped \\n in aggregated non-stream response (len=${fullResponseText.length})`);
            fullResponseText = fullResponseText.replace(/(?<!\\)\\n/g, '\n');
        }
        
        //logger.info(`[Kiro] Final response text after tool call cleanup: ${fullResponseText}`);
        //logger.info(`[Kiro] Final tool calls after deduplication: ${JSON.stringify(uniqueToolCalls)}`);
        return { responseText: fullResponseText, toolCalls: uniqueToolCalls, thinking, meteringCredits, contextUsagePercentage };
    }

    async generateContent(model, requestBody) {
        if (!this.isInitialized) await this.initialize();

        this._currentRequestMetadata = requestBody?.metadata || null;

        // 临时存储 monitorRequestId
        if (requestBody._monitorRequestId) {
            this.config._monitorRequestId = requestBody._monitorRequestId;
            delete requestBody._monitorRequestId;
        }
        if (requestBody._requestBaseUrl) {
            delete requestBody._requestBaseUrl;
        }

        // 检查 token 是否即将过期，如果是则推送到刷新队列
        if (this.isExpiryDateNear()) {
            logger.info('[Kiro] Token is near expiry, marking credential as need refresh...');
            this._markCredentialNeedRefresh('Token near expiry in generateContent');
        }

        const finalModel = MODEL_MAPPING[model] ? model : model;
        logger.info(`[Kiro] Calling generateContent with model: ${finalModel}`);

        // Estimate input tokens before making the API call (fallback if contextUsagePercentage not received)
        const estimatedInputTokens = this.estimateInputTokens(requestBody);

        const response = await this.callApi('', finalModel, requestBody);

        try {
            const { responseText, toolCalls, thinking, meteringCredits, contextUsagePercentage } = this._processApiResponse(response);
            const thinkingType = requestBody?.thinking?.type;
            const thinkingRequested = typeof thinkingType === 'string' &&
                (thinkingType.toLowerCase() === 'enabled' || thinkingType.toLowerCase() === 'adaptive');
            let contentForClaude;
            if (thinkingRequested) {
                const blocks = [];
                if (thinking && thinking.length > 0) {
                    blocks.push({ type: 'thinking', thinking });
                }
                if (responseText && responseText.length > 0) {
                    blocks.push({ type: 'text', text: responseText });
                }
                contentForClaude = blocks.length > 0 ? blocks : responseText;
            } else {
                contentForClaude = responseText;
            }
            // 输出 token 估算: 用最终交付给客户端的内容
            let estOutputTokens = 0;
            if (Array.isArray(contentForClaude)) {
                for (const b of contentForClaude) {
                    if (b && typeof b === 'object') {
                        if (typeof b.text === 'string') estOutputTokens += this.countTextTokens(b.text);
                        if (typeof b.thinking === 'string') estOutputTokens += this.countTextTokens(b.thinking);
                    }
                }
            } else if (typeof contentForClaude === 'string') {
                estOutputTokens = this.countTextTokens(contentForClaude);
            }
            if (Array.isArray(toolCalls)) {
                for (const tc of toolCalls) {
                    if (tc?.function?.arguments) estOutputTokens += this.countTextTokens(tc.function.arguments);
                }
            }
            // [F3] 与流式 (claude-kiro.js:3912-3920) 同口径: 优先用上游 contextUsagePercentage 推 inputTokens,
            // 否则回落到本地 estimateInputTokens。两条路径同分母, calculateCacheTokens 反算结果可比。
            let inputTokens;
            if (contextUsagePercentage !== null && contextUsagePercentage > 0) {
                const contextTokens = getContextTokensForModel(model, this.config, finalModel);
                const totalTokens = Math.round(contextTokens * contextUsagePercentage / 100);
                inputTokens = Math.max(0, totalTokens - estOutputTokens);
                logger.info(`[Kiro] Non-stream token calc from contextUsagePercentage: total=${totalTokens}, output=${estOutputTokens}, input=${inputTokens}`);
            } else {
                inputTokens = estimatedInputTokens;
            }
            const { cacheCreationTokens, cacheReadTokens } = calculateCacheTokens(meteringCredits, inputTokens, estOutputTokens, model);
            const cacheTokens = { cacheCreationTokens, cacheReadTokens };
            return this.buildClaudeResponse(contentForClaude, false, 'assistant', model, toolCalls, inputTokens, cacheTokens);
        } catch (error) {
            logger.error('[Kiro] Error in generateContent:', error);
            throw error;
        }
    }

    /**
     * 委托到 `awsParseEventStreamFrames`，保留为 method 是为了便于子类 override 和测试 mock。
     * 入参：Buffer。返回：{ events: 已解析事件数组, remaining: 未处理完的 Buffer }。
     */
    parseAwsEventStreamFrames(buf) {
        return awsParseEventStreamFrames(buf);
    }

    /**
     * 真正的流式 API 调用 - 使用 responseType: 'stream'
     */
    async * streamApiReal(method, model, body, isRetry = false, retryCount = 0) {
        if (!this.isInitialized) await this.initialize();
        const maxRetries = this.config.REQUEST_MAX_RETRIES || 3;
        const baseDelay = this.config.REQUEST_BASE_DELAY || 1000;

        // 处理不同格式的请求体（messages 或 contents）
        let messages = body.messages;
        if (!messages && body.contents) {
            // 将 Gemini 格式的 contents 转换为 messages 格式
            messages = body.contents.map(content => ({
                role: content.role || 'user',
                content: content.parts?.map(part => part.text).join('') || ''
            }));
        }
        
        if (!messages || !Array.isArray(messages) || messages.length === 0) {
            throw new Error('No messages found in request body');
        }

        const requestData = await this.buildCodewhispererRequest(messages, model, body.tools, body.system, body.thinking);
        const toolNameMaps = requestData._kiroToolNameMaps;

        const token = this.accessToken;
        const invocationId = uuidv4();
        const headers = {
            'Authorization': `Bearer ${token}`,
            'amz-sdk-invocation-id': invocationId,
            'amz-sdk-request': 'attempt=1; max=3',
        };

        // Kiro 0.12.x 三端点回退: 默认 CodeWhisperer → AmazonQ; KIRO_PREFERRED_ENDPOINT='amazonq-cli' 时仅用 AmazonQCLI
        const preferred = this.config?.KIRO_PREFERRED_ENDPOINT;
        const endpoints = getSortedEndpoints(preferred);

        let stream = null;
        let releaseThrottle = () => {};
        // 流模式总超时(覆盖 axiosInstance 默认 AXIOS_TIMEOUT 120s),首字节阶段使用此值
        const streamTotalTimeout = this.config?.KIRO_STREAM_TIMEOUT_MS || KIRO_CONSTANTS.STREAM_TOTAL_TIMEOUT;
        // 首字节到达后切换到 socket inactivity 超时
        const streamInactivityTimeout = this.config?.KIRO_STREAM_INACTIVITY_MS || KIRO_CONSTANTS.STREAM_INACTIVITY_TIMEOUT;
        try {
            releaseThrottle = await acquireKiroRequestSlot(this.config);
            let response = null;
            let lastReqError = null;
            for (let i = 0; i < endpoints.length; i++) {
                const endpoint = endpoints[i];
                const isLastEndpoint = i === endpoints.length - 1;
                const endpointPayload = applyPayloadOrigin(requestData, endpoint.origin);
                const axiosConfig = {
                    method: 'post',
                    url: endpoint.url,
                    data: endpointPayload,
                    headers,
                    responseType: 'stream',
                    timeout: streamTotalTimeout
                };
                logger.debug(`[Kiro] outbound headers (streamApiReal) endpoint=${endpoint.name}: perRequest=${JSON.stringify(axiosConfig.headers)} instanceDefaults=${JSON.stringify(this.axiosInstance?.defaults?.headers?.common || {})} instanceDefaultsPost=${JSON.stringify(this.axiosInstance?.defaults?.headers?.post || {})}`);
                this._applySidecar(axiosConfig);
                try {
                    response = await this.axiosInstance.request(axiosConfig);
                    if (i > 0) {
                        logger.info(`[Kiro][${this._nodeName}] Stream endpoint ${endpoint.name} succeeded after fallback from earlier 429.`);
                    }
                    break;
                } catch (err) {
                    const st = err.response?.status;
                    if (st === 429 && !isLastEndpoint) {
                        const nextEp = endpoints[i + 1];
                        logger.warn(`[Kiro][${this._nodeName}] Stream endpoint ${endpoint.name} quota exhausted (429), trying ${nextEp.name}...`);
                        lastReqError = err;
                        continue;
                    }
                    throw err;
                }
            }
            if (!response) {
                throw lastReqError || new Error('All Kiro endpoints exhausted with no stream response');
            }

            stream = response.data;
            let buffer = Buffer.alloc(0);
            let lastContentEvent = null;
            let socketAborted = false;
            let lastRawChunk = null;
            let totalRawBytes = 0;
            let chunkCount = 0;

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
            // 监听 underlying socket 的 abort/error,作为截断信号源之一
            const onSocketAborted = () => { socketAborted = true; };
            if (stream && typeof stream.on === 'function') {
                stream.on('aborted', onSocketAborted);
                stream.on('error', onSocketAborted);
            }

            try {
                let firstByteSeen = false;
                for await (const chunk of stream) {
                    // 首字节到达后,切换到 socket inactivity 模式
                    // (避免 Kiro 冷启动 / 排队的首字节延迟被误判为截断)
                    if (!firstByteSeen) {
                        firstByteSeen = true;
                        try {
                            const sock = stream.socket || (typeof stream.req?.socket !== 'undefined' ? stream.req.socket : null);
                            if (sock && typeof sock.setTimeout === 'function') {
                                sock.setTimeout(streamInactivityTimeout);
                                sock.on('timeout', () => {
                                    socketAborted = true;
                                    try { stream.destroy(new Error('socket inactivity timeout')); } catch (e) {}
                                });
                            }
                        } catch (e) { /* socket 可能已不可用,忽略 */ }
                    }
                    // 诊断：记录 raw chunk 用于事后分析
                    if (!chunk) continue;
                    const chunkBuf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                    if (chunkBuf.length > 0) {
                        lastRawChunk = chunkBuf;
                        totalRawBytes += chunkBuf.length;
                        chunkCount++;
                    }

                    if (captureFs && captureFilePath) {
                        try { captureFs.appendFileSync(captureFilePath, chunkBuf); } catch (e) { /* ignore */ }
                    }

                    // 已知 O(n²) 拼接，本轮不做 BufferList 优化；当前样本 < 1MB 无感，
                    // 未来若日志显示 totalRawBytes > 10MB 才需要重构成链表式 BufferList。
                    buffer = buffer.length === 0 ? chunkBuf : Buffer.concat([buffer, chunkBuf]);

                    // 解析缓冲区中的事件
                    const { events, remaining } = this.parseAwsEventStreamFrames(buffer);
                    buffer = remaining;

                    // yield 所有事件，但过滤连续完全相同的 content 事件（Kiro API 有时会重复发送）
                    for (const event of events) {
                        if (event.type === 'content' && event.data) {
                            // 检查是否与上一个 content 事件完全相同
                            if (lastContentEvent === event.data) {
                                // 跳过重复的内容
                                continue;
                            }
                            lastContentEvent = event.data;
                            yield { type: 'content', content: event.data };
                        } else if (event.type === 'toolUse') {
                            const toolUse = {
                                ...event.data,
                                name: toolNameMaps?.fromKiroName ? toolNameMaps.fromKiroName(event.data?.name) : event.data?.name
                            };
                            yield { type: 'toolUse', toolUse };
                        } else if (event.type === 'toolUseInput') {
                            yield { type: 'toolUseInput', input: event.data.input };
                        } else if (event.type === 'toolUseStop') {
                            yield { type: 'toolUseStop', stop: event.data.stop };
                        } else if (event.type === 'contextUsage') {
                            yield { type: 'contextUsage', contextUsagePercentage: event.data.contextUsagePercentage };
                        } else if (event.type === 'reasoning') {
                            yield { type: 'reasoning', text: event.data };
                        } else if (event.type === 'metering') {
                            yield { type: 'metering', credits: event.data.usage };
                        }
                    }
                }
            } finally {
                // 卸载 socket 监听,避免泄漏
                if (stream && typeof stream.off === 'function') {
                    try { stream.off('aborted', onSocketAborted); } catch (e) {}
                    try { stream.off('error', onSocketAborted); } catch (e) {}
                }
            }
            // 诊断：记录流结束时的 buffer 状态
            if (buffer.length > 0) {
                const head = buffer.subarray(0, 200);
                logger.warn(`[Kiro Stream] Raw stream ended with remaining buffer (${buffer.length} bytes), head.hex=${head.toString('hex')}, head.utf8=${JSON.stringify(head.toString('utf8'))}`);
            }
            // 诊断：dump 最后一个 raw chunk 的尾部 (hex + ascii)，识别 AWS event-stream 控制帧
            if (lastRawChunk && lastRawChunk.length > 0) {
                const tail = lastRawChunk.subarray(Math.max(0, lastRawChunk.length - 256));
                const hexDump = tail.toString('hex');
                const asciiDump = tail.toString('utf8').replace(/[\x00-\x1f\x7f-\xff]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
                logger.info(`[Kiro Stream] Last raw chunk diagnostic: chunkCount=${chunkCount}, totalRawBytes=${totalRawBytes}, lastChunkLen=${lastRawChunk.length}, tail.hex=${hexDump.substring(0, 512)}, tail.ascii=${asciiDump.substring(0, 256)}`);
            }
            // 多源 truncated 信号: buffer 残留 OR socket abort
            // (axios 抛错走 catch 路径,不会到达这里)
            const truncated = buffer.length > 0 || socketAborted;
            if (truncated) {
                logger.warn(`[Kiro Stream] Detected truncation: bufferRemain=${buffer.length}, socketAborted=${socketAborted}`);
            }
            yield { type: '__kiroStreamEnd', truncated, bufferRemain: buffer.length, socketAborted };
        } catch (error) {
            // 确保出错时关闭流
            if (stream && typeof stream.destroy === 'function') {
                stream.destroy();
            }
            
            const status = error.response?.status;
            const errorCode = error.code;
            const errorMessage = error.message || '';
            
            // 检查是否为可重试的网络错误
            const isNetworkError = isRetryableNetworkError(error);
            
            // Handle 401 (Unauthorized) - try to refresh token first
            if (status === 401 && !isRetry) {
                logger.info('[Kiro] Received 401 in stream. Triggering background refresh via PoolManager...');
                
                // 1. 先刷新 UUID
                const newUuid = this._refreshUuid();
                if (newUuid) {
                    logger.info(`[Kiro] UUID refreshed: ${this.uuid} -> ${newUuid}`);
                    this.uuid = newUuid;
                }
                // 标记当前凭证为不健康（会自动进入刷新队列）
                this._markCredentialNeedRefresh('401 Unauthorized in stream - Triggering auto-refresh');
                // Mark error for credential switch without recording error count
                error.shouldSwitchCredential = true;
                error.skipErrorCount = true;
                throw error;
            }
            
            // Handle 402 (Payment Required / Quota Exceeded) - verify usage and mark as unhealthy with recovery time
            if (status === 402 && !isRetry) {
                await this._handle402Error(error, 'stream');
            }

            // Handle 403 (Forbidden). Most Kiro 403s are account/policy/quota/profile issues,
            // not expired access tokens, so do not blindly refresh.
            if (status === 403 && !isRetry) {
                this._handleForbiddenCredentialError(error, 'stream');
                // Mark error for credential switch without recording error count
                error.shouldSwitchCredential = true;
                error.skipErrorCount = true;
                throw error;
            }
            
            // Handle 429 (Too Many Requests) - retry same credential, don't switch
            if (status === 429) {
                const retryAfter = this._getRetryAfter(error);
                const bodyText = await this._readErrorResponseBody(error);
                logger.warn(`[Kiro][${this._nodeName}] Received 429 (Too Many Requests) in stream. Retry-After=${retryAfter || 'none'}, Body=${(bodyText || '').substring(0, 800)}`);
                error.skipErrorCount = true;
                if (retryAfter) error.retryAfterMs = retryAfter;
                throw error;
            }

            // Handle 5xx server errors
            if (status >= 500 && status < 600) {
                const bodyText = await this._readErrorResponseBody(error);
                logger.warn(`[Kiro][${this._nodeName}] Received ${status} server error in stream. Body=${(bodyText || '').substring(0, 800)}`);

                if (status === 502 && retryCount < maxRetries) {
                    const proxyRetry = this._tryRotateProxyAndRetryOn502(error, method, model, body, isRetry, retryCount, true);
                    if (proxyRetry) { yield* proxyRetry; return; }
                }

                error.shouldSwitchCredential = true;
                error.skipErrorCount = true;
                throw error;
            }

            // Handle network errors (ECONNRESET, ETIMEDOUT, etc.) with exponential backoff
            if (isNetworkError && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                const errorIdentifier = errorCode || errorMessage.substring(0, 50);
                logger.info(`[Kiro][${this._nodeName}] Network error (${errorIdentifier}) in stream. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                yield* this.streamApiReal(method, model, body, isRetry, retryCount + 1);
                return;
            }

            logger.error(`[Kiro][${this._nodeName}] Stream API call failed (Status: ${status}, Code: ${errorCode}):`,  error.message);
            throw error;
        } finally {
            releaseThrottle();
            // 确保流被关闭，释放资源
            if (stream && typeof stream.destroy === 'function') {
                stream.destroy();
            }
        }
    }

    // 保留旧的非流式方法用于 generateContent
    async streamApi(method, model, body, isRetry = false, retryCount = 0) {
        try {
            return await this.callApi(method, model, body, isRetry, retryCount);
        } catch (error) {
            logger.error('[Kiro] Error calling API:', error);
            throw error;
        }
    }

    // 真正的流式传输实现
    async * generateContentStream(model, requestBody) {
        if (!this.isInitialized) await this.initialize();

        this._currentRequestMetadata = requestBody?.metadata || null;

        // 临时存储 monitorRequestId
        if (requestBody._monitorRequestId) {
            this.config._monitorRequestId = requestBody._monitorRequestId;
            delete requestBody._monitorRequestId;
        }
        if (requestBody._requestBaseUrl) {
            delete requestBody._requestBaseUrl;
        }
        
        // 检查 token 是否即将过期，如果是则推送到刷新队列
        if (this.isExpiryDateNear()) {
            logger.info('[Kiro] Token is near expiry, marking credential as need refresh...');
            this._markCredentialNeedRefresh('Token near expiry in generateContentStream');
        }
        
        const finalModel = MODEL_MAPPING[model] ? model : model;
        logger.info(`[Kiro] Calling generateContentStream with model: ${finalModel} (real streaming)`);

        let inputTokens = 0;
        let contextUsagePercentage = null;
        let meteringCredits = null;
        const messageId = `${uuidv4()}`;

        const thinkingType = requestBody?.thinking?.type;
        const thinkingRequested = typeof thinkingType === 'string' &&
            (thinkingType.toLowerCase() === 'enabled' || thinkingType.toLowerCase() === 'adaptive');

        const streamState = {
            thinkingRequested,
            buffer: '',
            pendingTextBeforeThinking: '',
            inThinking: false,
            thinkingExtracted: false,
            thinkingBlockIndex: null,
            textBlockIndex: null,
            nextBlockIndex: 0,
            stoppedBlocks: new Set(),
            stripThinkingLeadingNewline: false,
            stripTextLeadingNewlinesAfterThinking: false,
            hasVisibleText: false,
            hasThinkingContent: false,
        };

        const ensureBlockStart = (blockType) => {
            if (blockType === 'thinking') {
                if (streamState.thinkingBlockIndex != null) return [];
                const idx = streamState.nextBlockIndex++;
                streamState.thinkingBlockIndex = idx;
                return [{
                    type: "content_block_start",
                    index: idx,
                    content_block: { type: "thinking", thinking: "" }
                }];
            }
            if (blockType === 'text') {
                if (streamState.textBlockIndex != null) return [];
                const idx = streamState.nextBlockIndex++;
                streamState.textBlockIndex = idx;
                return [{
                    type: "content_block_start",
                    index: idx,
                    content_block: { type: "text", text: "" }
                }];
            }
            return [];
        };

        const stopBlock = (index) => {
            if (index == null) return [];
            if (streamState.stoppedBlocks.has(index)) return [];
            streamState.stoppedBlocks.add(index);
            return [{ type: "content_block_stop", index }];
        };

        const createTextDeltaEvents = (text) => {
            if (!text) return [];
            if (!isWhitespaceOnly(text)) {
                streamState.hasVisibleText = true;
            }
            const events = [];
            events.push(...ensureBlockStart('text'));
            // 诊断：仅在检测到 2 字符 \n 转义序列时才解码并打日志
            // aws-event-stream-parser.js 已经 JSON.parse 过，正常情况下不应该再含 2 字符 \n
            const hasEscapedNewline = /(?<!\\)\\n/.test(text);
            const decodedText = hasEscapedNewline
                ? text.replace(/(?<!\\)\\n/g, '\n')
                : text;
            if (hasEscapedNewline) {
                logger.warn(`[Kiro Stream] Decoded escaped \\n in text chunk (len=${text.length}, sample=${JSON.stringify(text.slice(0, 80))})`);
            }
            events.push({
                type: "content_block_delta",
                index: streamState.textBlockIndex,
                delta: { type: "text_delta", text: decodedText }
            });
            return events;
        };

        const createThinkingDeltaEvents = (thinking) => {
            if (thinking) {
                streamState.hasThinkingContent = true;
            }
            const events = [];
            events.push(...ensureBlockStart('thinking'));
            // 诊断：仅在检测到 2 字符 \n 转义序列时才解码并打日志
            const hasEscapedNewline = /(?<!\\)\\n/.test(thinking);
            const decodedThinking = hasEscapedNewline
                ? thinking.replace(/(?<!\\)\\n/g, '\n')
                : thinking;
            if (hasEscapedNewline) {
                logger.warn(`[Kiro Stream] Decoded escaped \\n in thinking chunk (len=${thinking.length})`);
            }
            events.push({
                type: "content_block_delta",
                index: streamState.thinkingBlockIndex,
                delta: { type: "thinking_delta", thinking: decodedThinking }
            });
            return events;
        };

        function* pushEvents(events) {
            for (const ev of events) {
                yield ev;
            }
        }

        try {
            const streamStartMs = Date.now();
            let totalContent = '';
            let outputTokens = 0;
            const toolCalls = [];
            let currentToolCall = null; // 用于累积结构化工具调用
            const toolUseBlockIndexes = new Map(); // toolUseId -> content block index
            let wasTruncated = false;  // 上游流是否被截断的多源 OR 信号
            let streamEndInfo = { bufferRemain: 0, socketAborted: false };

            const estimatedInputTokens = this.estimateInputTokens(requestBody);

            // 1. 先发送 message_start 事件
            yield {
                type: "message_start",
                message: {
                    id: messageId,
                    type: "message",
                    role: "assistant",
                    model: model,
                    usage: {
                        input_tokens: estimatedInputTokens,
                        output_tokens: 0,
                        cache_creation_input_tokens: 0,
                        cache_read_input_tokens: 0
                    },
                    content: []
                }
            };

            // 2. 流式接收并发送每个 content_block_delta
            for await (const event of this.streamApiReal('', finalModel, requestBody)) {
                if (event.type === '__kiroStreamEnd') {
                    // 内部控制事件: 收集 truncated 信号, 不向下游 emit
                    wasTruncated = wasTruncated || !!event.truncated;
                    streamEndInfo = { bufferRemain: event.bufferRemain || 0, socketAborted: !!event.socketAborted };
                    continue;
                }
                if (event.type === 'contextUsage' && event.contextUsagePercentage) {
                    // 捕获上下文使用百分比（包含输入和输出的总使用量）
                    contextUsagePercentage = event.contextUsagePercentage;
                } else if (event.type === 'metering' && typeof event.credits === 'number') {
                    meteringCredits = event.credits;
                } else if (event.type === 'content' && event.content) {
                    totalContent += event.content;

                    if (!thinkingRequested) {
                        streamState.buffer += event.content;
                        // 确保不切断转义序列 \\n（如果以 \ 结尾，可能后面跟着 n）
                        if (streamState.buffer.endsWith('\\')) {
                            continue;
                        }
                        yield* pushEvents(createTextDeltaEvents(streamState.buffer));
                        streamState.buffer = '';
                        continue;
                    }

                    streamState.buffer += event.content;
                    const events = [];

                    while (streamState.buffer.length > 0) {
                        if (!streamState.inThinking && !streamState.thinkingExtracted) {
                            const startPos = findRealTag(streamState.buffer, KIRO_THINKING.START_TAG);
                            if (startPos !== -1) {
                                const before = streamState.buffer.slice(0, startPos);
                                const beforeCombined = `${streamState.pendingTextBeforeThinking}${before}`;
                                // Avoid creating meaningless text blocks before thinking.
                                if (beforeCombined && !isWhitespaceOnly(beforeCombined)) {
                                    events.push(...createTextDeltaEvents(beforeCombined));
                                }
                                streamState.pendingTextBeforeThinking = '';

                                streamState.buffer = streamState.buffer.slice(startPos + KIRO_THINKING.START_TAG.length);
                                streamState.inThinking = true;
                                streamState.stripThinkingLeadingNewline = true;
                                continue;
                            }

                            const safeLen = Math.max(0, streamState.buffer.length - KIRO_THINKING.START_TAG.length);
                            if (safeLen > 0) {
                                const safeText = streamState.buffer.slice(0, safeLen);
                                if (safeText) {
                                    if (isWhitespaceOnly(safeText)) {
                                        // Buffer whitespace until we know whether a thinking block appears.
                                        // This prevents a leading text block from being created before thinking.
                                        const maxKeep = 1024;
                                        const remaining = maxKeep - streamState.pendingTextBeforeThinking.length;
                                        if (remaining > 0) {
                                            streamState.pendingTextBeforeThinking += safeText.slice(0, remaining);
                                        }
                                    } else {
                                        const combined = `${streamState.pendingTextBeforeThinking}${safeText}`;
                                        streamState.pendingTextBeforeThinking = '';
                                        events.push(...createTextDeltaEvents(combined));
                                    }
                                }
                                streamState.buffer = streamState.buffer.slice(safeLen);
                            }
                            break;
                        }

                        if (streamState.inThinking) {
                            // Strip a single leading newline after `<thinking>` (may be split across chunks).
                            if (streamState.stripThinkingLeadingNewline) {
                                if (streamState.buffer.startsWith('\r\n')) {
                                    streamState.buffer = streamState.buffer.slice(2);
                                    streamState.stripThinkingLeadingNewline = false;
                                } else if (streamState.buffer.startsWith('\n')) {
                                    streamState.buffer = streamState.buffer.slice(1);
                                    streamState.stripThinkingLeadingNewline = false;
                                } else if (streamState.buffer.length > 0) {
                                    streamState.stripThinkingLeadingNewline = false;
                                }
                            }

                            let endPos = findRealThinkingEndTag(streamState.buffer);
                            if (endPos === -1) endPos = findRealThinkingEndTagAtBufferEnd(streamState.buffer);
                            if (endPos !== -1) {
                                const thinkingPart = streamState.buffer.slice(0, endPos);
                                if (thinkingPart) events.push(...createThinkingDeltaEvents(thinkingPart));

                                streamState.buffer = streamState.buffer.slice(endPos + KIRO_THINKING.END_TAG.length);
                                streamState.inThinking = false;
                                streamState.thinkingExtracted = true;
                                streamState.stripThinkingLeadingNewline = false;

                                events.push(...createThinkingDeltaEvents(""));
                                events.push(...stopBlock(streamState.thinkingBlockIndex));

                                // Strip '\n\n' after the end tag once we switch back to text (may arrive in next chunk).
                                streamState.stripTextLeadingNewlinesAfterThinking = true;
                                continue;
                            }

                            const safeLen = Math.max(0, streamState.buffer.length - KIRO_THINKING.END_TAG.length);
                            if (safeLen > 0) {
                                const safeThinking = streamState.buffer.slice(0, safeLen);
                                if (safeThinking) events.push(...createThinkingDeltaEvents(safeThinking));
                                streamState.buffer = streamState.buffer.slice(safeLen);
                            }
                            break;
                        }

                        if (streamState.thinkingExtracted) {
                            let rest = streamState.buffer;
                            streamState.buffer = '';
                            if (streamState.stripTextLeadingNewlinesAfterThinking) {
                                if (rest.startsWith('\r\n\r\n')) rest = rest.slice(4);
                                else if (rest.startsWith('\n\n')) rest = rest.slice(2);
                                streamState.stripTextLeadingNewlinesAfterThinking = false;
                            }
                            if (rest) events.push(...createTextDeltaEvents(rest));
                            break;
                        }
                    }

                    yield* pushEvents(events);
                } else if (event.type === 'reasoning' && event.text) {
                    // reasoningContentEvent: 根据客户端是否请求 thinking 来路由
                    if (thinkingRequested) {
                        // 客户端请求了 thinking，走 thinking 管道
                        yield* pushEvents(createThinkingDeltaEvents(event.text));
                    } else {
                        // 客户端未请求 thinking，当作普通文本输出
                        totalContent += event.text;
                        streamState.buffer += event.text;
                        if (streamState.buffer.endsWith('\\')) {
                            continue;
                        }
                        yield* pushEvents(createTextDeltaEvents(streamState.buffer));
                        streamState.buffer = '';
                    }
                } else if (event.type === 'toolUse') {
                    const tc = event.toolUse;
                    const toolEvents = [];

                    // 统计工具调用的内容到 totalContent（用于 token 计算）
                    if (tc.name) totalContent += tc.name;
                    if (tc.input) totalContent += tc.input;

                    // 工具调用事件（包含 name 和 toolUseId）
                    if (tc.name && tc.toolUseId) {
                        // 遇到工具调用时，立即关闭文本块，避免前端等待到流结束才看到 content_block_stop
                        toolEvents.push(...stopBlock(streamState.textBlockIndex));

                        // 同一工具调用续传
                        if (currentToolCall && currentToolCall.toolUseId === tc.toolUseId) {
                            currentToolCall.input += tc.input || '';
                        } else {
                            // 切换到新的工具调用前，先收尾旧调用
                            if (currentToolCall) {
                                const prevBlockIndex = toolUseBlockIndexes.get(currentToolCall.toolUseId);
                                let parsedInput = currentToolCall.input;
                                try {
                                    parsedInput = JSON.parse(currentToolCall.input);
                                } catch (e) {
                                    const repaired = repairToolInputJson(currentToolCall.input);
                                    try { parsedInput = JSON.parse(repaired); } catch (e2) {}
                                }
                                if (!isIncompleteFileToolCall(currentToolCall.name, parsedInput)) {
                                    toolCalls.push({
                                        toolUseId: currentToolCall.toolUseId,
                                        name: currentToolCall.name,
                                        input: parsedInput
                                    });
                                } else {
                                    logger.warn(`[Kiro Stream] Dropping truncated tool call '${currentToolCall.name}' at tool switch`);
                                }
                                if (prevBlockIndex != null) {
                                    toolEvents.push({ type: "content_block_stop", index: prevBlockIndex });
                                    toolUseBlockIndexes.delete(currentToolCall.toolUseId);
                                }
                            }

                            const blockIndex = streamState.nextBlockIndex++;
                            toolUseBlockIndexes.set(tc.toolUseId, blockIndex);
                            toolEvents.push({
                                type: "content_block_start",
                                index: blockIndex,
                                content_block: {
                                    type: "tool_use",
                                    id: tc.toolUseId || `tool_${uuidv4()}`,
                                    name: tc.name,
                                    input: {}
                                }
                            });

                            currentToolCall = {
                                toolUseId: tc.toolUseId,
                                name: tc.name,
                                input: ''
                            };
                            currentToolCall.input += tc.input || '';
                        }

                        // 实时向前端推送工具参数增量
                        if (tc.input) {
                            const blockIndex = toolUseBlockIndexes.get(tc.toolUseId);
                            if (blockIndex != null) {
                                toolEvents.push({
                                    type: "content_block_delta",
                                    index: blockIndex,
                                    delta: {
                                        type: "input_json_delta",
                                        partial_json: tc.input
                                    }
                                });
                            }
                        }

                        // 如果这个事件包含 stop，立即结束当前工具块
                        if (tc.stop && currentToolCall) {
                            let parsedInput = currentToolCall.input;
                            try {
                                parsedInput = JSON.parse(currentToolCall.input);
                            } catch (e) {
                                const repaired = repairToolInputJson(currentToolCall.input);
                                try { parsedInput = JSON.parse(repaired); } catch (e2) {}
                            }

                            if (isIncompleteFileToolCall(currentToolCall.name, parsedInput)) {
                                logger.warn(`[Kiro Stream] Dropping truncated tool call '${currentToolCall.name}' at tc.stop`);
                            } else {
                                toolCalls.push({
                                    toolUseId: currentToolCall.toolUseId,
                                    name: currentToolCall.name,
                                    input: parsedInput
                                });
                            }

                            const blockIndex = toolUseBlockIndexes.get(currentToolCall.toolUseId);
                            if (blockIndex != null) {
                                toolEvents.push({ type: "content_block_stop", index: blockIndex });
                                toolUseBlockIndexes.delete(currentToolCall.toolUseId);
                            }
                            currentToolCall = null;
                        }
                    }

                    if (toolEvents.length > 0) {
                        yield* pushEvents(toolEvents);
                    }
                } else if (event.type === 'toolUseInput') {
                    // 工具调用的 input 续传事件
                    const inputDelta = normalizeKiroToolInput(event.input);
                    // 统计 input 内容到 totalContent（用于 token 计算）
                    if (inputDelta) {
                        totalContent += inputDelta;
                    }
                    if (currentToolCall) {
                        currentToolCall.input += inputDelta;
                        const blockIndex = toolUseBlockIndexes.get(currentToolCall.toolUseId);
                        if (blockIndex != null && inputDelta) {
                            yield* pushEvents([{
                                type: "content_block_delta",
                                index: blockIndex,
                                delta: {
                                    type: "input_json_delta",
                                    partial_json: inputDelta
                                }
                            }]);
                        }
                    }
                } else if (event.type === 'toolUseStop') {
                    // 工具调用结束事件
                    if (currentToolCall && event.stop) {
                        let parsedInput = currentToolCall.input;
                        try {
                            parsedInput = JSON.parse(currentToolCall.input);
                        } catch (e) {
                            const repaired = repairToolInputJson(currentToolCall.input);
                            try { parsedInput = JSON.parse(repaired); } catch (e2) {}
                        }

                        const blockIndex = toolUseBlockIndexes.get(currentToolCall.toolUseId);
                        if (isIncompleteFileToolCall(currentToolCall.name, parsedInput)) {
                            logger.warn(`[Kiro Stream] Dropping truncated tool call '${currentToolCall.name}' at stop event`);
                        } else {
                            toolCalls.push({
                                toolUseId: currentToolCall.toolUseId,
                                name: currentToolCall.name,
                                input: parsedInput
                            });
                        }

                        if (blockIndex != null) {
                            yield* pushEvents([{ type: "content_block_stop", index: blockIndex }]);
                            toolUseBlockIndexes.delete(currentToolCall.toolUseId);
                        }
                        currentToolCall = null;
                    }
                } else {
                    logger.debug('[Kiro Stream] Unknown event type:', event.type, JSON.stringify(event).substring(0, 200));
                }
            }
            
            // 处理未完成的工具调用（如果流提前结束）
            if (currentToolCall) {
                let parsedInput = currentToolCall.input;
                try {
                    parsedInput = JSON.parse(currentToolCall.input);
                } catch (e) {
                    const repaired = repairToolInputJson(currentToolCall.input);
                    try { parsedInput = JSON.parse(repaired); } catch (e2) {}
                }
                const blockIndex = toolUseBlockIndexes.get(currentToolCall.toolUseId);
                if (isIncompleteFileToolCall(currentToolCall.name, parsedInput)) {
                    logger.warn(`[Kiro Stream] Dropping truncated tool call '${currentToolCall.name}' (missing content). Input keys: ${typeof parsedInput === 'object' ? Object.keys(parsedInput).join(',') : 'unparsed'}`);
                    if (blockIndex != null) {
                        yield* pushEvents([{ type: "content_block_stop", index: blockIndex }]);
                        toolUseBlockIndexes.delete(currentToolCall.toolUseId);
                    }
                } else {
                    toolCalls.push({
                        toolUseId: currentToolCall.toolUseId,
                        name: currentToolCall.name,
                        input: parsedInput
                    });
                    if (blockIndex != null) {
                        yield* pushEvents([{ type: "content_block_stop", index: blockIndex }]);
                        toolUseBlockIndexes.delete(currentToolCall.toolUseId);
                    }
                }
                currentToolCall = null;
            }

            if (thinkingRequested && (streamState.inThinking || streamState.buffer || streamState.pendingTextBeforeThinking)) {
                if (streamState.inThinking) {
                    logger.warn('[Kiro] Incomplete thinking tag at stream end');
                    // Strip a single leading newline after `<thinking>` if we haven't yet.
                    if (streamState.stripThinkingLeadingNewline) {
                        if (streamState.buffer.startsWith('\r\n')) streamState.buffer = streamState.buffer.slice(2);
                        else if (streamState.buffer.startsWith('\n')) streamState.buffer = streamState.buffer.slice(1);
                        streamState.stripThinkingLeadingNewline = false;
                    }
                    yield* pushEvents(createThinkingDeltaEvents(streamState.buffer));
                    streamState.buffer = '';
                    yield* pushEvents(createThinkingDeltaEvents(""));
                    yield* pushEvents(stopBlock(streamState.thinkingBlockIndex));
                } else if (!streamState.thinkingExtracted) {
                    const remaining = `${streamState.pendingTextBeforeThinking}${streamState.buffer}`;
                    streamState.pendingTextBeforeThinking = '';
                    if (remaining) yield* pushEvents(createTextDeltaEvents(remaining));
                    streamState.buffer = '';
                } else {
                    let remaining = streamState.buffer;
                    streamState.buffer = '';
                    if (streamState.stripTextLeadingNewlinesAfterThinking) {
                        if (remaining.startsWith('\r\n\r\n')) remaining = remaining.slice(4);
                        else if (remaining.startsWith('\n\n')) remaining = remaining.slice(2);
                        streamState.stripTextLeadingNewlinesAfterThinking = false;
                    }
                    if (remaining) yield* pushEvents(createTextDeltaEvents(remaining));
                    streamState.buffer = '';
                }
            } else if (!thinkingRequested && streamState.buffer) {
                // 处理非思考模式下剩余的缓冲区数据
                yield* pushEvents(createTextDeltaEvents(streamState.buffer));
                streamState.buffer = '';
            }

            const emittedOnlyThinking = thinkingRequested &&
                streamState.hasThinkingContent &&
                !streamState.hasVisibleText &&
                toolCalls.length === 0;
            if (emittedOnlyThinking) {
                logger.warn('[Kiro Stream] Thinking-only response received; not injecting any fallback text');
            }

            yield* pushEvents(stopBlock(streamState.thinkingBlockIndex));
            yield* pushEvents(stopBlock(streamState.textBlockIndex));

            // 诊断：记录流的最终状态
            logger.info(`[Kiro Stream] Stream completed. hasVisibleText=${streamState.hasVisibleText}, hasThinkingContent=${streamState.hasThinkingContent}, toolCalls=${toolCalls.length}, totalContentLength=${totalContent.length}, contextUsagePercentage=${contextUsagePercentage}`);

            // 检查文本内容中的 bracket 格式工具调用
            const bracketToolCalls = parseBracketToolCalls(totalContent);
            if (bracketToolCalls && bracketToolCalls.length > 0) {
                for (const btc of bracketToolCalls) {
                    toolCalls.push({
                        toolUseId: btc.id || `tool_${uuidv4()}`,
                        name: btc.function.name,
                        input: JSON.parse(btc.function.arguments || '{}')
                    });
                }
            }

            // 3. 工具调用在流中实时发送，这里不再批量补发

            // 计算 output tokens
            // 注意: totalContent 已经在流处理过程中累加了工具调用的 name/input
            // (见 streamApiReal 中 toolUse 事件分支), 这里不应再次累加 tc.input,
            // 否则会双计导致 Claude Code 客户端误触发 64K 硬限。
            const contentBlocksForCount = thinkingRequested
                ? this._toClaudeContentBlocksFromKiroText(totalContent)
                : [{ type: "text", text: totalContent }];
            const plainForCount = contentBlocksForCount
                .map(b => (b.type === 'thinking' ? (b.thinking ?? '') : (b.text ?? '')))
                .join('');
            outputTokens = this.countTextTokens(plainForCount);

            // 防御性观测: 仅记录, 不夹紧值, 避免长期低估开销
            if (outputTokens > 60000) {
                logger.warn(`[Kiro Stream] output_tokens=${outputTokens} exceeds Claude Code soft limit (60K). Real long output or estimation drift.`);
            }

            // 计算 input tokens
            // contextUsagePercentage 是包含输入和输出的总使用量百分比
            // 总 token = TOTAL_CONTEXT_TOKENS * contextUsagePercentage / 100
            // input token = 总 token - output token
            if (contextUsagePercentage !== null && contextUsagePercentage > 0) {
                const contextTokens = getContextTokensForModel(model, this.config, finalModel);
                const totalTokens = Math.round(contextTokens * contextUsagePercentage / 100);
                inputTokens = Math.max(0, totalTokens - outputTokens);
                logger.info(`[Kiro] Token calculation from contextUsagePercentage: total=${totalTokens}, output=${outputTokens}, input=${inputTokens}`);
            } else {
                logger.warn('[Kiro Stream] contextUsagePercentage not received, using estimation');
                inputTokens = estimatedInputTokens;
            }

            // 4. 反算缓存 token
            const { cacheCreationTokens, cacheReadTokens } = calculateCacheTokens(meteringCredits, inputTokens, outputTokens, model);
            // Claude API 语义: total_input = input_tokens + cache_creation + cache_read
            const nonCachedInputTokens = Math.max(0, inputTokens - cacheCreationTokens - cacheReadTokens);

            // 措施 1: 上下文压力膨胀（仅 message_delta）
            const reserve = getOutputReserveConfig(this.config);
            const inflationDelta = reserve.pressureFactor > 1.0
                ? Math.max(1000, Math.round(inputTokens * (reserve.pressureFactor - 1)))
                : 0;
            const reportedNonCached = nonCachedInputTokens + inflationDelta;
            if (inflationDelta > 0) {
                logger.info(`[Kiro Pressure] message_delta: realInput=${inputTokens} nonCached=${nonCachedInputTokens} reported=${reportedNonCached} delta=${inflationDelta}`);
            }

            // 5. 发送 message_delta 事件
            // 重要：不要把上游截断 / thinking-only 报为 max_tokens，
            // 否则 Claude Code 客户端会误判为输出超 64K 上限并弹错误对话框。
            // 上游截断和 thinking-only 在语义上更接近自然结束 (end_turn) + 日志告警。
            const stopReason = toolCalls.length > 0 ? "tool_use" : "end_turn";
            if (wasTruncated && toolCalls.length === 0) {
                logger.warn(`[Kiro Stream] Upstream truncated; reporting stop_reason=end_turn (avoid client 64K max_tokens error)`);
            }
            if (emittedOnlyThinking) {
                logger.warn(`[Kiro Stream] Thinking-only response; reporting stop_reason=end_turn`);
            }
            logger.info(`[Kiro Stream] STREAM_SUMMARY model=${finalModel} stopReason=${stopReason} truncated=${wasTruncated} bufferRemain=${streamEndInfo.bufferRemain} socketAborted=${streamEndInfo.socketAborted} toolCalls=${toolCalls.length} outTok=${outputTokens} visibleText=${streamState.hasVisibleText} thinkingOnly=${emittedOnlyThinking} durMs=${Date.now() - streamStartMs}`);
            yield {
                type: "message_delta",
                delta: { stop_reason: stopReason },
                usage: {
                    input_tokens: reportedNonCached,
                    output_tokens: outputTokens,
                    cache_creation_input_tokens: cacheCreationTokens,
                    cache_read_input_tokens: cacheReadTokens
                }
            };

            // 6. 发送 message_stop 事件
            yield { type: "message_stop" };

        } catch (error) {
            logger.error('[Kiro] Error in streaming generation:', error);
            throw error;
        }
    }

    /**
     * Count tokens for a given text using Claude's official tokenizer
     */
    countTextTokens(text) {
        return KiroApiService.countTextTokens(text);
    }

    /**
     * Calculate input tokens from request body using Claude's official tokenizer
     */
    estimateInputTokens(requestBody) {
        return KiroApiService.estimateInputTokens(requestBody);
    }

    /**
     * Build Claude compatible response object
     */
    buildClaudeResponse(content, isStream = false, role = 'assistant', model, toolCalls = null, inputTokens = 0, cacheTokens = null) {
        const messageId = `${uuidv4()}`;

        if (isStream) {
            // Kiro API is "pseudo-streaming", so we'll send a few events to simulate
            // a full Claude stream, but the content/tool_calls will be sent in one go.
            const events = [];

            // 1. message_start event
            events.push({
                type: "message_start",
                message: {
                    id: messageId,
                    type: "message",
                    role: role,
                    model: model,
                    usage: {
                        input_tokens: inputTokens,
                        output_tokens: 0 // Will be updated in message_delta
                    },
                    content: [] // Content will be streamed via content_block_delta
                }
            });
 
            let totalOutputTokens = 0;
            let stopReason = "end_turn";

            if (content) {
                // If there are tool calls AND content, the content block index should be after tool calls
                const contentBlockIndex = (toolCalls && toolCalls.length > 0) ? toolCalls.length : 0;

                // 2. content_block_start for text
                events.push({
                    type: "content_block_start",
                    index: contentBlockIndex,
                    content_block: {
                        type: "text",
                        text: "" // Initial empty text
                    }
                });
                // 3. content_block_delta for text
                events.push({
                    type: "content_block_delta",
                    index: contentBlockIndex,
                    delta: {
                        type: "text_delta",
                        text: content
                    }
                });
                // 4. content_block_stop
                events.push({
                    type: "content_block_stop",
                    index: contentBlockIndex
                });
                totalOutputTokens += this.countTextTokens(content);
                // If there are tool calls, the stop reason remains "tool_use".
                // If only content, it's "end_turn".
                if (!toolCalls || toolCalls.length === 0) {
                    stopReason = "end_turn";
                }
            }

            if (toolCalls && toolCalls.length > 0) {
                toolCalls.forEach((tc, index) => {
                    let inputObject;
                    try {
                        // Arguments should be a stringified JSON object, need to parse it
                        const args = tc.function.arguments;
                        inputObject = typeof args === 'string' ? JSON.parse(args) : args;
                    } catch (e) {
                        logger.warn(`[Kiro] Invalid JSON for tool call arguments. Wrapping in raw_arguments. Error: ${e.message}`, tc.function.arguments);
                        // If parsing fails, wrap the raw string in an object as a fallback,
                        // since Claude's `input` field expects an object.
                        inputObject = { "raw_arguments": tc.function.arguments };
                    }
                    // 2. content_block_start for each tool_use
                    events.push({
                        type: "content_block_start",
                        index: index,
                        content_block: {
                            type: "tool_use",
                            id: tc.id,
                            name: tc.function.name,
                            input: {} // input is streamed via input_json_delta
                        }
                    });

                    // 3. content_block_delta for each tool_use
                    // Since Kiro is not truly streaming, we send the full arguments as one delta.
                    events.push({
                        type: "content_block_delta",
                        index: index,
                        delta: {
                            type: "input_json_delta",
                            partial_json: JSON.stringify(inputObject)
                        }
                    });

                    // 4. content_block_stop for each tool_use
                    events.push({
                        type: "content_block_stop",
                        index: index
                    });
                    totalOutputTokens += this.countTextTokens(JSON.stringify(inputObject));
                });
                stopReason = "tool_use"; // If there are tool calls, the stop reason is tool_use
            }

            // 5. message_delta with appropriate stop reason
            events.push({
                type: "message_delta",
                delta: {
                    stop_reason: stopReason,
                    stop_sequence: null,
                },
                usage: { output_tokens: totalOutputTokens }
            });

            // 6. message_stop event
            events.push({
                type: "message_stop"
            });

            return events; // Return an array of events for streaming
        } else {
            // Non-streaming response (full message object)
            const contentArray = [];
            let outputTokens = 0;

            // 1) Content blocks (text/thinking) first.
            let hasTextContent = false;
            let hasThinkingContent = false;
            if (Array.isArray(content)) {
                for (const block of content) {
                    if (!block || typeof block !== 'object') continue;
                    if (block.type === 'text' && typeof block.text === 'string') {
                        contentArray.push({ type: 'text', text: block.text });
                        outputTokens += this.countTextTokens(block.text);
                        if (!isWhitespaceOnly(block.text)) hasTextContent = true;
                    } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
                        contentArray.push({ type: 'thinking', thinking: block.thinking });
                        outputTokens += this.countTextTokens(block.thinking);
                        if (block.thinking) hasThinkingContent = true;
                    } else if (typeof block.text === 'string' && block.text) {
                        // Best-effort fallback for unknown blocks carrying plain text.
                        contentArray.push({ type: 'text', text: block.text });
                        outputTokens += this.countTextTokens(block.text);
                        if (!isWhitespaceOnly(block.text)) hasTextContent = true;
                    }
                }
            } else if (content) {
                contentArray.push({ type: "text", text: content });
                outputTokens += this.countTextTokens(content);
                if (!isWhitespaceOnly(content)) hasTextContent = true;
            }

            // 2) Append tool_use blocks (if any).
            let stopReason = "end_turn";
            if (toolCalls && toolCalls.length > 0) {
                for (const tc of toolCalls) {
                    let inputObject;
                    try {
                        // Arguments should be a stringified JSON object, need to parse it
                        const args = tc.function.arguments;
                        inputObject = typeof args === 'string' ? JSON.parse(args) : args;
                    } catch (e) {
                        logger.warn(`[Kiro] Invalid JSON for tool call arguments. Wrapping in raw_arguments. Error: ${e.message}`, tc.function.arguments);
                        // If parsing fails, wrap the raw string in an object as a fallback,
                        // since Claude's `input` field expects an object.
                        inputObject = { "raw_arguments": tc.function.arguments };
                    }
                    contentArray.push({
                        type: "tool_use",
                        id: tc.id,
                        name: tc.function.name,
                        input: inputObject
                    });
                    outputTokens += this.countTextTokens(tc.function.arguments);
                }
                stopReason = "tool_use"; // Set stop_reason to "tool_use" when toolCalls exist
            }

            if (hasThinkingContent && !hasTextContent && (!toolCalls || toolCalls.length === 0)) {
                logger.warn('[Kiro] Thinking-only response in non-streaming mode; no fallback text injected, keeping stop_reason=end_turn');
                // 不再设置 stopReason = "max_tokens"，避免 Claude Code 客户端误触发 64K 上限错误
            }

            // Claude API 语义: total_input = input_tokens + cache_creation + cache_read
            const cacheCreationTokens = cacheTokens?.cacheCreationTokens || 0;
            const cacheReadTokens = cacheTokens?.cacheReadTokens || 0;
            const reportedInput = cacheTokens
                ? Math.max(0, inputTokens - cacheCreationTokens - cacheReadTokens)
                : inputTokens;
            const usage = {
                input_tokens: reportedInput,
                output_tokens: outputTokens
            };
            if (cacheTokens) {
                usage.cache_creation_input_tokens = cacheCreationTokens;
                usage.cache_read_input_tokens = cacheReadTokens;
            }

            return {
                id: messageId,
                type: "message",
                role: role,
                model: model,
                stop_reason: stopReason,
                stop_sequence: null,
                usage,
                content: contentArray
            };
        }
    }

    /**
     * List available models
     */
    async listModels() {
        const models = KIRO_MODELS.map(id => ({
            name: id
        }));
        
        return { models: models };
    }

    /**
     * Checks if the token is completely expired (cannot be used at all).
     * @returns {boolean} - True if token is expired, false otherwise.
     */
    isTokenExpired() {
        try {
            if (!this.expiresAt) return true;
            const expirationTime = new Date(this.expiresAt);
            const currentTime = new Date();
            // 给 30 秒缓冲，避免请求过程中过期
            const bufferMs = 30 * 1000;
            return expirationTime.getTime() <= (currentTime.getTime() + bufferMs);
        } catch (error) {
            logger.error(`[Kiro] Error checking token expiry: ${error.message}`);
            return true; // Treat as expired if parsing fails
        }
    }

    /**
     * Checks if the given expiresAt timestamp is within 10 minutes from now (needs refresh soon).
     * @returns {boolean} - True if expiresAt is less than 10 minutes from now, false otherwise.
     */
    isExpiryDateNear() {
        try {
            const expirationTime = new Date(this.expiresAt);
            const nearMinutes = 30;
            const { message, isNearExpiry } = formatExpiryLog('Kiro', expirationTime.getTime(), nearMinutes);
            logger.info(message);
            return isNearExpiry;
        } catch (error) {
            logger.error(`[Kiro] Error checking expiry date: ${this.expiresAt}, Error: ${error.message}`);
            return false; // Treat as expired if parsing fails
        }
    }

    /**
     * 后台异步刷新 token（不阻塞当前请求）
     */
    triggerBackgroundRefresh() {
        logger.info('[Kiro] Background token refresh started...');
        this.initializeAuth(true).then(() => {
            logger.info('[Kiro] Background token refresh completed successfully');
        }).catch((error) => {
            logger.error('[Kiro] Background token refresh failed:', error.message);
            // 后台刷新失败不抛出错误，下次请求会重试
        });
    }

    /**
     * Count tokens for a message request (compatible with Anthropic API)
     * POST /v1/messages/count_tokens
     * @param {Object} requestBody - The request body containing model, messages, system, tools, etc.
     * @returns {Object} { input_tokens: number }
     */
    countTokens(requestBody) {
        return KiroApiService.countTokens(requestBody);
    }

    /**
     * 获取用量限制信息
     * @returns {Promise<Object>} 用量限制信息
     */
    async getUsageLimits() {
        if (!this.isInitialized) await this.initialize();

        // Token 刷新策略：
        // 1. 已过期 → 必须等待刷新
        // 2. 即将过期但还能用 → 后台异步刷新，不阻塞当前请求
        // if (this.isTokenExpired()) {
        //     logger.info('[Kiro] Token is expired, must refresh before getUsageLimits request...');
        //     await this.initializeAuth(true);
        // } else if (this.isExpiryDateNear()) {
        //     logger.info('[Kiro] Token is near expiry, triggering background refresh...');
        //     this.triggerBackgroundRefresh();
        // }
        
        // 内部固定的资源类型
        const resourceType = 'AGENTIC_REQUEST';
        
        // 构建请求 URL
        let usageLimitsUrl = this.baseUrl;
        usageLimitsUrl = usageLimitsUrl.replace('generateAssistantResponse', 'getUsageLimits');
        const params = new URLSearchParams({
            isEmailRequired: 'true',
            origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR,
            resourceType: resourceType
        });
         if (this.authMethod === KIRO_CONSTANTS.AUTH_METHOD_SOCIAL && this.profileArn) {
            params.append('profileArn', this.profileArn);
        }
        const fullUrl = `${usageLimitsUrl}?${params.toString()}`;

        // 动态生成 headers (与 initialize() 同一套, 但覆盖 invocation-id 和 attempt 计数)
        const machineId = generateMachineIdFromConfig({
            uuid: this.uuid,
            profileArn: this.profileArn,
            clientId: this.clientId
        });
        const isIdc = isKiroIdcAuth(this.authMethod);
        const headers = {
            'Authorization': `Bearer ${this.accessToken}`,
            'x-amz-user-agent': isIdc ? KIRO_CLI_AMZ_USER_AGENT : getKiroAmzUserAgent(machineId),
            'user-agent': isIdc ? KIRO_CLI_USER_AGENT : getKiroUserAgent(machineId),
            'amz-sdk-invocation-id': uuidv4(),
            'amz-sdk-request': 'attempt=1; max=1',
            'Connection': 'close'
        };

        const axiosConfig = {
            method: 'get',
            url: fullUrl,
            headers
        };
        this._applySidecar(axiosConfig);

        try {
            const response = await this.axiosInstance.request(axiosConfig);
            logger.info('[Kiro] Usage limits fetched successfully');
            return response.data;
        } catch (error) {
            const status = error.response?.status;
            
            // 从响应体中提取错误信息
            let errorMessage = error.message;
            if (error.response?.data) {
                // 尝试从响应体中获取错误描述
                const responseData = error.response.data;
                if (typeof responseData === 'string') {
                    errorMessage = responseData;
                } else if (responseData.message) {
                    errorMessage = responseData.message;
                } else if (responseData.error) {
                    errorMessage = typeof responseData.error === 'string' ? responseData.error : responseData.error.message || JSON.stringify(responseData.error);
                }
            }
            
            // 构建包含状态码和错误描述的错误信息
            const formattedError = status
                ? new Error(`API call failed: ${status} - ${errorMessage}`)
                : new Error(`API call failed: ${errorMessage}`);
            
            // 对于用量查询，401/403 错误直接标记凭证为不健康，不重试
            if (status === 401) {
                logger.info('[Kiro] Received 401 on getUsageLimits. Marking credential as unhealthy (no retry)...');
                this._markCredentialNeedRefresh('401 Unauthorized on usage query', formattedError);
                throw formattedError;
            }
            
            if (status === 403) {
                this._handleForbiddenCredentialError(error, 'usage query');
                formattedError.credentialMarkedUnhealthy = true;
                throw formattedError;
            }
            
            logger.error('[Kiro] Failed to fetch usage limits:', formattedError.message, error);
            throw formattedError;
        }
    }
}
