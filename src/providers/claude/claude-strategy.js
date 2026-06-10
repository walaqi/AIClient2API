import { ProviderStrategy } from '../../utils/provider-strategy.js';
import logger from '../../utils/logger.js';
import { extractSystemPromptFromRequestBody, MODEL_PROTOCOL_PREFIX } from '../../utils/common.js';
import { applySystemPromptReplacements, applyReplacementsToClientSystem, applyReplacementsToToolDescriptions } from '../../converters/utils.js';
import { countTextTokens } from '../../utils/token-utils.js';

/**
 * Claude provider strategy implementation.
 */
class ClaudeStrategy extends ProviderStrategy {
    extractModelAndStreamInfo(req, requestBody) {
        const model = requestBody.model;
        const isStream = requestBody.stream === true;
        return { model, isStream };
    }

    extractResponseText(response) {
        if (response.type === 'content_block_delta' && response.delta ) {
            if(response.delta.type === 'text_delta' ){
                return response.delta.text;
            }
            if(response.delta.type === 'input_json_delta' ){
                return response.delta.partial_json;
            }
        }
        if (response.content && Array.isArray(response.content)) {
            return response.content
                .filter(block => block.type === 'text' && block.text)
                .map(block => block.text)
                .join('');
        } else if (response.content && response.content.type === 'text') {
            return response.content.text;
        }
        return '';
    }

    extractPromptText(requestBody) {
        if (requestBody.messages && requestBody.messages.length > 0) {
            const lastMessage = requestBody.messages[requestBody.messages.length - 1];
            if (lastMessage.content && Array.isArray(lastMessage.content)) {
                return lastMessage.content.map(block => block.text).join('');
            }
            return lastMessage.content;
        }
        return '';
    }

    async applySystemPromptFromFile(config, requestBody) {
        // Step 1: 无条件对客户端原始 system prompt 应用替换规则（与文件注入解耦）。
        applyReplacementsToClientSystem(requestBody, config.SYSTEM_PROMPT_REPLACEMENTS, MODEL_PROTOCOL_PREFIX.CLAUDE);
        applyReplacementsToToolDescriptions(requestBody, config.TOOL_DESCRIPTION_REPLACEMENTS);

        // Step 2: 走文件注入逻辑（仅在 SYSTEM_PROMPT_FILE_PATH/CONTENT 满足时生效）。
        if (!config.SYSTEM_PROMPT_FILE_PATH) {
            return requestBody;
        }

        const filePromptContent = config.SYSTEM_PROMPT_CONTENT;
        if (filePromptContent === null) {
            return requestBody;
        }

        const finalText = applySystemPromptReplacements(filePromptContent, config.SYSTEM_PROMPT_REPLACEMENTS);
        const injectedBlock = { type: 'text', text: finalText };

        const existing = requestBody.system;
        const mode = config.SYSTEM_PROMPT_MODE;

        if (Array.isArray(existing) && existing.length > 0) {
            // Preserve the array structure (cache_control, etc.)
            if (mode === 'append') {
                requestBody.system = [...existing, injectedBlock];
            } else if (mode === 'head') {
                requestBody.system = [injectedBlock, ...existing];
            } else {
                // overwrite / replace
                requestBody.system = [injectedBlock];
            }
        } else if (typeof existing === 'string' && existing) {
            const existingBlock = { type: 'text', text: existing };
            if (mode === 'append') {
                requestBody.system = [existingBlock, injectedBlock];
            } else if (mode === 'head') {
                requestBody.system = [injectedBlock, existingBlock];
            } else {
                requestBody.system = [injectedBlock];
            }
        } else {
            requestBody.system = [injectedBlock];
        }

        // Record injected token delta so estimateInputTokens can subtract it back,
        // keeping localInputTokens aligned with the count_tokens interface (pre-injection view).
        // overwrite mode: net delta = 0 (injected replaces original, no extra from client's perspective).
        // append/head mode: net delta = tokens of the injected text.
        if (mode === 'append' || mode === 'head') {
            requestBody._injectedSystemTokens = countTextTokens(finalText);
        }

        // Ensure system field appears before messages in the serialized object.
        if ('messages' in requestBody && Object.keys(requestBody).indexOf('system') > Object.keys(requestBody).indexOf('messages')) {
            const { system, messages, ...rest } = requestBody;
            // Clear all keys then re-insert in desired order: system before messages.
            for (const key of Object.keys(requestBody)) delete requestBody[key];
            if (system !== undefined) requestBody.system = system;
            requestBody.messages = messages;
            Object.assign(requestBody, rest);
        }

        logger.info(`[System Prompt] Applied system prompt from ${config.SYSTEM_PROMPT_FILE_PATH} in '${mode}' mode for provider 'claude'.`);
        return requestBody;
    }

    async manageSystemPrompt(requestBody) {
        // Extract plain text from system field (array or string) without falling back to user messages.
        let incomingSystemText = '';
        if (Array.isArray(requestBody.system)) {
            incomingSystemText = requestBody.system
                .filter(b => b?.type === 'text' && b.text)
                .map(b => b.text)
                .join('\n');
        } else {
            incomingSystemText = extractSystemPromptFromRequestBody(requestBody, MODEL_PROTOCOL_PREFIX.CLAUDE);
        }
        await this._updateSystemPromptFile(incomingSystemText, MODEL_PROTOCOL_PREFIX.CLAUDE);
    }
}

export { ClaudeStrategy };

