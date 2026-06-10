import axios from 'axios';
import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import path from 'path';
import { atomicWriteFile } from './file-lock.js';
import logger from './logger.js';
import { parseProxyUrl } from './proxy-utils.js';
import { CONFIG } from '../core/config-manager.js';

// ─── Remote sources ─────────────────────────────────────────────────────────
// 直连，不使用任何代理镜像。
const PRICE_SOURCE_URL = 'https://raw.githubusercontent.com/walaqi/model-price-repo/refs/heads/main/model_prices_and_context_window.json';
// 价格表映射: 本系统原生 model id(request._clientModelId) -> 价格文件中的标准 model id。
// 背景: 本系统作为上游系统 s 的后端, s 只认标准 claude 模型, 映射在 s 侧完成,
// 发到本系统的已是非标准的原生 id, 这些 id 在价格文件里查不到, 需再映射一次才能查价。
// 映射不放在本系统做标准模型映射, 是为了避免污染可用模型列表破坏 s 的请求链路。
const MAPPING_SOURCE_URL = 'https://raw.githubusercontent.com/walaqi/model-price-repo/refs/heads/main/claude-kiro-oauth-model-mapping.json';

// ─── Local cache files ──────────────────────────────────────────────────────
const PRICE_CACHE_FILE = path.join(process.cwd(), 'configs', 'model-prices.json');
const MAPPING_CACHE_FILE = path.join(process.cwd(), 'configs', 'claude-kiro-oauth-model-mapping.json');

// ─── Fetch policy ───────────────────────────────────────────────────────────
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15000;
// ─── Billing constants (Kiro credit reverse-calculation) ────────────────────
// meteringCredits 是 Kiro 抽象计费积分，需按请求类型换算成 USD：
//   CREDIT_TO_USD     —— 大请求路径(2-class)，含大量历史缓存
//   CREDIT_TO_USD_LOW —— 小请求路径(3-class)，本轮几乎只有普通未缓存输入
// 当前两值均为基线 0.15/0.02 的 50% 折扣值，整体计费下降一半。经验值，Kiro 调价后需重新标定。
const CREDIT_TO_USD = 0.075;
const CREDIT_TO_USD_LOW = 0.01;

// 路径判定阈值与近似参数：
//   CACHE_HISTORY_THRESHOLD_TOKENS —— ctxInput 与 localInput 差值超过此阈值即判为有显著历史缓存，强制 2-class
//   MIN_LOCAL_TOKENS_FOR_CACHE_CALC —— localInput 低于此阈值时 credits 接近 0 反算误差极大，跳过精算
//   DEFAULT_MAX_TOKENS_FOR_CRLIMIT —— 请求未传 max_tokens 时的保守默认，避免 crLimit=0 误把所有请求归小路径
//   SMALL_REQUEST_FALLBACK_RATIO —— MIN 阈值以下的兜底比例：cacheCreate ≈ localTokens × input/cacheCreate 价比 (≈3/3.75)
const CACHE_HISTORY_THRESHOLD_TOKENS = 2000;
const MIN_LOCAL_TOKENS_FOR_CACHE_CALC = 200;
const DEFAULT_MAX_TOKENS_FOR_CRLIMIT = 256;
const SMALL_REQUEST_FALLBACK_RATIO = 3 / 3.75;


// ─── Module state ───────────────────────────────────────────────────────────
let priceData = null;
let sortedKeys = null;
let lastFetchTime = 0;

// 价格映射: { 原生 id -> 价格文件标准 id }。源文件是 { mapping: [ {原生id: 标准id}, ... ] }。
// 同一原生 id 出现多次时后写覆盖(last-wins): 配置里把语义正确的标准 id 放在该 key 的最后一条。
let priceModelMapping = {};

// ─── Helpers ────────────────────────────────────────────────────────────────
// 共享 axios 配置，按需附加 PROXY_URL 解析出的 agent。
function buildAxiosConfig() {
    const cfg = { timeout: FETCH_TIMEOUT_MS };
    if (CONFIG && CONFIG.PROXY_URL) {
        const proxy = parseProxyUrl(CONFIG.PROXY_URL);
        if (proxy) {
            cfg.httpAgent = proxy.httpAgent;
            cfg.httpsAgent = proxy.httpsAgent;
            cfg.proxy = false;
        }
    }
    return cfg;
}

// 将映射源文件的 { mapping: [...] } 数组结构归一化为 { 原生id: 标准id } 查找表。
function normalizeMapping(raw) {
    const result = {};
    const list = raw && Array.isArray(raw.mapping) ? raw.mapping : [];
    for (const entry of list) {
        if (!entry || typeof entry !== 'object') continue;
        for (const [nativeId, mappedId] of Object.entries(entry)) {
            if (typeof nativeId === 'string' && typeof mappedId === 'string') {
                result[nativeId] = mappedId; // 后写覆盖
            }
        }
    }
    return result;
}

