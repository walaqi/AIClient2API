/**
 * AWS Event Stream 解析器 (Kiro 上游响应专用)
 *
 * 抽到独立模块的原因:
 *  - 纯函数,无外部依赖,便于单元测试 (无需启动 service / 加载 ESM-only 模块)
 *  - 源代码 (claude-kiro.js) 中 KiroApiService.parseAwsEventStreamBuffer 委托到此处
 *
 * 关键设计: 单一退出点 (P1-2)
 *  - 路径 A: 没有 '{' → return remaining: ''
 *  - 路径 B: JSON 未闭合 → return remaining: 从 jsonStart 起的字节
 *  - 路径 C: searchStart 已消费到末尾 → return remaining: ''
 */

import logger from '../../utils/logger.js';

export function normalizeKiroToolInput(input) {
    if (input === undefined || input === null) return '';
    if (typeof input === 'string') return input;
    if (typeof input === 'object') {
        try { return JSON.stringify(input); } catch (e) { return String(input); }
    }
    return String(input);
}

export function parseAwsEventStreamBuffer(buffer) {
    const events = [];
    const len = buffer.length;
    let searchStart = 0;

    while (searchStart < len) {
        const jsonStart = buffer.indexOf('{', searchStart);
        if (jsonStart < 0) {
            // 单一退出点 A
            return { events, remaining: '' };
        }

        let braceCount = 0;
        let jsonEnd = -1;
        let inString = false;
        let escapeNext = false;

        for (let i = jsonStart; i < len; i++) {
            const char = buffer[i];

            if (escapeNext) { escapeNext = false; continue; }
            if (char === '\\') { escapeNext = true; continue; }
            if (char === '"') { inString = !inString; continue; }

            if (!inString) {
                if (char === '{') {
                    braceCount++;
                } else if (char === '}') {
                    braceCount--;
                    if (braceCount === 0) {
                        jsonEnd = i;
                        break;
                    }
                }
            }
        }

        if (jsonEnd < 0) {
            // 单一退出点 B: 不完整的 JSON, 保留从 jsonStart 起的字节
            return { events, remaining: buffer.substring(jsonStart) };
        }

        const jsonStr = buffer.substring(jsonStart, jsonEnd + 1);
        let parseSuccess = false;
        try {
            const parsed = JSON.parse(jsonStr);
            parseSuccess = true;

            if (parsed.content !== undefined && !parsed.followupPrompt) {
                events.push({ type: 'content', data: parsed.content });
            } else if (typeof parsed.text === 'string' && !parsed.name && !parsed.toolUseId && parsed.content === undefined) {
                events.push({ type: 'reasoning', data: parsed.text });
            } else if (parsed.name && parsed.toolUseId) {
                events.push({
                    type: 'toolUse',
                    data: {
                        name: parsed.name,
                        toolUseId: parsed.toolUseId,
                        input: normalizeKiroToolInput(parsed.input),
                        stop: parsed.stop || false
                    }
                });
            } else if (parsed.input !== undefined && !parsed.name) {
                events.push({
                    type: 'toolUseInput',
                    data: {
                        toolUseId: parsed.toolUseId,
                        input: normalizeKiroToolInput(parsed.input)
                    }
                });
            } else if (parsed.stop !== undefined && parsed.contextUsagePercentage === undefined) {
                events.push({
                    type: 'toolUseStop',
                    data: { stop: parsed.stop }
                });
            } else if (parsed.contextUsagePercentage !== undefined) {
                events.push({
                    type: 'contextUsage',
                    data: { contextUsagePercentage: parsed.contextUsagePercentage }
                });
            } else if (parsed.unit !== undefined && parsed.usage !== undefined) {
                events.push({
                    type: 'metering',
                    data: { unit: parsed.unit, usage: parsed.usage }
                });
            } else {
                logger?.debug?.('[Kiro Parse] Unrecognized event JSON:', JSON.stringify(parsed).substring(0, 500));
            }
        } catch (e) {
            // 解析失败: 跳过这个 '{' 从下一字符继续搜索
        }

        searchStart = parseSuccess ? jsonEnd + 1 : jsonStart + 1;
    }

    // 单一退出点 C
    return { events, remaining: '' };
}
