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
// ─────────────────────────────────────────────────────────────────────────────
// Credit → USD 换算率说明
//
// Kiro 上游返回的 meteringCredits 是一个抽象计费积分，不是标准货币单位。
// 从实测数据反推，其真实美元价值与请求类型强相关：
//
//   CREDIT_TO_USD（0.15）：用于"大请求"路径，即上下文窗口中存在大量历史缓存的情况。
//     此时 cache_read token 数量多，按 0.15 折算与实际费用吻合。
//     若用 0.02 折算大请求，会严重低估总成本，导致 cache_creation 反算溢出。
//
//   CREDIT_TO_USD_LOW（0.02）：用于"小请求"路径，即本轮几乎只有普通未缓存输入。
//     实测：17 个普通 token 的 curl 请求，用 0.15 折算后反算出 399 cache_creation，
//     明显错误；换成 0.02 后，regular 覆盖大部分 inputCost，cache 分量接近 0，符合实际。
//
// 两个常量均为经验值，未来如 Kiro 调整计费标准需重新标定。
// ─────────────────────────────────────────────────────────────────────────────
const CREDIT_TO_USD = 0.15;
const CREDIT_TO_USD_LOW = 0.02;

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

/**
 * 反算缓存 token 分布（cache_creation / cache_read）。
 *
 * ── 背景 ──────────────────────────────────────────────────────────────────
 * Kiro 上游不返回分类 token 数，只返回 meteringCredits（计费积分）和
 * contextUsagePercentage（上下文窗口占用率）。
 *
 * 调用方用 contextUsagePercentage * contextWindow 推算出 inputTokens（总输入量，
 * 含历史缓存），再交给本函数拆分出 cache_creation / cache_read 两部分，
 * 最终组装成 Anthropic 标准 usage 结构返回给客户端。
 *
 * ── 定价模型 ──────────────────────────────────────────────────────────────
 * Anthropic 真实定价是三类输入：
 *   inputCost = regular × inputPrice
 *             + creation × createPrice
 *             + read    × readPrice
 *
 * 但已知量只有 meteringCredits 和 inputTokens，三个未知数，方程欠定。
 * 因此需要额外假设来收敛，本函数用请求规模来区分两条路径：
 *
 * ── 路径选择（_cr_limit） ─────────────────────────────────────────────────
 * _cr_limit = effectiveMaxTokens × outputPrice / CREDIT_TO_USD_LOW
 *
 *   含义：如果本次实际消耗的 credits 连"将 max_tokens 全部输出"都不够，
 *         则本轮几乎没有大量历史缓存，属于小请求。
 *   effectiveMaxTokens：优先用请求体的 max_tokens；未传则保守取 256。
 *
 * ── 小请求路径（meteringCredits < _cr_limit）────────────────────────────
 *   假设：regular ≈ localInputTokens（本地 tokenizer 直接估算，不含历史缓存）
 *   换算率：CREDIT_TO_USD_LOW = 0.02
 *
 *   公式：
 *     totalCost   = credits × 0.02
 *     inputCost   = totalCost − outputTokens × outputPrice
 *     regularCost = localInputTokens × inputPrice
 *     remainCost  = inputCost − regularCost         ← 剩余成本由 create/read 解释
 *     remainTok   = inputTokens − localInputTokens  ← 剩余 token 由 create/read 解释
 *     creation    = (remainCost − remainTok × readPrice) / (createPrice − readPrice)
 *     read        = remainTok − creation
 *
 *   典型结果：普通的 17-token curl 请求，regular=17，creation≈0，read≈0。
 *
 * ── 大请求路径（meteringCredits ≥ _cr_limit）────────────────────────────
 *   假设：regular ≈ 0，所有输入非 cache_read 即 cache_creation
 *   换算率：CREDIT_TO_USD = 0.15
 *
 *   公式（原 2-class 公式，不变）：
 *     creation = (inputCost − inputTokens × readPrice) / (createPrice − readPrice)
 *     read     = inputTokens − creation
 *
 * ── 已知局限 ──────────────────────────────────────────────────────────────
 * 两条路径都是近似，换算率均为经验值，如 Kiro 调整计费需重新标定。
 * 路径判断本身也依赖 localInputTokens 准确性（tokenizer 本地估算，非上游精确值）。
 *
 * @param {number} meteringCredits      上游返回的计费积分
 * @param {number} inputTokens          contextUsagePercentage 换算的总输入 token 数（含历史缓存）
 * @param {number} outputTokens         本次响应的输出 token 数
 * @param {string} modelId              价格表 model id（映射前的客户端 id）
 * @param {number} [localInputTokens=0] 本地 tokenizer 估算的本轮请求输入 token 数（不含历史缓存）
 * @param {number} [maxTokens=0]        请求体中的 max_tokens 参数；0 表示未传，使用保守默认值 256
 * @returns {{ cacheCreationTokens: number, cacheReadTokens: number }}
 */
