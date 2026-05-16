/**
 * 代理工具模块
 * 支持 HTTP、HTTPS 和 SOCKS5 代理
 */

import { HttpsProxyAgent } from 'https-proxy-agent';
import logger from './logger.js';
import { HttpProxyAgent } from 'http-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { getTLSSidecar } from './tls-sidecar.js';

/**
 * 从插件中解析当前节点的代理 URL。
 * 检查 config 中是否由插件注入了 ipNodeProxy.getProxyUrl 方法。
 *
 * @param {Object} config - 已合并节点配置的请求配置
 * @param {string} providerType - 提供商类型
 * @returns {string|null} 绑定的代理 URL
 */
export function getNodeProxyUrlFromBinding(config, providerType) {
    if (typeof config?.ipNodeProxy?.getProxyUrl === 'function') {
        try {
            return config.ipNodeProxy.getProxyUrl(providerType, config.uuid);
        } catch (error) {
            const nodeName = config?.customName || config?.uuid || 'unknown';
            logger.error(`[Proxy] Error calling ipNodeProxy.getProxyUrl for ${providerType}/${nodeName}:`, error.message);
        }
    }

    return null;
}


/**
 * 解析代理URL并返回相应的代理配置
 * @param {string} proxyUrl - 代理URL，如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080
 * @returns {Object|null} 代理配置对象，包含 httpAgent 和 httpsAgent
 */
export function parseProxyUrl(proxyUrl) {
    if (!proxyUrl || typeof proxyUrl !== 'string') {
        return null;
    }

    const trimmedUrl = proxyUrl.trim();
    if (!trimmedUrl) {
        return null;
    }

    try {
        const url = new URL(trimmedUrl);
        const protocol = url.protocol.toLowerCase();

        if (protocol === 'socks5:' || protocol === 'socks4:' || protocol === 'socks:') {
            // SOCKS 代理
            const socksAgent = new SocksProxyAgent(trimmedUrl);
            return {
                httpAgent: socksAgent,
                httpsAgent: socksAgent,
                proxyType: 'socks'
            };
        } else if (protocol === 'http:' || protocol === 'https:') {
            // HTTP/HTTPS 代理
            return {
                httpAgent: new HttpProxyAgent(trimmedUrl),
                httpsAgent: new HttpsProxyAgent(trimmedUrl),
                proxyType: 'http'
            };
        } else {
            logger.warn(`[Proxy] Unsupported proxy protocol: ${protocol}`);
            return null;
        }
    } catch (error) {
        logger.error(`[Proxy] Failed to parse proxy URL: ${error.message}`);
        return null;
    }
}

/**
 * 判断账号级 proxy URL 是否已设置（非空字符串）
 * @param {*} value
 * @returns {boolean}
 */
