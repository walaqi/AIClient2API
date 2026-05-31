import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
    loadDetectedModelsFromDisk,
    getDetectedModelsForProvider,
    saveDetectedModels
} from '../src/providers/detected-models-store.js';
import { CONFIG } from '../src/core/config-manager.js';
import { getProviderModels } from '../src/providers/provider-models.js';

describe('detected-models-store', () => {
    let tempDir;
    let filePath;
    let currentConfig;

    beforeEach(() => {
        tempDir = mkdtempSync(join(tmpdir(), 'detected-models-'));
        filePath = join(tempDir, 'detected_models.json');
        currentConfig = {
            DETECTED_MODELS_FILE_PATH: filePath,
            detectedModels: {}
        };
        CONFIG.detectedModels = {};
    });

    afterEach(() => {
        rmSync(tempDir, { recursive: true, force: true });
        CONFIG.detectedModels = {};
    });

    describe('loadDetectedModelsFromDisk', () => {
        test('returns {} when file missing', () => {
            expect(loadDetectedModelsFromDisk(filePath)).toEqual({});
        });

        test('parses and normalizes provider→models map', () => {
            writeFileSync(filePath, JSON.stringify({
                'claude-kiro-oauth': ['auto', '  claude-opus-4.8  ', '', 123],
                'bad-value': 'not-an-array'
            }));
            const loaded = loadDetectedModelsFromDisk(filePath);
            expect(loaded['claude-kiro-oauth']).toEqual(['auto', 'claude-opus-4.8']);
            expect(loaded['bad-value']).toBeUndefined();
        });

        test('returns {} on malformed JSON', () => {
            writeFileSync(filePath, '{ not json');
            expect(loadDetectedModelsFromDisk(filePath)).toEqual({});
        });

        test('returns {} when top-level is an array', () => {
            writeFileSync(filePath, JSON.stringify(['a', 'b']));
            expect(loadDetectedModelsFromDisk(filePath)).toEqual({});
        });
    });

    describe('getDetectedModelsForProvider', () => {
        test('exact match', () => {
            const map = { 'claude-kiro-oauth': ['auto', 'claude-opus-4.8'] };
            expect(getDetectedModelsForProvider('claude-kiro-oauth', map)).toEqual(['auto', 'claude-opus-4.8']);
        });

        test('prefix match (suffixed provider type)', () => {
            const map = { 'openai-custom': ['gpt-5'] };
            expect(getDetectedModelsForProvider('openai-custom-1', map)).toEqual(['gpt-5']);
        });

        test('returns null on miss', () => {
            expect(getDetectedModelsForProvider('grok-web', { 'claude-kiro-oauth': ['x'] })).toBeNull();
        });

        test('returns null when map empty/undefined', () => {
            expect(getDetectedModelsForProvider('x', null)).toBeNull();
            expect(getDetectedModelsForProvider('x', {})).toBeNull();
        });
    });

    describe('saveDetectedModels', () => {
        test('writes new provider list and syncs CONFIG', async () => {
            const result = await saveDetectedModels(currentConfig, 'claude-kiro-oauth', [
                'auto', 'claude-opus-4.8', 'deepseek-3.2'
            ]);

            expect(result.changed).toBe(true);
            expect(result.models).toEqual(['auto', 'claude-opus-4.8', 'deepseek-3.2']);

            const saved = JSON.parse(readFileSync(filePath, 'utf-8'));
            expect(saved['claude-kiro-oauth']).toEqual(['auto', 'claude-opus-4.8', 'deepseek-3.2']);

            // 同步运行时
            expect(CONFIG.detectedModels['claude-kiro-oauth']).toEqual(['auto', 'claude-opus-4.8', 'deepseek-3.2']);
            expect(currentConfig.detectedModels['claude-kiro-oauth']).toEqual(['auto', 'claude-opus-4.8', 'deepseek-3.2']);
        });

        test('dedupes and trims input', async () => {
            const result = await saveDetectedModels(currentConfig, 'openai-codex-oauth', [
                'gpt-5', 'gpt-5', '  gpt-image-2  ', '', '   '
            ]);
            expect(result.models).toEqual(['gpt-5', 'gpt-image-2']);
        });

        test('overwrites previous list for same provider (authoritative)', async () => {
            await saveDetectedModels(currentConfig, 'claude-kiro-oauth', ['old-1', 'old-2', 'old-3']);
            const result = await saveDetectedModels(currentConfig, 'claude-kiro-oauth', ['new-1', 'new-2']);

            expect(result.models).toEqual(['new-1', 'new-2']);
            const saved = JSON.parse(readFileSync(filePath, 'utf-8'));
            expect(saved['claude-kiro-oauth']).toEqual(['new-1', 'new-2']);
        });

        test('changed=false when list identical', async () => {
            await saveDetectedModels(currentConfig, 'grok-web', ['grok-4', 'grok-3']);
            const result = await saveDetectedModels(currentConfig, 'grok-web', ['grok-4', 'grok-3']);
            expect(result.changed).toBe(false);
        });

        test('multiple providers coexist in same file', async () => {
            await saveDetectedModels(currentConfig, 'claude-kiro-oauth', ['k1']);
            await saveDetectedModels(currentConfig, 'openai-codex-oauth', ['c1']);

            const saved = JSON.parse(readFileSync(filePath, 'utf-8'));
            expect(Object.keys(saved).sort()).toEqual(['claude-kiro-oauth', 'openai-codex-oauth']);
            expect(saved['claude-kiro-oauth']).toEqual(['k1']);
            expect(saved['openai-codex-oauth']).toEqual(['c1']);
        });
    });

    describe('getProviderModels priority (detected cache > hardcoded)', () => {
        const savedCustomModels = CONFIG.customModels;

        afterEach(() => {
            CONFIG.customModels = savedCustomModels;
            CONFIG.detectedModels = {};
        });

        test('falls back to hardcoded list when no detected cache', () => {
            CONFIG.detectedModels = {};
            const models = getProviderModels('claude-kiro-oauth');
            // 硬编码清单非空
            expect(models.length).toBeGreaterThan(0);
        });

        test('detected cache overrides hardcoded list', () => {
            CONFIG.detectedModels = {
                'claude-kiro-oauth': ['auto', 'claude-opus-4.8', 'qwen3-coder-next']
            };
            const models = getProviderModels('claude-kiro-oauth');
            expect(models).toContain('auto');
            expect(models).toContain('claude-opus-4.8');
            expect(models).toContain('qwen3-coder-next');
        });

        test('custom models still injected on top of detected cache', () => {
            CONFIG.detectedModels = { 'claude-kiro-oauth': ['auto'] };
            CONFIG.customModels = [{
                id: 'claude-haiku-4-5-20251001',
                provider: 'claude-kiro-oauth',
                actualProvider: 'claude-kiro-oauth',
                actualModel: 'claude-haiku-4-5'
            }];
            const models = getProviderModels('claude-kiro-oauth');
            expect(models).toContain('auto');
            expect(models).toContain('claude-haiku-4-5-20251001');
        });
    });
});
