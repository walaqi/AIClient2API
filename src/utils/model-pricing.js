import axios from 'axios';
import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import path from 'path';
import { atomicWriteFile } from './file-lock.js';
import logger from './logger.js';
import { parseProxyUrl } from './proxy-utils.js';
import { CONFIG } from '../core/config-manager.js';

const PRICE_SOURCE_RAW = 'https://raw.githubusercontent.com/Wei-Shaw/model-price-repo/main/model_prices_and_context_window.json';
const CACHE_FILE = path.join(process.cwd(), 'configs', 'model-prices.json');
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

function buildPriceCandidates() {
    return [
        { name: 'gh-proxy.org', url: `https://gh-proxy.org/${PRICE_SOURCE_RAW}` },
        { name: 'hk.gh-proxy.org', url: `https://hk.gh-proxy.org/${PRICE_SOURCE_RAW}` },
        { name: 'cdn.gh-proxy.org', url: `https://cdn.gh-proxy.org/${PRICE_SOURCE_RAW}` },
        { name: 'edgeone.gh-proxy.org', url: `https://edgeone.gh-proxy.org/${PRICE_SOURCE_RAW}` },
        { name: 'direct', url: PRICE_SOURCE_RAW }
    ];
}
/**
 * 假设值. $0.2==1credit. 
 * 低于这个值,会导致kiro计费太低, 
 * 反算的cache_creation_input_tokens全部等于0, 
 * cache_read_input_tokens全部等于input_tokens
 */
const CREDIT_TO_USD = 0.2; 

let priceData = null;
let sortedKeys = null;
let lastFetchTime = 0;

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

export async function loadModelPrices() {
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
}

export async function refreshIfNeeded() {
    if (Date.now() - lastFetchTime > REFRESH_INTERVAL_MS) {
        await fetchAndCacheModelPrices();
    }
}

export function getModelPricing(modelId) {
    if (!priceData) return null;

    // Exact match
    if (priceData[modelId]) return priceData[modelId];

    // Forward match: modelId starts with a key from priceData
    // Sort keys by length descending to prefer longer (more specific) matches
    if (sortedKeys) {
        const match = sortedKeys.find(key => modelId.startsWith(key));
        if (match) return priceData[match];
    }

    return null;
}

export function isModelPricingAvailable() {
    return priceData !== null;
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
