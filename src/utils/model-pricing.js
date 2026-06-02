import axios from 'axios';
import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import path from 'path';
import { atomicWriteFile } from './file-lock.js';
import logger from './logger.js';
import { parseProxyUrl } from './proxy-utils.js';
import { CONFIG } from '../core/config-manager.js';

const PRICE_SOURCE_RAW = 'https://raw.githubusercontent.com/walaqi/model-price-repo/refs/heads/main/model_prices_and_context_window.json';
// 价格表映射: 本系统原生 model id(request._clientModelId) -> 价格文件中的标准 model id。
// 背景: 本系统作为上游系统 s 的后端, s 只认标准 claude 模型, 映射在 s 侧完成,
// 发到本系统的已是非标准的原生 id, 这些 id 在价格文件里查不到, 需再映射一次才能查价。
// 映射不放在本系统做标准模型映射, 是为了避免污染可用模型列表破坏 s 的请求链路。
const PRICE_MAPPING_RAW_CLAUDE_KIRO_OAUTH = 'https://raw.githubusercontent.com/walaqi/model-price-repo/refs/heads/main/claude-kiro-oauth-model-mapping.json';
const CACHE_FILE = path.join(process.cwd(), 'configs', 'model-prices.json');
const MAPPING_CACHE_FILE = path.join(process.cwd(), 'configs', 'claude-kiro-oauth-model-mapping.json');
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

// 通过 gh-proxy 镜像 + 直连构造候选源, 与价格表同款回退策略。
function buildCandidates(rawUrl) {
    return [
        { name: 'gh-proxy.org', url: `https://gh-proxy.org/${rawUrl}` },
        { name: 'hk.gh-proxy.org', url: `https://hk.gh-proxy.org/${rawUrl}` },
        { name: 'cdn.gh-proxy.org', url: `https://cdn.gh-proxy.org/${rawUrl}` },
        { name: 'edgeone.gh-proxy.org', url: `https://edgeone.gh-proxy.org/${rawUrl}` },
        { name: 'direct', url: rawUrl }
    ];
}

function buildPriceCandidates() {
    return buildCandidates(PRICE_SOURCE_RAW);
}
/**
 * 假设值. $0.1==1credit. 
 * 低于这个值,会导致kiro计费太低, 
 * 反算的cache_creation_input_tokens全部等于0, 
 * cache_read_input_tokens全部等于input_tokens
 */
const CREDIT_TO_USD = 0.08; 

let priceData = null;
let sortedKeys = null;
let lastFetchTime = 0;

// 价格映射: { 原生 id -> 价格文件标准 id }。源文件是 { mapping: [ {原生id: 标准id}, ... ] }。
// 同一原生 id 出现多次时后写覆盖(last-wins): 配置里把语义正确的标准 id 放在该 key 的最后一条。
let priceModelMapping = {};

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

export async function fetchAndCacheModelPrices() {
    const candidates = buildPriceCandidates();
    let proxyConfig = null;

    if (CONFIG && CONFIG.PROXY_URL) {
        proxyConfig = parseProxyUrl(CONFIG.PROXY_URL);
    }

    for (const candidate of candidates) {
        try {
            logger.info(`[Model Pricing] Fetching from ${candidate.name}...`);
            const axiosConfig = { timeout: 15000 };
            if (proxyConfig) {
                axiosConfig.httpAgent = proxyConfig.httpAgent;
                axiosConfig.httpsAgent = proxyConfig.httpsAgent;
                axiosConfig.proxy = false;
            }
            const response = await axios.get(candidate.url, axiosConfig);
            if (response.data && typeof response.data === 'object') {
                priceData = response.data;
                sortedKeys = Object.keys(priceData).sort((a, b) => b.length - a.length);
                lastFetchTime = Date.now();
                await atomicWriteFile(CACHE_FILE, JSON.stringify(priceData, null, 2), 'utf-8');
                const modelCount = Object.keys(priceData).length;
                logger.info(`[Model Pricing] Loaded ${modelCount} models from ${candidate.name}, cached to ${CACHE_FILE}`);
                return true;
            }
        } catch (error) {
            logger.warn(`[Model Pricing] Failed to fetch from ${candidate.name}: ${error.message}`);
        }
    }
    return false;
}