function hasAccountProxyUrl(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

/**
 * 检查指定的提供商是否启用了代理（支持前缀匹配）
 *
 * 优先级（从高到低）：
 * 1. config.ACCOUNT_PROXY_DISABLED === true → 强制直连，返回 false
 * 2. 插件注入的 ipNodeProxy.getProxyUrl 返回非空 → 节点级代理生效，返回 true（绕过白名单）
 * 3. config.ACCOUNT_PROXY_URL 非空字符串 → 账号级代理生效，返回 true（绕过白名单）
 * 4. 全局 PROXY_URL + PROXY_ENABLED_PROVIDERS 白名单匹配
 *
 * @param {Object} config - 配置对象（可能已合并账号级字段）
 * @param {string} providerType - 提供商类型
 * @returns {boolean} 是否启用代理
 */
export function isProxyEnabledForProvider(config, providerType) {
    if (!config) {
        return false;
    }

    // 账号级：显式禁用（最高优先级）
    if (config.ACCOUNT_PROXY_DISABLED === true) {
        return false;
    }

    // 节点级：插件注入的 IP 节点绑定代理（绕过白名单）
    if (getNodeProxyUrlFromBinding(config, providerType)) {
        return true;
    }

    // 账号级：账号自带代理 URL → 绕过白名单
    if (hasAccountProxyUrl(config.ACCOUNT_PROXY_URL)) {
        return true;
    }

    // 全局代理逻辑
    if (!config.PROXY_URL || !config.PROXY_ENABLED_PROVIDERS) {
        return false;
    }

    const enabledProviders = config.PROXY_ENABLED_PROVIDERS;
    if (!Array.isArray(enabledProviders)) {
        return false;
    }

    // 1. 尝试精确匹配
    if (enabledProviders.includes(providerType)) {
        return true;
    }

    // 2. 尝试前缀匹配 (例如 openai-custom-prod 继承 openai-custom 的配置)
    return enabledProviders.some(p => providerType.startsWith(p + '-'));
}

/**
 * 获取指定提供商的代理配置
 *
 * 会先走 isProxyEnabledForProvider 判断是否启用，然后按优先级选取 URL：
 * 账号级 ACCOUNT_PROXY_URL 非空时使用账号 URL，否则使用全局 PROXY_URL。
 *
 * @param {Object} config - 配置对象
 * @param {string} providerType - 提供商类型
 * @returns {Object|null} 代理配置对象或 null
 */
export function getProxyConfigForProvider(config, providerType) {
    if (!isProxyEnabledForProvider(config, providerType)) {
        return null;
    }

    // URL 选择优先级：node binding > account > global
    const boundProxyUrl = getNodeProxyUrlFromBinding(config, providerType);
    const useAccountProxy = !boundProxyUrl && hasAccountProxyUrl(config.ACCOUNT_PROXY_URL);
    const chosenUrl = boundProxyUrl
        ? boundProxyUrl
        : (useAccountProxy ? config.ACCOUNT_PROXY_URL.trim() : config.PROXY_URL);
    const source = boundProxyUrl ? 'node-binding' : (useAccountProxy ? 'account' : 'global');

    const proxyConfig = parseProxyUrl(chosenUrl);
    if (proxyConfig) {
        logger.info(`[Proxy] Using ${proxyConfig.proxyType} proxy (${source}) for ${providerType}: ${chosenUrl}`);
    }

    return proxyConfig;
}

/**
 * 为 axios 配置代理
 * @param {Object} axiosConfig - axios 配置对象
 * @param {Object} config - 应用配置对象
 * @param {string} providerType - 提供商类型
 * @returns {Object} 更新后的 axios 配置
 */
export function configureAxiosProxy(axiosConfig, config, providerType) {
    const proxyConfig = getProxyConfigForProvider(config, providerType);

    if (proxyConfig) {
        // 使用代理 agent
        axiosConfig.httpAgent = proxyConfig.httpAgent;
        axiosConfig.httpsAgent = proxyConfig.httpsAgent;
        // 禁用 axios 内置的代理配置，使用我们的 agent
        axiosConfig.proxy = false;
    }

    return axiosConfig;
}

/**
 * 检查指定的提供商是否启用了 TLS Sidecar（支持前缀匹配）
 * @param {Object} config - 配置对象
 * @param {string} providerType - 提供商类型
 * @returns {boolean} 是否启用 TLS Sidecar
 */
export function isTLSSidecarEnabledForProvider(config, providerType) {
    if (!config || !config.TLS_SIDECAR_ENABLED || !config.TLS_SIDECAR_ENABLED_PROVIDERS) {
        return false;
    }

    const enabledProviders = config.TLS_SIDECAR_ENABLED_PROVIDERS;
    if (!Array.isArray(enabledProviders)) {
        return false;
    }

    // 1. 尝试精确匹配
    if (enabledProviders.includes(providerType)) {
        return true;
    }

    // 2. 尝试前缀匹配
    return enabledProviders.some(p => providerType.startsWith(p + '-'));
}

/**
 * 为 axios 配置 TLS Sidecar
 * @param {Object} axiosConfig - axios 配置对象
 * @param {Object} config - 应用配置对象
 * @param {string} providerType - 提供商类型
 * @param {string} [defaultBaseUrl] - 默认基础 URL（用于处理相对路径）
 * @returns {Object} 更新后的 axios 配置
 */
export function configureTLSSidecar(axiosConfig, config, providerType, defaultBaseUrl = null) {
    const sidecar = getTLSSidecar();
    if (sidecar.isReady() && isTLSSidecarEnabledForProvider(config, providerType)) {
        // 代理优先级：node binding > ACCOUNT_PROXY_URL > TLS_SIDECAR_PROXY_URL > null
        let proxyUrl = null;
        const boundProxyUrl = getNodeProxyUrlFromBinding(config, providerType);
        if (boundProxyUrl) {
            proxyUrl = boundProxyUrl;
        } else if (!config.ACCOUNT_PROXY_DISABLED) {
            proxyUrl = config.ACCOUNT_PROXY_URL?.trim() || config.TLS_SIDECAR_PROXY_URL || null;
        }

        // TLS 指纹 profile（从账号指纹配置读取）
        const tlsProfile = config.ACCOUNT_TLS_PROFILE || null;

        // 处理相对路径
        if (axiosConfig.url && !axiosConfig.url.startsWith('http')) {
            const baseUrl = (axiosConfig.baseURL || defaultBaseUrl || '').replace(/\/$/, '');
            if (baseUrl) {
                const path = axiosConfig.url.startsWith('/') ? axiosConfig.url : '/' + axiosConfig.url;
                axiosConfig.url = baseUrl + path;
            }
        }

        sidecar.wrapAxiosConfig(axiosConfig, { proxyUrl, tlsProfile });
    }
    return axiosConfig;
}

/**
 * 为 google-auth-library 配置代理
 * @param {Object} config - 应用配置对象
 * @param {string} providerType - 提供商类型
 * @returns {Object|null} transporter 配置对象或 null
 */
export function getGoogleAuthProxyConfig(config, providerType) {
    const proxyConfig = getProxyConfigForProvider(config, providerType);

    if (proxyConfig) {
        return {
            agent: proxyConfig.httpsAgent
        };
    }

    return null;
}
