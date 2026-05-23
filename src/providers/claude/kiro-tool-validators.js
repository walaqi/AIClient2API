function hasAny(obj, keys) { return keys.some(k => obj && obj[k] != null); }
function hasNonEmpty(obj, keys) {
    return keys.some(k => {
        const v = obj && obj[k];
        return typeof v === 'string' ? v.length > 0 : v != null;
    });
}

export function isIncompleteFileToolCall(toolName, parsedInput) {
    if (!parsedInput || typeof parsedInput !== 'object') return false;
    const lower = (toolName || '').toLowerCase();
    const hasPath = hasAny(parsedInput, ['file_path', 'path']);

    if (lower === 'write') {
        return hasPath && !hasNonEmpty(parsedInput, ['content', 'text']);
    }
    if (lower === 'edit') {
        return hasPath && !hasAny(parsedInput, ['old_string', 'oldStr']);
    }
    return false;
}
