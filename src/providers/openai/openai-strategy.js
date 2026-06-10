import { ProviderStrategy } from '../../utils/provider-strategy.js';
import logger from '../../utils/logger.js';
import { extractSystemPromptFromRequestBody, MODEL_PROTOCOL_PREFIX } from '../../utils/common.js';
import { applySystemPromptReplacements, applyReplacementsToClientSystem, applyReplacementsToToolDescriptions } from '../../converters/utils.js';

/**
 * OpenAI provider strategy implementation.
 */
class OpenAIStrategy extends ProviderStrategy {
    extractModelAndStreamInfo(req, requestBody) {
        const model = requestBody.model;
        const isStream = requestBody.stream === true;
        return { model, isStream };
    }

    extractResponseText(response) {
        if (!response.choices) {
            return '';
        }
        if (response.choices && response.choices.length > 0) {
            const choice = response.choices[0];
            if (choice.message && choice.message.content) {
                return choice.message.content;
            } else if (choice.delta && choice.delta.content) {
                return choice.delta.content;
            } else if (choice.delta && choice.delta.tool_calls && choice.delta.tool_calls.length > 0) {
                return choice.delta.tool_calls;
            }
        }
        return '';
    }

    extractPromptText(requestBody) {
        if (requestBody.messages && requestBody.messages.length > 0) {
            const lastMessage = requestBody.messages[requestBody.messages.length - 1];
            let content = lastMessage.content;
            if (typeof content === 'object' && content !== null) {
                if (Array.isArray(content)) {
                    return content.map(item => item.text).join('\n');
                } else {
                    return JSON.stringify(content);
                }
            }
            return content;
        }
        return '';
    }

    async applySystemPromptFromFile(config, requestBody) {
        // Step 1: 无条件对客户端原始 system prompt 应用替换规则（与文件注入解耦）。
        applyReplacementsToClientSystem(requestBody, config.SYSTEM_PROMPT_REPLACEMENTS, MODEL_PROTOCOL_PREFIX.OPENAI);
        applyReplacementsToToolDescriptions(requestBody, config.TOOL_DESCRIPTION_REPLACEMENTS);

        // Step 2: 走文件注入逻辑（仅在 SYSTEM_PROMPT_FILE_PATH/CONTENT 满足时生效）。
        if (!config.SYSTEM_PROMPT_FILE_PATH) {
            return requestBody;
        }

        const filePromptContent = config.SYSTEM_PROMPT_CONTENT;
        if (filePromptContent === null) {
            return requestBody;
        }

        const systemMsg = requestBody.messages?.find(m => m.role === 'system' || m.role === 'developer');
        let existingSystemText = systemMsg?.content || '';
        if (typeof existingSystemText === 'object' && existingSystemText !== null) {
            existingSystemText = Array.isArray(existingSystemText)
                ? existingSystemText.map(item => (typeof item === 'string' ? item : item.text || JSON.stringify(item))).join('\n')
                : JSON.stringify(existingSystemText);
        }

        const newSystemText = config.SYSTEM_PROMPT_MODE === 'append' && existingSystemText
            ? `${existingSystemText}\n${filePromptContent}`
            : config.SYSTEM_PROMPT_MODE === 'head' && existingSystemText
                ? `${filePromptContent}\n${existingSystemText}`
                : filePromptContent;

        // Apply system prompt replacements
        const finalSystemText = applySystemPromptReplacements(newSystemText, config.SYSTEM_PROMPT_REPLACEMENTS);

        if (!requestBody.messages) {
            requestBody.messages = [];
        }
        const systemMessageIndex = requestBody.messages.findIndex(m => m.role === 'system' || m.role === 'developer');
        if (systemMessageIndex !== -1) {
            requestBody.messages[systemMessageIndex].content = finalSystemText;
        } else {
            requestBody.messages.unshift({ role: 'system', content: finalSystemText });
        }
        logger.info(`[System Prompt] Applied system prompt from ${config.SYSTEM_PROMPT_FILE_PATH} in '${config.SYSTEM_PROMPT_MODE}' mode for provider 'openai'.`);
        // TODO: set requestBody._injectedSystemTokens for count_tokens alignment — see claude-strategy.js for reference

        return requestBody;
    }

    async manageSystemPrompt(requestBody) {
        //logger.info('[System Prompt] Managing system prompt for provider "openai".', requestBody);
        const incomingSystemText = extractSystemPromptFromRequestBody(requestBody, MODEL_PROTOCOL_PREFIX.OPENAI);
        await this._updateSystemPromptFile(incomingSystemText, MODEL_PROTOCOL_PREFIX.OPENAI);
    }
}

export { OpenAIStrategy };

