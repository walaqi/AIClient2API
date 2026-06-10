import { API_ACTIONS, MODEL_PROTOCOL_PREFIX } from '../../utils/common.js';
import logger from '../../utils/logger.js';
import { ProviderStrategy } from '../../utils/provider-strategy.js';
import { applySystemPromptReplacements, applyReplacementsToClientSystem, applyReplacementsToToolDescriptions } from '../../converters/utils.js';

/**
 * Grok provider strategy implementation.
 */
class GrokStrategy extends ProviderStrategy {
    extractModelAndStreamInfo(req, requestBody) {
        // Grok protocol usually used internally, but if exposed:
        const model = requestBody.model || 'grok-3';
        const isStream = requestBody.stream !== false;
        return { model, isStream };
    }

    extractResponseText(response) {
        // From Grok response
        return response.message || '';
    }

    extractPromptText(requestBody) {
        // From converted Grok request
        return requestBody.message || '';
    }

    async applySystemPromptFromFile(config, requestBody) {
        // Step 1: 无条件对客户端原始 system prompt 应用替换规则。
        // Grok 协议没有独立 system 字段（system 已经被合并进 message），故此步实际为 no-op，
        // 但保留调用以保持各 strategy 接口一致。
        applyReplacementsToClientSystem(requestBody, config.SYSTEM_PROMPT_REPLACEMENTS, MODEL_PROTOCOL_PREFIX.GROK);
        applyReplacementsToToolDescriptions(requestBody, config.TOOL_DESCRIPTION_REPLACEMENTS);

        // Step 2: 走文件注入逻辑（仅在 SYSTEM_PROMPT_FILE_PATH/CONTENT 满足时生效）。
        if (!config.SYSTEM_PROMPT_FILE_PATH) {
            return requestBody;
        }

        const filePromptContent = config.SYSTEM_PROMPT_CONTENT;
        if (filePromptContent === null) {
            return requestBody;
        }

        // Grok web interface combines system prompt into message
        // Here we can prepend it if needed, or handle it during request conversion.
        // Since requestBody already contains the converted message, we might need to prepend it here.
        
        // Apply system prompt replacements to file prompt content
        const finalFilePrompt = applySystemPromptReplacements(filePromptContent, config.SYSTEM_PROMPT_REPLACEMENTS);

        const existingMessage = requestBody.message || "";
        const newSystemText = config.SYSTEM_PROMPT_MODE === 'append'
            ? `${existingMessage}\n\nSystem: ${finalFilePrompt}`
            : config.SYSTEM_PROMPT_MODE === 'head'
                ? `System: ${finalFilePrompt}\n\n${existingMessage}`
                : `System: ${finalFilePrompt}\n\n${existingMessage}`;

        requestBody.message = newSystemText;
        logger.info(`[System Prompt] Applied system prompt for Grok in '${config.SYSTEM_PROMPT_MODE}' mode.`);
        // TODO: set requestBody._injectedSystemTokens for count_tokens alignment — see claude-strategy.js for reference

        return requestBody;
    }

    async manageSystemPrompt(requestBody) {
        // Not implemented for Grok yet
    }
}

export { GrokStrategy };
