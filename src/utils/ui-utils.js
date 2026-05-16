/**
 * UI 相关的工具函数
 */
import { UI_PATHS } from './constants.js';

/**
 * 判断是否为 UI 静态资源路径
 * @param {string} path - 请求路径
 * @returns {boolean}
 */
export function isUIPath(path) {
    // 检查常见静态文件扩展名
    const isStaticExtension = /\.(png|jpg|jpeg|gif|svg|ico)$/i.test(path);
    
    return UI_PATHS.STATIC_PREFIXES.some(prefix => path.startsWith(prefix)) || 
           UI_PATHS.STATIC_EXACT.includes(path) ||
           isStaticExtension;
}

/**
 * 判断是否为 UI 管理 API 路径
 * @param {string} path - 请求路径
 * @returns {boolean}
 */
export function isUIApiPath(path) {
    // 检查是否以 API 前缀开始，且不在白名单中
    return path.startsWith(UI_PATHS.API_PREFIX) && 
           !UI_PATHS.API_WHITELIST.includes(path);
}

/**
 * 判断是否为任何形式的 UI 相关路径（资源或 API）
 * @param {string} path - 请求路径
 * @returns {boolean}
 */
export function isAnyUIPath(path) {
    return isUIPath(path) || isUIApiPath(path);
}
