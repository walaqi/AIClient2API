/**
 * 验证 KIRO_MODEL_CAPABILITIES 解析逻辑：
 * - parseClaudeVersion / isClaudeVersionAtLeast 版本解析
 * - getKiroModelCapabilities 的优先级: per-model > default > 版本默认
 *
 * 背景 (app-2026-05-31.log 实测):
 *   additionalModelRequestFields:{thinking:{type:adaptive}}
 *     - opus-4.7 接受 (成功)
 *     - sonnet-4.5 / opus-4.5 返回 400 "not supported for this model"
 *   => nativeThinking 版本门槛默认 >= 4.7.
 */

import { jest } from '@jest/globals';

jest.mock('../../src/utils/tls-sidecar.js', () => ({
    __esModule: true,
    getTLSSidecar: () => null,
    default: null,
}));

jest.mock('../../src/services/service-manager.js', () => ({
    __esModule: true,
    getProviderPoolManager: () => ({}),
}));

import {
    parseClaudeVersion,
    isClaudeVersionAtLeast,
    getKiroModelCapabilities,
} from '../../src/providers/claude/claude-kiro.js';

describe('parseClaudeVersion', () => {
    test('解析点号格式 claude-opus-4.7', () => {
        expect(parseClaudeVersion('claude-opus-4.7')).toEqual({ major: 4, minor: 7 });
    });
    test('解析连字符格式 claude-opus-4-7', () => {
        expect(parseClaudeVersion('claude-opus-4-7')).toEqual({ major: 4, minor: 7 });
    });
    test('容忍日期后缀 claude-opus-4-5-20251101', () => {
        expect(parseClaudeVersion('claude-opus-4-5-20251101')).toEqual({ major: 4, minor: 5 });
    });
    test('sonnet / haiku family', () => {
        expect(parseClaudeVersion('claude-sonnet-4.6')).toEqual({ major: 4, minor: 6 });
        expect(parseClaudeVersion('claude-haiku-4-5')).toEqual({ major: 4, minor: 5 });
    });
    test('无法解析返回 null', () => {
        expect(parseClaudeVersion('auto')).toBeNull();
        expect(parseClaudeVersion('deepseek-3.2')).toBeNull();
        expect(parseClaudeVersion(null)).toBeNull();
        expect(parseClaudeVersion(123)).toBeNull();
    });
});

describe('isClaudeVersionAtLeast', () => {
    test('>= 4.7 门槛', () => {
        expect(isClaudeVersionAtLeast('claude-opus-4.7', 4, 7)).toBe(true);
        expect(isClaudeVersionAtLeast('claude-opus-4.8', 4, 7)).toBe(true);
        expect(isClaudeVersionAtLeast('claude-opus-4.6', 4, 7)).toBe(false);
        expect(isClaudeVersionAtLeast('claude-opus-4.5', 4, 7)).toBe(false);
        expect(isClaudeVersionAtLeast('claude-sonnet-4.5', 4, 7)).toBe(false);
    });
    test('跨主版本号', () => {
        expect(isClaudeVersionAtLeast('claude-opus-5.0', 4, 7)).toBe(true);
        expect(isClaudeVersionAtLeast('claude-opus-3.5', 4, 7)).toBe(false);
    });
    test('解析失败返回 false', () => {
        expect(isClaudeVersionAtLeast('auto', 4, 7)).toBe(false);
    });
});

describe('getKiroModelCapabilities — 版本默认 (无 config)', () => {
    test('opus-4.7 默认 nativeThinking=true, contextCompression=true', () => {
        const caps = getKiroModelCapabilities({}, 'claude-opus-4.7');
        expect(caps.nativeThinking).toBe(true);
        expect(caps.contextCompression).toBe(true);
    });
    test('opus-4.8 默认 nativeThinking=true', () => {
        expect(getKiroModelCapabilities({}, 'claude-opus-4.8').nativeThinking).toBe(true);
    });
    test('sonnet-4.5 默认 nativeThinking=false (修复 400 bug)', () => {
        expect(getKiroModelCapabilities({}, 'claude-sonnet-4.5').nativeThinking).toBe(false);
    });
    test('opus-4.5 默认 nativeThinking=false', () => {
        expect(getKiroModelCapabilities({}, 'claude-opus-4.5').nativeThinking).toBe(false);
    });
    test('opus-4.6 默认 nativeThinking=false', () => {
        expect(getKiroModelCapabilities({}, 'claude-opus-4.6').nativeThinking).toBe(false);
    });
    test('rawModel 也参与版本判定', () => {
        // codewhispererModel 解析不出但 rawModel 能解析的兜底
        expect(getKiroModelCapabilities({}, 'auto', 'claude-opus-4.7').nativeThinking).toBe(true);
    });
});

describe('getKiroModelCapabilities — config 覆盖', () => {
    test('per-model 显式开启低版本 nativeThinking', () => {
        const config = {
            KIRO_MODEL_CAPABILITIES: {
                'claude-sonnet-4.5': { nativeThinking: true },
            },
        };
        expect(getKiroModelCapabilities(config, 'claude-sonnet-4.5').nativeThinking).toBe(true);
    });
    test('per-model 显式关闭高版本 nativeThinking', () => {
        const config = {
            KIRO_MODEL_CAPABILITIES: {
                'claude-opus-4.7': { nativeThinking: false },
            },
        };
        expect(getKiroModelCapabilities(config, 'claude-opus-4.7').nativeThinking).toBe(false);
    });
    test('per-model 关闭 contextCompression', () => {
        const config = {
            KIRO_MODEL_CAPABILITIES: {
                'claude-opus-4.7': { contextCompression: false },
            },
        };
        const caps = getKiroModelCapabilities(config, 'claude-opus-4.7');
        expect(caps.contextCompression).toBe(false);
        expect(caps.nativeThinking).toBe(true); // 未覆盖项仍走版本默认
    });
    test('default 配置作用于所有未单列模型', () => {
        const config = {
            KIRO_MODEL_CAPABILITIES: {
                default: { contextCompression: false },
            },
        };
        expect(getKiroModelCapabilities(config, 'claude-sonnet-4.5').contextCompression).toBe(false);
        expect(getKiroModelCapabilities(config, 'claude-opus-4.7').contextCompression).toBe(false);
    });
    test('per-model 优先级高于 default', () => {
        const config = {
            KIRO_MODEL_CAPABILITIES: {
                default: { nativeThinking: false },
                'claude-sonnet-4.5': { nativeThinking: true },
            },
        };
        expect(getKiroModelCapabilities(config, 'claude-sonnet-4.5').nativeThinking).toBe(true);
        expect(getKiroModelCapabilities(config, 'claude-opus-4.6').nativeThinking).toBe(false);
    });
});
