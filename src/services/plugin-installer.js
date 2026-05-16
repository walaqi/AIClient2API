import axios from 'axios';
import AdmZip from 'adm-zip';
import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import path from 'path';
import logger from '../utils/logger.js';
import { getPluginManager } from '../core/plugin-manager.js';

const DEFAULT_MARKET_URL = 'https://source.hex2077.dev/files/market.json';
const LOCAL_MARKET_FILE = path.join(process.cwd(), 'configs', 'market.json');
const PLUGINS_DIR = path.join(process.cwd(), 'src', 'plugins');
const STATIC_DIR = path.join(process.cwd(), 'static');
const TEMP_DIR = path.join(process.cwd(), 'tmp', 'plugin-downloads');

/**
 * 获取插件市场列表
 * @param {string} [url] - 可选的更新 URL，如果提供则从该地址抓取并覆盖本地缓存
 */
export async function fetchMarketPlugins(url = null) {
    const targetUrl = url || DEFAULT_MARKET_URL;
    
    try {
        // 优先从网络获取
        const response = await axios.get(targetUrl, { timeout: 10000 });
        const marketData = response.data;

        // 成功获取后更新本地缓存
        try {
            await fs.mkdir(path.dirname(LOCAL_MARKET_FILE), { recursive: true });
            await fs.writeFile(LOCAL_MARKET_FILE, JSON.stringify(marketData, null, 2), 'utf8');
        } catch (saveError) {
            logger.warn('[PluginInstaller] Failed to cache market data locally:', saveError.message);
        }

        return marketData;
    } catch (error) {
        // 网络请求失败，尝试使用本地缓存
        if (existsSync(LOCAL_MARKET_FILE)) {
            try {
                logger.info(`[PluginInstaller] Using local market cache due to fetch error: ${error.message}`);
                const content = await fs.readFile(LOCAL_MARKET_FILE, 'utf8');
                return JSON.parse(content);
            } catch (localError) {
                logger.error('[PluginInstaller] Failed to read local market cache:', localError.message);
            }
        }

        logger.error('[PluginInstaller] Failed to fetch market index:', error.message);
        throw new Error('获取插件市场失败（网络请求失败且无可用本地缓存）：' + error.message);
    }
}

/**
 * 内部通用的安装逻辑
 * @private
 */
async function _executeInstall(id, zipPath) {
    const pluginPath = path.join(PLUGINS_DIR, id);
    const zip = new AdmZip(zipPath);
    const zipEntries = zip.getEntries();

    // 1. 创建插件目录
    await fs.mkdir(pluginPath, { recursive: true });

    // 2. 遍历并分类解压
    for (const entry of zipEntries) {
        if (entry.isDirectory) continue;

        const fileName = entry.entryName.split('/').pop();
        const isHtml = fileName.toLowerCase().endsWith('.html');
        
        // 如果是 HTML，解压到 static 目录
        if (isHtml) {
            const targetPath = path.join(STATIC_DIR, fileName);
            await fs.writeFile(targetPath, entry.getData());
            logger.info(`[PluginInstaller] Extracted HTML to static: ${fileName}`);
        } else {
            // 其他文件（js, package.json 等）解压到插件目录
            // 注意：这里我们简单平铺，如果插件有复杂结构，建议保持 entryName
            // 但为了兼容“单文件夹包裹”，我们尝试去掉第一层目录
            let relativePath = entry.entryName;
            const pathParts = relativePath.split('/');
            if (pathParts.length > 1 && pathParts[0] === id) {
                pathParts.shift();
                relativePath = pathParts.join('/');
            }
            
            const targetPath = path.join(pluginPath, relativePath);
            await fs.mkdir(path.dirname(targetPath), { recursive: true });
            await fs.writeFile(targetPath, entry.getData());
        }
    }

    // 3. 基础校验
    if (!existsSync(path.join(pluginPath, 'index.js'))) {
        throw new Error('插件包内未找到 index.js 入口文件');
    }

    // 4. 加载插件
    const pluginManager = getPluginManager();
    await pluginManager.loadAndInitPlugin(id);
    return true;
}

/**
 * 下载并安装插件
 */
export async function installPlugin(pluginInfo) {
    const { id, downloadUrl } = pluginInfo;
    const zipPath = path.join(TEMP_DIR, `${id}.zip`);

    try {
        if (!existsSync(TEMP_DIR)) await fs.mkdir(TEMP_DIR, { recursive: true });

        const response = await axios({
            method: 'get',
            url: downloadUrl,
            responseType: 'arraybuffer',
            timeout: 30000
        });

        await fs.writeFile(zipPath, Buffer.from(response.data));
        await _executeInstall(id, zipPath);
        await fs.unlink(zipPath);
        return true;
    } catch (error) {
        logger.error(`[PluginInstaller] Installation failed for ${id}:`, error.message);
        throw error;
    }
}

/**
 * 从上传的文件安装插件
 */
export async function installPluginFromBuffer(pluginId, buffer) {
    const zipPath = path.join(TEMP_DIR, `${pluginId}_upload_${Date.now()}.zip`);

    try {
        if (!existsSync(TEMP_DIR)) await fs.mkdir(TEMP_DIR, { recursive: true });
        await fs.writeFile(zipPath, buffer);
        await _executeInstall(pluginId, zipPath);
        await fs.unlink(zipPath);
        return true;
    } catch (error) {
        logger.error(`[PluginInstaller] Upload installation failed:`, error.message);
        throw error;
    }
}