export async function fetchAndCacheModelMapping() {
    const candidates = buildCandidates(PRICE_MAPPING_RAW_CLAUDE_KIRO_OAUTH);
    let proxyConfig = null;

    if (CONFIG && CONFIG.PROXY_URL) {
        proxyConfig = parseProxyUrl(CONFIG.PROXY_URL);
    }

    for (const candidate of candidates) {
        try {
            logger.info(`[Model Pricing] Fetching mapping from ${candidate.name}...`);
            const axiosConfig = { timeout: 15000 };
            if (proxyConfig) {
                axiosConfig.httpAgent = proxyConfig.httpAgent;
                axiosConfig.httpsAgent = proxyConfig.httpsAgent;
                axiosConfig.proxy = false;
            }
            const response = await axios.get(candidate.url, axiosConfig);
            if (response.data && typeof response.data === 'object') {
                const normalized = normalizeMapping(response.data);
                if (Object.keys(normalized).length > 0) {
                    priceModelMapping = normalized;
                    await atomicWriteFile(MAPPING_CACHE_FILE, JSON.stringify(response.data, null, 2), 'utf-8');
                    logger.info(`[Model Pricing] Loaded ${Object.keys(priceModelMapping).length} model mappings from ${candidate.name}, cached to ${MAPPING_CACHE_FILE}`);
                    return true;
                }
                logger.warn(`[Model Pricing] Mapping from ${candidate.name} has no valid entries, skipping`);
            }
        } catch (error) {
            logger.warn(`[Model Pricing] Failed to fetch mapping from ${candidate.name}: ${error.message}`);
        }
    }
    return false;
}

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

    // Try local cache first
    if (existsSync(CACHE_FILE)) {
        try {
            const content = await fs.readFile(CACHE_FILE, 'utf8');
            priceData = JSON.parse(content);
            sortedKeys = Object.keys(priceData).sort((a, b) => b.length - a.length);
            // 不设 lastFetchTime，让 refreshIfNeeded() 在下次 health check 时触发远程拉取
            logger.info(`[Model Pricing] Loaded ${Object.keys(priceData).length} models from local cache`);
        } catch (error) {
            logger.warn('[Model Pricing] Failed to read local cache:', error.message);
        }
    }

    // 异步拉取远程数据，不阻塞启动
    fetchAndCacheModelPrices().catch(() => {
        if (!priceData) {
            logger.warn('[Model Pricing] No pricing data available (remote fetch failed and no local cache)');
        }
    });
    // 映射文件远程刷新同样不阻塞启动
    fetchAndCacheModelMapping().catch(() => {});
}

export async function refreshIfNeeded() {
    if (Date.now() - lastFetchTime > REFRESH_INTERVAL_MS) {
        await fetchAndCacheModelPrices();
        await fetchAndCacheModelMapping();
    }
}

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

export function calculateCacheTokens(meteringCredits, inputTokens, outputTokens, modelId) {
    if (!meteringCredits || inputTokens <= 0) {
        return { cacheCreationTokens: 0, cacheReadTokens: 0 };
    }

    const pricing = getModelPricing(modelId);
    if (!pricing || !pricing.cache_read_input_token_cost || !pricing.cache_creation_input_token_cost || !pricing.output_cost_per_token) {
        return { cacheCreationTokens: 0, cacheReadTokens: 0 };
    }

    const totalCost = meteringCredits * CREDIT_TO_USD;
    const outputCost = outputTokens * pricing.output_cost_per_token;
    const inputCost = Math.max(0, totalCost - outputCost);

    const cacheReadPrice = pricing.cache_read_input_token_cost;
    const cacheCreatePrice = pricing.cache_creation_input_token_cost;

    logger.info(`[Model Pricing] Calc: model=${modelId}, credits=${meteringCredits}, totalCost=$${totalCost.toFixed(6)}, outputCost=$${outputCost.toFixed(6)}, inputCost=$${inputCost.toFixed(6)}, inputTokens=${inputTokens}, cacheReadPrice=${cacheReadPrice}, cacheCreatePrice=${cacheCreatePrice}`);

    if (cacheCreatePrice === cacheReadPrice) {
        return { cacheCreationTokens: 0, cacheReadTokens: inputTokens };
    }

    /*
    ### 1. 反算公式对"首次(无缓存)请求"会严重误报 (model-pricing.js:104)

    ```js
    let creation = (inputCost - inputTokens * cacheReadPrice) / (cacheCreatePrice - cacheReadPrice);
    ```

    这个公式假设 **所有输入 token 非 cache_read 即 cache_creation**,没有考虑"普通未缓存输入"这一类。真实定价模型是三类:
    ```
    input_cost = regular * input_price + cache_create * create_price + cache_read * read_price
    ```

    代入 Anthropic 典型价格 (`input = 3e-6`, `create = 3.75e-6`, `read = 3e-7`):
    - 纯普通输入 `N` 个 token,真实成本 = `N * 3e-6`0}` 而非强行拆分。
    - 或者在代码和返回值里明确标注这是"估算值",供客户端知情使用。
    - 文档里记一笔这一简化假设的已知偏差。
    */
    let creation = (inputCost - inputTokens * cacheReadPrice) / (cacheCreatePrice - cacheReadPrice);
    creation = Math.max(0, Math.min(creation, inputTokens));

    const cacheCreationTokens = Math.round(creation);
    const cacheReadTokens = Math.max(0, inputTokens - cacheCreationTokens);

    return { cacheCreationTokens, cacheReadTokens };
}
