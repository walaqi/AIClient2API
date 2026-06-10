import { API_ACTIONS, extractSystemPromptFromRequestBody, MODEL_PROTOCOL_PREFIX } from '../../utils/common.js';
import logger from '../../utils/logger.js';
import { ProviderStrategy } from '../../utils/provider-strategy.js';
import { applySystemPromptReplacements, applyReplacementsToClientSystem, applyReplacementsToToolDescriptions } from '../../converters/utils.js';

/**
 * Gemini provider strategy implementation.
 */
class GeminiStrategy extends ProviderStrategy {
    extractModelAndStreamInfo(req, requestBody) {
        const requestUrl = new URL(req.url, `http://${req.headers.host}`);
        const urlPattern = new RegExp(`/v1beta/models/(.+?):(${API_ACTIONS.GENERATE_CONTENT}|${API_ACTIONS.STREAM_GENERATE_CONTENT})`);
        const urlMatch = requestUrl.pathname.match(urlPattern);
        const [, urlmodel, action] = urlMatch;
        const model = urlmodel;
        const isStream = action === API_ACTIONS.STREAM_GENERATE_CONTENT;
        return { model, isStream };
    }

    extractResponseText(response) {
        if (response.candidates && response.candidates.length > 0) {
            const candidate = response.candidates[0];
            if (candidate.content && candidate.content.parts && candidate.content.parts.length > 0) {
                return candidate.content.parts.map(part => part.text).join('');
            }
        }
        return '';
    }

    extractPromptText(requestBody) {
        if (requestBody.contents && requestBody.contents.length > 0) {
            const lastContent = requestBody.contents[requestBody.contents.length - 1];
            if (lastContent.parts && lastContent.parts.length > 0) {
                return lastContent.parts.map(part => part.text).join('');
            }
        }
        return '';
    }

    async applySystemPromptFromFile(config, requestBody) {
        // Step 1: 无条件对客户端原始 system prompt 应用替换规则（与文件注入解耦）。
        applyReplacementsToClientSystem(requestBody, config.SYSTEM_PROMPT_REPLACEMENTS, MODEL_PROTOCOL_PREFIX.GEMINI);
        applyReplacementsToToolDescriptions(requestBody, config.TOOL_DESCRIPTION_REPLACEMENTS);

        // Step 2: 走文件注入逻辑（仅在 SYSTEM_PROMPT_FILE_PATH/CONTENT 满足时生效）。
        if (!config.SYSTEM_PROMPT_FILE_PATH) {
            return requestBody;
        }

        const filePromptContent = config.SYSTEM_PROMPT_CONTENT;
        if (filePromptContent === null) {
            return requestBody;
        }

        const systemInstruction = requestBody.system_instruction || requestBody.systemInstruction;
        const existingSystemText = systemInstruction?.parts
            ? systemInstruction.parts.filter(p => p?.text).map(p => p.text).join('\n')
            : '';

        const newSystemText = config.SYSTEM_PROMPT_MODE === 'append' && existingSystemText
            ? `${existingSystemText}\n${filePromptContent}`
            : config.SYSTEM_PROMPT_MODE === 'head' && existingSystemText
                ? `${filePromptContent}\n${existingSystemText}`
                : filePromptContent;

        // Apply system prompt replacements
        const finalSystemText = applySystemPromptReplacements(newSystemText, config.SYSTEM_PROMPT_REPLACEMENTS);

        requestBody.systemInstruction = { parts: [{ text: finalSystemText }] };
        if (requestBody.system_instruction) {
            delete requestBody.system_instruction;
        }
        logger.info(`[System Prompt] Applied system prompt from ${config.SYSTEM_PROMPT_FILE_PATH} in '${config.SYSTEM_PROMPT_MODE}' mode for provider 'gemini'.`);
        // TODO: set requestBody._injectedSystemTokens for count_tokens alignment — see claude-strategy.js for reference

        return requestBody;
    }

    async manageSystemPrompt(requestBody) {
        const incomingSystemText = extractSystemPromptFromRequestBody(requestBody, MODEL_PROTOCOL_PREFIX.GEMINI);
        await this._updateSystemPromptFile(incomingSystemText, MODEL_PROTOCOL_PREFIX.GEMINI);
    }
}

export { GeminiStrategy };

