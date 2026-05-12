/**
 * 确定性浏览器指纹生成模块
 * 从账号 UUID + generation 派生唯一且稳定的浏览器指纹
 */
import { createHash } from 'crypto';

// TLS Profile 数据库 — 每个条目是一个原子单元（TLS/UA/sec-ch-ua 版本强绑定）
const CHROME_PROFILES = [
    {
        tlsProfile: 'HelloChrome_120',
        majorVersion: '120',
        fullVersion: '120.0.6099.130',
        chromiumFullVersion: '120.0.6099.130',
        notABrand: { brand: 'Not_A Brand', version: '8' },
    },
    {
        tlsProfile: 'HelloChrome_131',
        majorVersion: '131',
        fullVersion: '131.0.6778.109',
        chromiumFullVersion: '131.0.6778.109',
        notABrand: { brand: 'Not A(Brand', version: '24' },
    },
    {
        tlsProfile: 'HelloChrome_133',
        majorVersion: '133',
        fullVersion: '133.0.6943.98',
        chromiumFullVersion: '133.0.6943.98',
        notABrand: { brand: 'Not A(Brand', version: '24' },
    },
];

const NON_CHROME_PROFILES = [
    {
        tlsProfile: 'HelloFirefox_120',
        browser: 'Firefox',
        majorVersion: '120',
        fullVersion: '120.0',
    },
    {
        tlsProfile: 'HelloSafari_Auto',
        browser: 'Safari',
        majorVersion: '16',
        fullVersion: '16.0',
    },
    {
        tlsProfile: 'HelloEdge_106',
        browser: 'Edge',
        majorVersion: '106',
        fullVersion: '106.0.1370.52',
        chromiumFullVersion: '106.0.5249.119',
        notABrand: { brand: 'Not;A=Brand', version: '99' },
    },
];

const PLATFORMS = [
    { name: 'Windows', arch: 'x86', bitness: '64', versions: ['1.0.0', '3.0.0', '7.0.0', '10.0.0'] },
    { name: 'Windows', arch: 'x86', bitness: '64', versions: ['13.0.0', '14.0.0', '15.0.0'] },
    { name: 'macOS', arch: 'arm', bitness: '64', versions: ['13.0.0', '14.0.0', '14.5.0', '15.0.0'] },
];

/**
 * 从 seed buffer 创建确定性伪随机数生成器
 */
class SeededRNG {
    constructor(seedBuffer) {
        this.buffer = seedBuffer;
        this.offset = 0;
    }

    nextUint32() {
        if (this.offset + 4 > this.buffer.length) {
            this.buffer = createHash('sha256').update(this.buffer).digest();
            this.offset = 0;
        }
        const val = this.buffer.readUInt32BE(this.offset);
        this.offset += 4;
        return val;
    }

    pick(arr) {
        return arr[this.nextUint32() % arr.length];
    }
}

function buildSeed(uuid, generation) {
    return createHash('sha256').update(`${uuid}:${generation}`).digest();
}