// ─── Remote fetchers ────────────────────────────────────────────────────────
export async function fetchAndCacheModelPrices() {
    try {
        logger.info(`[Model Pricing] Fetching prices from direct...`);
        const response = await axios.get(PRICE_SOURCE_URL, buildAxiosConfig());
        if (!response.data || typeof response.data !== 'object') return false;

        priceData = response.data;
        sortedKeys = Object.keys(priceData).sort((a, b) => b.length - a.length);
        lastFetchTime = Date.now();
        await atomicWriteFile(PRICE_CACHE_FILE, JSON.stringify(priceData, null, 2), 'utf-8');
        logger.info(`[Model Pricing] Loaded ${Object.keys(priceData).length} models from direct, cached to ${PRICE_CACHE_FILE}`);
        return true;
    } catch (error) {
        logger.warn(`[Model Pricing] Failed to fetch prices: ${error.message}`);
        return false;
    }
}

export async function fetchAndCacheModelMapping() {
    try {
        logger.info(`[Model Pricing] Fetching mapping from direct...`);
        const response = await axios.get(MAPPING_SOURCE_URL, buildAxiosConfig());
        if (!response.data || typeof response.data !== 'object') return false;

        const normalized = normalizeMapping(response.data);
        if (Object.keys(normalized).length === 0) {
            logger.warn(`[Model Pricing] Mapping has no valid entries, skipping`);
            return false;
        }
        priceModelMapping = normalized;
        await atomicWriteFile(MAPPING_CACHE_FILE, JSON.stringify(response.data, null, 2), 'utf-8');
        logger.info(`[Model Pricing] Loaded ${Object.keys(priceModelMapping).length} model mappings, cached to ${MAPPING_CACHE_FILE}`);
        return true;
    } catch (error) {
        logger.warn(`[Model Pricing] Failed to fetch mapping: ${error.message}`);
        return false;
    }
}

// ─── Bootstrapping ──────────────────────────────────────────────────────────
export async function loadModelPrices() {
    // 先尝试本地映射缓存(随程序分发的种子文件), 失败再走远程
    if (existsSync(MAPPING_CACHE_FILE)) {
        try {
            const mapContent = await fs.readFile(MAPPING_CACHE_FILE, 'utf8');
            const normalized = normalizeMapping(JSON.parse(mapContent));
            if (Object.keys(normalized).length > 0) {
                priceModelMapping = normalized;
                logger.info(`[Model Pricing] Loaded ${Object.keys(priceModelMapping).length} model mappings from local cache`);
            }
        } catch (error) {
            logger.warn('[Model Pricing] Failed to read local mapping cache:', error.message);
        }
    }

    if (existsSync(PRICE_CACHE_FILE)) {
        try {
            const content = await fs.readFile(PRICE_CACHE_FILE, 'utf8');
            priceData = JSON.parse(content);
            sortedKeys = Object.keys(priceData).sort((a, b) => b.length - a.length);
            // 不设 lastFetchTime，让 refreshIfNeeded() 在下次 health check 时触发远程拉取
            logger.info(`[Model Pricing] Loaded ${Object.keys(priceData).length} models from local cache`);
        } catch (error) {
            logger.warn('[Model Pricing] Failed to read local cache:', error.message);
        }
    }

    // 远程拉取异步执行，不阻塞启动
    fetchAndCacheModelPrices().catch(() => {
        if (!priceData) {
            logger.warn('[Model Pricing] No pricing data available (remote fetch failed and no local cache)');
        }
    });
    fetchAndCacheModelMapping().catch(() => {});
}

export async function refreshIfNeeded() {
    if (Date.now() - lastFetchTime > REFRESH_INTERVAL_MS) {
        await fetchAndCacheModelPrices();
        await fetchAndCacheModelMapping();
    }
}

// ─── Pricing lookup API ─────────────────────────────────────────────────────
export function getModelPricing(modelId) {
    if (!priceData) return null;

    // 先按映射表把本系统原生 id 转成价格文件的标准 id; 无映射则维持原 id。
    const lookupId = priceModelMapping[modelId] || modelId;

    // Exact match
    if (priceData[lookupId]) return priceData[lookupId];

    // Forward match: lookupId starts with a key from priceData
    // Sort keys by length descending to prefer longer (more specific) matches
    if (sortedKeys) {
        const match = sortedKeys.find(key => lookupId.startsWith(key));
        if (match) return priceData[match];
    }

    return null;
}

export function isModelPricingAvailable() {
    return priceData !== null;
}

