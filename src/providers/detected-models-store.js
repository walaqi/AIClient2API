import { existsSync, readFileSync } from 'fs';
import logger from '../utils/logger.js';
import { CONFIG } from '../core/config-manager.js';
import { withFileLock, atomicWriteFile } from '../utils/file-lock.js';

/**
 * 检测模型缓存（detected_models.json）
 *
 * 与 custom_models.json 的职责区分：
 *  - custom_models.json：人工维护的"自定义映射"（带 alias / actualModel /
 *    contextLength 等有意义的覆盖），属于配置。
 *  - detected_models.json：detect-models 自动探测到的上游原生模型清单缓存，
 *    纯 ID 列表（恒等模型无需映射），属于运行时缓存。
 *
 * 结构：
 *   {
 *     "claude-kiro-oauth": ["auto", "claude-opus-4.8", "deepseek-3.2", ...],
 *     "openai-codex-oauth": [...]
 *   }
 */

const DEFAULT_DETECTED_MODELS_FILE = 'configs/detected_models.json';

export function getDetectedModelsFilePath(currentConfig = CONFIG) {
    return currentConfig?.DETECTED_MODELS_FILE_PATH || DEFAULT_DETECTED_MODELS_FILE;
}

/**
 * 从磁盘加载检测模型缓存。容错：文件不存在或解析失败时返回 {}。
 * @param {string} [filePath]
 * @returns {Object<string, string[]>}
 */
export function loadDetectedModelsFromDisk(filePath = DEFAULT_DETECTED_MODELS_FILE) {
    try {
        if (!existsSync(filePath)) {
            return {};
        }
        const data = readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(data);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            // 归一化：值必须是字符串数组
            const result = {};
            for (const [provider, models] of Object.entries(parsed)) {
                if (Array.isArray(models)) {
                    result[provider] = models.filter(m => typeof m === 'string' && m.trim()).map(m => m.trim());
                }
            }
            return result;
        }
        return {};
    } catch (error) {
        logger.warn(`[DetectedModels] Failed to load detected models from ${filePath}: ${error.message}`);
        return {};
    }
}

/**
 * 取指定 provider 类型的检测缓存（支持前缀匹配，如 claude-kiro-oauth-1 → claude-kiro-oauth）。
 * @param {string} providerType
 * @param {Object} [detectedMap] - 默认读 CONFIG.detectedModels
 * @returns {string[]|null} 命中返回数组（可能为空数组），未命中返回 null
 */
export function getDetectedModelsForProvider(providerType, detectedMap = CONFIG.detectedModels) {
    if (!detectedMap || typeof detectedMap !== 'object') {
        return null;
    }
    if (Array.isArray(detectedMap[providerType])) {
        return detectedMap[providerType];
    }
    // 前缀匹配：openai-custom-1 → openai-custom
    for (const key of Object.keys(detectedMap)) {
        if (providerType.startsWith(key + '-') && Array.isArray(detectedMap[key])) {
            return detectedMap[key];
        }
    }
    return null;
}

/**
 * 把检测到的模型写入缓存文件，并同步到 CONFIG.detectedModels。
 * 策略：整组覆盖该 providerType 的缓存（检测结果即权威的当前上游清单）。
 *
 * @param {Object} currentConfig
 * @param {string} providerType
 * @param {string[]} modelIds - 检测到的完整 modelId 列表
 * @returns {Promise<{providerType: string, models: string[], changed: boolean}>}
 */
export async function saveDetectedModels(currentConfig, providerType, modelIds) {
    const filePath = getDetectedModelsFilePath(currentConfig);

    return await withFileLock(filePath, async () => {
        const detectedMap = loadDetectedModelsFromDisk(filePath);

        const normalized = Array.from(new Set(
            (Array.isArray(modelIds) ? modelIds : [])
                .filter(id => typeof id === 'string')
                .map(id => id.trim())
                .filter(Boolean)
        ));

        const previous = Array.isArray(detectedMap[providerType]) ? detectedMap[providerType] : [];
        const changed = previous.length !== normalized.length ||
            previous.some((m, i) => m !== normalized[i]);

        detectedMap[providerType] = normalized;

        await atomicWriteFile(filePath, JSON.stringify(detectedMap, null, 2), 'utf-8');

        // 同步运行时
        currentConfig.detectedModels = detectedMap;
        CONFIG.detectedModels = detectedMap;

        logger.info(`[DetectedModels] saved ${providerType}: ${normalized.length} models (changed=${changed}) → ${filePath}`);

        return { providerType, models: normalized, changed };
    });
}