function buildChromeUA(profile, platform) {
    if (platform.name === 'Windows') {
        return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${profile.fullVersion} Safari/537.36`;
    }
    return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${profile.fullVersion} Safari/537.36`;
}

function buildEdgeUA(profile, platform) {
    if (platform.name === 'Windows') {
        return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${profile.chromiumFullVersion} Safari/537.36 Edg/${profile.fullVersion}`;
    }
    return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${profile.chromiumFullVersion} Safari/537.36 Edg/${profile.fullVersion}`;
}

function buildSecChUa(profile) {
    return `"Google Chrome";v="${profile.majorVersion}", "Chromium";v="${profile.majorVersion}", "${profile.notABrand.brand}";v="${profile.notABrand.version}"`;
}

function buildSecChUaFullVersionList(profile) {
    return `"Google Chrome";v="${profile.fullVersion}", "Chromium";v="${profile.chromiumFullVersion}", "${profile.notABrand.brand}";v="${profile.notABrand.version}.0.0.0"`;
}

/**
 * 生成 Chrome 系列指纹（用于 Grok 等需要 Chrome 身份的 provider）
 */
function generateChromeFingerprint(rng) {
    const profile = rng.pick(CHROME_PROFILES);
    const platform = rng.pick(PLATFORMS);
    const platformVersion = rng.pick(platform.versions);

    return {
        ACCOUNT_TLS_PROFILE: profile.tlsProfile,
        ACCOUNT_USER_AGENT: buildChromeUA(profile, platform),
        ACCOUNT_BROWSER_VERSION: profile.majorVersion,
        ACCOUNT_PLATFORM: platform.name,
        ACCOUNT_PLATFORM_VERSION: platformVersion,
        ACCOUNT_SEC_CH_UA: buildSecChUa(profile),
        ACCOUNT_SEC_CH_UA_FULL_VERSION: profile.fullVersion,
        ACCOUNT_SEC_CH_UA_FULL_VERSION_LIST: buildSecChUaFullVersionList(profile),
    };
}

/**
 * 生成任意浏览器指纹（用于 API 类 provider，只需 TLS 差异化）
 */
function generateAnyFingerprint(rng) {
    const allProfiles = [...CHROME_PROFILES, ...NON_CHROME_PROFILES];
    const profile = rng.pick(allProfiles);
    const platform = rng.pick(PLATFORMS);
    const platformVersion = rng.pick(platform.versions);

    if (profile.browser === 'Firefox') {
        return {
            ACCOUNT_TLS_PROFILE: profile.tlsProfile,
            ACCOUNT_USER_AGENT: `Mozilla/5.0 (${platform.name === 'Windows' ? 'Windows NT 10.0; Win64; x64' : 'Macintosh; Intel Mac OS X 10.15'}; rv:${profile.fullVersion}) Gecko/20100101 Firefox/${profile.fullVersion}`,
            ACCOUNT_BROWSER_VERSION: profile.majorVersion,
            ACCOUNT_PLATFORM: platform.name,
            ACCOUNT_PLATFORM_VERSION: platformVersion,
            ACCOUNT_SEC_CH_UA: '',
            ACCOUNT_SEC_CH_UA_FULL_VERSION: '',
            ACCOUNT_SEC_CH_UA_FULL_VERSION_LIST: '',
        };
    }

    if (profile.browser === 'Safari') {
        return {
            ACCOUNT_TLS_PROFILE: profile.tlsProfile,
            ACCOUNT_USER_AGENT: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${profile.fullVersion} Safari/605.1.15`,
            ACCOUNT_BROWSER_VERSION: profile.majorVersion,
            ACCOUNT_PLATFORM: 'macOS',
            ACCOUNT_PLATFORM_VERSION: platformVersion,
            ACCOUNT_SEC_CH_UA: '',
            ACCOUNT_SEC_CH_UA_FULL_VERSION: '',
            ACCOUNT_SEC_CH_UA_FULL_VERSION_LIST: '',
        };
    }

    if (profile.browser === 'Edge') {
        return {
            ACCOUNT_TLS_PROFILE: profile.tlsProfile,
            ACCOUNT_USER_AGENT: buildEdgeUA(profile, platform),
            ACCOUNT_BROWSER_VERSION: profile.majorVersion,
            ACCOUNT_PLATFORM: platform.name,
            ACCOUNT_PLATFORM_VERSION: platformVersion,
            ACCOUNT_SEC_CH_UA: `"Microsoft Edge";v="${profile.majorVersion}", "Chromium";v="${profile.majorVersion}", "${profile.notABrand.brand}";v="${profile.notABrand.version}"`,
            ACCOUNT_SEC_CH_UA_FULL_VERSION: profile.fullVersion,
            ACCOUNT_SEC_CH_UA_FULL_VERSION_LIST: `"Microsoft Edge";v="${profile.fullVersion}", "Chromium";v="${profile.chromiumFullVersion}", "${profile.notABrand.brand}";v="${profile.notABrand.version}.0.0.0"`,
        };
    }

    // Chrome profile (from allProfiles)
    return generateChromeFingerprint(new SeededRNG(buildSeed(rng.nextUint32().toString(), 0)));
}

/**
 * 为账号生成确定性浏览器指纹
 * @param {string} uuid - 账号 UUID
 * @param {string} providerType - provider 类型（如 'grok-web', 'claude', 'openai'）
 * @param {number} generation - 指纹代数（用于轮换，默认 0）
 * @returns {object} 扁平指纹字段
 */
export function generateFingerprint(uuid, providerType, generation = 0) {
    const seed = buildSeed(uuid, generation);
    const rng = new SeededRNG(seed);

    const chromeOnlyProviders = ['grok-web', 'grok'];
    const needsChrome = chromeOnlyProviders.some(p => providerType.startsWith(p));

    const fingerprint = needsChrome
        ? generateChromeFingerprint(rng)
        : generateAnyFingerprint(rng);

    fingerprint.ACCOUNT_FINGERPRINT_GENERATION = generation;
    return fingerprint;
}

/**
 * 检查指纹字段是否已填充
 */
export function hasFingerprint(config) {
    return !!(config && config.ACCOUNT_TLS_PROFILE);
}

export const FINGERPRINT_FIELDS = [
    'ACCOUNT_TLS_PROFILE',
    'ACCOUNT_USER_AGENT',
    'ACCOUNT_BROWSER_VERSION',
    'ACCOUNT_PLATFORM',
    'ACCOUNT_PLATFORM_VERSION',
    'ACCOUNT_SEC_CH_UA',
    'ACCOUNT_SEC_CH_UA_FULL_VERSION',
    'ACCOUNT_SEC_CH_UA_FULL_VERSION_LIST',
    'ACCOUNT_FINGERPRINT_GENERATION',
];
