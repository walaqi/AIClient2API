import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { persistDetectedModels } from '../src/ui-modules/custom-models-api.js';

describe('persistDetectedModels', () => {
    let tempDir;
    let filePath;
    let currentConfig;

    beforeEach(() => {
        tempDir = mkdtempSync(join(tmpdir(), 'persist-models-'));
        filePath = join(tempDir, 'custom_models.json');
        currentConfig = {
            CUSTOM_MODELS_FILE_PATH: filePath,
            customModels: []
        };
    });

    afterEach(() => {
        rmSync(tempDir, { recursive: true, force: true });
    });

    test('writes new models when file missing', async () => {
        const result = await persistDetectedModels(currentConfig, 'claude-kiro-oauth', [
            'claude-opus-4.8',
            'deepseek-3.2'
        ]);

        expect(result.added).toHaveLength(2);
        expect(result.skipped).toEqual([]);

        const saved = JSON.parse(readFileSync(filePath, 'utf-8'));
        expect(saved).toHaveLength(2);
        expect(saved[0]).toMatchObject({
            id: 'claude-opus-4.8',
            provider: 'claude-kiro-oauth',
            actualProvider: 'claude-kiro-oauth',
            actualModel: 'claude-opus-4.8'
        });
        expect(saved[0].description).toContain('detect-models');

        // sync 到运行时
        expect(currentConfig.customModels).toHaveLength(2);
    });

    test('preserves existing entries with same provider+id (no overwrite)', async () => {
        // 用户手动调过 contextLength 的现有项
        const existing = [{
            id: 'claude-haiku-4-5-20251001',
            name: 'claude-code to kiro',
            alias: 'claude-haiku-4-5-20251001',
            provider: 'claude-kiro-oauth',
            actualProvider: 'claude-kiro-oauth',
            actualModel: 'claude-haiku-4-5',
            contextLength: 81920,
            maxTokens: 20000,
            description: '用户手动配置, 不应被覆盖'
        }];
        writeFileSync(filePath, JSON.stringify(existing, null, 2));

        const result = await persistDetectedModels(currentConfig, 'claude-kiro-oauth', [
            'claude-haiku-4-5-20251001',  // 重复
            'claude-opus-4.8'              // 新
        ]);

        expect(result.added).toHaveLength(1);
        expect(result.added[0].id).toBe('claude-opus-4.8');
        expect(result.skipped).toEqual(['claude-haiku-4-5-20251001']);

        const saved = JSON.parse(readFileSync(filePath, 'utf-8'));
        expect(saved).toHaveLength(2);

        // 现有项原封不动
        const preserved = saved.find(m => m.id === 'claude-haiku-4-5-20251001');
        expect(preserved.contextLength).toBe(81920);
        expect(preserved.actualModel).toBe('claude-haiku-4-5');
        expect(preserved.description).toBe('用户手动配置, 不应被覆盖');
    });

    test('does not write file when nothing new', async () => {
        const existing = [{
            id: 'claude-opus-4.6',
            provider: 'claude-kiro-oauth',
            actualProvider: 'claude-kiro-oauth'
        }];
        writeFileSync(filePath, JSON.stringify(existing, null, 2));
        const before = readFileSync(filePath, 'utf-8');

        const result = await persistDetectedModels(currentConfig, 'claude-kiro-oauth', [
            'claude-opus-4.6'
        ]);

        expect(result.added).toEqual([]);
        expect(result.skipped).toEqual(['claude-opus-4.6']);

        // 文件未变（注意：可能因 atomicWriteFile 不调用而保持不变）
        const after = readFileSync(filePath, 'utf-8');
        expect(after).toBe(before);
    });

    test('dedupes input list', async () => {
        const result = await persistDetectedModels(currentConfig, 'openai-codex-oauth', [
            'gpt-5.5',
            'gpt-5.5',
            'gpt-image-2',
            '   ',
            ''
        ]);

        expect(result.added).toHaveLength(2);
        expect(result.added.map(m => m.id).sort()).toEqual(['gpt-5.5', 'gpt-image-2']);
    });

    test('different providers can have same modelId', async () => {
        await persistDetectedModels(currentConfig, 'claude-kiro-oauth', ['some-model']);
        const result = await persistDetectedModels(currentConfig, 'openai-codex-oauth', ['some-model']);

        expect(result.added).toHaveLength(1);
        expect(result.added[0].provider).toBe('openai-codex-oauth');

        const saved = JSON.parse(readFileSync(filePath, 'utf-8'));
        expect(saved.filter(m => m.id === 'some-model')).toHaveLength(2);
    });
});