export function calculateCacheTokens(meteringCredits, inputTokens, outputTokens, modelId, localInputTokens = 0, maxTokens = 0) {
    if (!meteringCredits || inputTokens <= 0) {
        return { cacheCreationTokens: 0, cacheReadTokens: 0 };
    }

    // 小 context 保护：localInputTokens < 200 时反算误差极大（credits 本身接近 0），跳过正常路径。
    // 返回一个保守估算：将本地 token 数按 input_price/cache_creation_price 比例（≈3/3.75）折算为
    // cache_creation_tokens，cache_read=0。这是经验近似，不代表真实缓存行为。
    // 如实际观察效果不理想，删除此 if 块即可回退到正常路径。
    if (localInputTokens < 200) {
        logger.info(
            `[Model Pricing] Skip cache calc (localInputTokens < 200): model=${modelId}` +
            `, credits=${meteringCredits}, inputTokens=${inputTokens}, localInput=${localInputTokens}` +
            `, outputTokens=${outputTokens}`
        );
        return { cacheCreationTokens: Math.round(localInputTokens*3/3.75), cacheReadTokens: 0 };
    }

    const pricing = getModelPricing(modelId);
    if (!pricing || !pricing.cache_read_input_token_cost || !pricing.cache_creation_input_token_cost || !pricing.output_cost_per_token) {
        return { cacheCreationTokens: 0, cacheReadTokens: 0 };
    }

    const cacheReadPrice   = pricing.cache_read_input_token_cost;
    const cacheCreatePrice = pricing.cache_creation_input_token_cost;
    // input_cost_per_token 未必存在于所有价格条目，回退到 cacheReadPrice 作保守下限
    const inputPrice = pricing.input_cost_per_token || cacheReadPrice;

    // ── _cr_limit 计算 ──────────────────────────────────────────────────────
    // 若 credits < _cr_limit，说明本轮连"max_tokens 全输出"的费用都不到，
    // 不可能有大量历史缓存消耗，走小请求路径。
    // 未传 max_tokens 时用 256 作保守估算（避免 _cr_limit=0 导致所有请求走小路径）。
    const effectiveMaxTokens = maxTokens > 0 ? maxTokens : 256;
    const crLimit       = (effectiveMaxTokens * pricing.output_cost_per_token) / CREDIT_TO_USD_LOW;
    const isSmallRequest = meteringCredits < crLimit;

    let totalCost, inputCost, cacheCreationTokens, cacheReadTokens;

    if (isSmallRequest && localInputTokens > 0) {
        // ── 小请求路径：3-class 公式 ────────────────────────────────────────
        // regular 固定为本地 tokenizer 估算值，剩余部分再用 2-class 拆 creation/read。
        totalCost = meteringCredits * CREDIT_TO_USD_LOW;
        const outputCost  = outputTokens * pricing.output_cost_per_token;
        inputCost = Math.max(0, totalCost - outputCost);

        // regularTokens 不超过 inputTokens（防御：本地估算偶尔会高于上游总量）
        const regularTokens  = Math.min(localInputTokens, inputTokens);
        const regularCost    = regularTokens * inputPrice;
        const remainingCost  = Math.max(0, inputCost - regularCost);
        const remainingTokens = Math.max(0, inputTokens - regularTokens);

        if (remainingTokens <= 0 || cacheCreatePrice === cacheReadPrice) {
            // 无剩余 token 可拆，或 create/read 同价无意义拆分
            cacheCreationTokens = 0;
            cacheReadTokens     = 0;
        } else {
            // 对剩余部分再做 2-class 拆分
            let creation = (remainingCost - remainingTokens * cacheReadPrice) / (cacheCreatePrice - cacheReadPrice);
            creation = Math.max(0, Math.min(creation, remainingTokens));
            cacheCreationTokens = Math.round(creation);
            cacheReadTokens     = Math.max(0, remainingTokens - cacheCreationTokens);
        }

        logger.info(
            `[Model Pricing] Calc(3-class): model=${modelId}` +
            `, credits=${meteringCredits}, crLimit=${crLimit.toFixed(6)}` +
            `, totalCost=$${totalCost.toFixed(6)}` +
            `, outputCost=$${(outputTokens * pricing.output_cost_per_token).toFixed(6)}` +
            `, inputCost=$${inputCost.toFixed(6)}` +
            `, inputTokens=${inputTokens}, localInput=${localInputTokens}` +
            `, regular=${regularTokens}` +
            `, cacheCreate=${cacheCreationTokens}, cacheRead=${cacheReadTokens}`
        );
    } else {
        // ── 大请求路径：原 2-class 公式 ─────────────────────────────────────
        // 假设 regular≈0，所有输入非 cache_read 即 cache_creation。
        // 适用于上下文窗口有大量历史缓存的正常 Claude Code 会话。
        totalCost = meteringCredits * CREDIT_TO_USD;
        const outputCost = outputTokens * pricing.output_cost_per_token;
        inputCost = Math.max(0, totalCost - outputCost);

        logger.info(
            `[Model Pricing] Calc(2-class): model=${modelId}` +
            `, credits=${meteringCredits}, crLimit=${crLimit.toFixed(6)}` +
            `, totalCost=$${totalCost.toFixed(6)}` +
            `, outputCost=$${outputCost.toFixed(6)}` +
            `, inputCost=$${inputCost.toFixed(6)}` +
            `, inputTokens=${inputTokens}` +
            `, cacheReadPrice=${cacheReadPrice}, cacheCreatePrice=${cacheCreatePrice}`
        );

        if (cacheCreatePrice === cacheReadPrice) {
            // 同价时无法区分，全部归入 cacheRead（计费等价）
            return { cacheCreationTokens: 0, cacheReadTokens: inputTokens };
        }

        let creation = (inputCost - inputTokens * cacheReadPrice) / (cacheCreatePrice - cacheReadPrice);
        creation = Math.max(0, Math.min(creation, inputTokens));
        cacheCreationTokens = Math.round(creation);
        cacheReadTokens     = Math.max(0, inputTokens - cacheCreationTokens);
    }

    return { cacheCreationTokens, cacheReadTokens };
}