// 价格表里的 max_input_tokens 即模型的上下文窗口大小, 直接复用, 避免在各 provider 里硬编码维护。
// getModelPricing 已处理原生 id -> 标准 id 映射与前缀匹配; 查不到或字段非法时返回 null 交由调用方回退。
export function getModelContextWindow(modelId) {
    if (typeof modelId !== 'string' || !modelId) return null;

    const pricing = getModelPricing(modelId);
    const maxInputTokens = Number(pricing?.max_input_tokens);
    return Number.isFinite(maxInputTokens) && maxInputTokens > 0 ? maxInputTokens : null;
}

export function getCreditToUsd() {
    return CREDIT_TO_USD;
}

// ─── Cache token reverse-calculation ────────────────────────────────────────
// 把 meteringCredits + ctxInputTokens 反算成 (cache_creation, cache_read)，组装 Anthropic usage。
//
// Anthropic 真实定价分三类：inputCost = regular×inputP + creation×createP + read×readP
// 已知量只有 credits 和 inputTokens，欠定，需用请求规模区分两条路径：
//
//  • 小请求 (3-class)：本轮以普通未缓存输入为主。假设 regular ≈ localInputTokens，剩余按 2-class 拆 create/read。
//                     换算率 CREDIT_TO_USD_LOW；适合 17-token curl 这类场景，避免误把 inputCost 全归 cacheCreate。
//  • 大请求 (2-class)：上下文有大量历史缓存。假设 regular≈0，输入非 cache_read 即 cache_creation。
//                     换算率 CREDIT_TO_USD；适合 Claude Code 多轮会话。
//
// 路径判定双门控（任一失败走 2-class）：
//   credits < crLimit          (crLimit = effectiveMaxTokens × outputPrice / CREDIT_TO_USD_LOW)
//   cacheHistoryTokens ≤ CACHE_HISTORY_THRESHOLD_TOKENS  (= ctxInput − localInput，捕获贵模型的多轮误判)
//
// 局限：换算率与阈值都是经验值；路径判定依赖 localInputTokens 的 tokenizer 准确性。
// 详细推导见 memory/kiro-token-accounting.md。

// 小 context 兜底：localInput < MIN_LOCAL_TOKENS_FOR_CACHE_CALC 时 credits ≈ 0 反算误差极大，
// 直接按 input/cacheCreate 价比折算，cache_read=0。删此分支即回退到精算路径。
function fallbackForSmallContext(meteringCredits, inputTokens, outputTokens, modelId, localInputTokens) {
    logger.info(
        `[Model Pricing] Skip cache calc (localInputTokens < ${MIN_LOCAL_TOKENS_FOR_CACHE_CALC}): model=${modelId}` +
        `, credits=${meteringCredits}, inputTokens=${inputTokens}, localInput=${localInputTokens}` +
        `, outputTokens=${outputTokens}`
    );
    return {
        cacheCreationTokens: Math.round(localInputTokens * SMALL_REQUEST_FALLBACK_RATIO),
        cacheReadTokens: 0,
    };
}
// 小请求路径：regular = localInputTokens；剩余部分用 2-class 拆 cacheCreate/cacheRead。
function computeSmallRequestCache({ meteringCredits, inputTokens, outputTokens, modelId, localInputTokens, crLimit, pricing }) {
    const { cache_read_input_token_cost: cacheReadPrice,
            cache_creation_input_token_cost: cacheCreatePrice,
            output_cost_per_token: outputPrice } = pricing;
    const inputPrice = pricing.input_cost_per_token || cacheReadPrice;

    const totalCost  = meteringCredits * CREDIT_TO_USD_LOW;
    const outputCost = outputTokens * outputPrice;
    const inputCost  = Math.max(0, totalCost - outputCost);

    const regularTokens   = Math.min(localInputTokens, inputTokens);
    const regularCost     = regularTokens * inputPrice;
    const remainingCost   = Math.max(0, inputCost - regularCost);
    const remainingTokens = Math.max(0, inputTokens - regularTokens);

    let cacheCreationTokens = 0;
    let cacheReadTokens = 0;
    if (remainingTokens > 0 && cacheCreatePrice !== cacheReadPrice) {
        let creation = (remainingCost - remainingTokens * cacheReadPrice) / (cacheCreatePrice - cacheReadPrice);
        creation = Math.max(0, Math.min(creation, remainingTokens));
        cacheCreationTokens = Math.round(creation);
        cacheReadTokens = Math.max(0, remainingTokens - cacheCreationTokens);
    }

    logger.info(
        `[Model Pricing] Calc(3-class): model=${modelId}` +
        `, credits=${meteringCredits}, crLimit=${crLimit.toFixed(6)}` +
        `, CREDIT_TO_USD=${CREDIT_TO_USD}, CREDIT_TO_USD_LOW=${CREDIT_TO_USD_LOW}` +
        `, totalCost=$${totalCost.toFixed(6)}, outputCost=$${outputCost.toFixed(6)}, inputCost=$${inputCost.toFixed(6)}` +
        `, inputTokens=${inputTokens}, localInput=${localInputTokens}, regular=${regularTokens}` +
        `, cacheCreate=${cacheCreationTokens}, cacheRead=${cacheReadTokens}`
    );
    return { cacheCreationTokens, cacheReadTokens };
}
// 大请求路径：假设 regular≈0，所有输入按 cacheCreate/cacheRead 拆分。
function computeLargeRequestCache({ meteringCredits, inputTokens, outputTokens, modelId, localInputTokens, cacheHistoryTokens, crLimit, pricing }) {
    const { cache_read_input_token_cost: cacheReadPrice,
            cache_creation_input_token_cost: cacheCreatePrice,
            output_cost_per_token: outputPrice } = pricing;

    const totalCost  = meteringCredits * CREDIT_TO_USD;
    const outputCost = outputTokens * outputPrice;
    const inputCost  = Math.max(0, totalCost - outputCost);

    logger.info(
        `[Model Pricing] Calc(2-class): model=${modelId}` +
        `, credits=${meteringCredits}, crLimit=${crLimit.toFixed(6)}` +
        `, CREDIT_TO_USD=${CREDIT_TO_USD}, CREDIT_TO_USD_LOW=${CREDIT_TO_USD_LOW}` +
        `, totalCost=$${totalCost.toFixed(6)}, outputCost=$${outputCost.toFixed(6)}, inputCost=$${inputCost.toFixed(6)}` +
        `, inputTokens=${inputTokens}, localInput=${localInputTokens}, cacheHistory=${cacheHistoryTokens}` +
        `, cacheReadPrice=${cacheReadPrice}, cacheCreatePrice=${cacheCreatePrice}`
    );

    if (cacheCreatePrice === cacheReadPrice) {
        return { cacheCreationTokens: 0, cacheReadTokens: inputTokens };
    }
    let creation = (inputCost - inputTokens * cacheReadPrice) / (cacheCreatePrice - cacheReadPrice);
    creation = Math.max(0, Math.min(creation, inputTokens));
    const cacheCreationTokens = Math.round(creation);
    return { cacheCreationTokens, cacheReadTokens: Math.max(0, inputTokens - cacheCreationTokens) };
}

/**
 * 反算 cache_creation / cache_read token 数（详见上方推导）。
 * @param {number} meteringCredits      上游计费积分
 * @param {number} inputTokens          ctxInputTokens（含历史缓存的总输入）
 * @param {number} outputTokens         本次响应输出 token 数
 * @param {string} modelId              价格表 model id
 * @param {number} [localInputTokens=0] 本地 tokenizer 估算（不含历史缓存）
 * @param {number} [maxTokens=0]        请求 max_tokens；0 表示未传，使用 DEFAULT_MAX_TOKENS_FOR_CRLIMIT 兜底
 * @returns {{ cacheCreationTokens: number, cacheReadTokens: number }}
 */
export function calculateCacheTokens(meteringCredits, inputTokens, outputTokens, modelId, localInputTokens = 0, maxTokens = 0) {
    if (!meteringCredits || inputTokens <= 0) {
        return { cacheCreationTokens: 0, cacheReadTokens: 0 };
    }
    if (localInputTokens < MIN_LOCAL_TOKENS_FOR_CACHE_CALC) {
        return fallbackForSmallContext(meteringCredits, inputTokens, outputTokens, modelId, localInputTokens);
    }

    const pricing = getModelPricing(modelId);
    if (!pricing
        || !pricing.cache_read_input_token_cost
        || !pricing.cache_creation_input_token_cost
        || !pricing.output_cost_per_token) {
        return { cacheCreationTokens: 0, cacheReadTokens: 0 };
    }

    // crLimit：credits 不足以覆盖 "max_tokens 全部输出" 的成本则视为小请求。
    const effectiveMaxTokens = maxTokens > 0 ? maxTokens : DEFAULT_MAX_TOKENS_FOR_CRLIMIT;
    const crLimit = (effectiveMaxTokens * pricing.output_cost_per_token) / CREDIT_TO_USD_LOW;

    // 历史缓存检测：ctxInput 与 localInput 差值显著时强制走 2-class，避免贵模型误判。
    const cacheHistoryTokens = Math.max(0, inputTokens - localInputTokens);
    const hasSignificantCacheHistory = cacheHistoryTokens > CACHE_HISTORY_THRESHOLD_TOKENS;
    const isSmallRequest = meteringCredits < crLimit && !hasSignificantCacheHistory && localInputTokens > 0;

    const args = { meteringCredits, inputTokens, outputTokens, modelId, localInputTokens, cacheHistoryTokens, crLimit, pricing };
    return isSmallRequest ? computeSmallRequestCache(args) : computeLargeRequestCache(args);
}
