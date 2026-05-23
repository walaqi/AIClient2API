import { isIncompleteFileToolCall } from '../../src/providers/claude/kiro-tool-validators.js';

describe('isIncompleteFileToolCall', () => {
    const cases = [
        {
            label: '#1 Write missing content -> incomplete',
            toolName: 'Write',
            input: { file_path: 'x' },
            expected: true,
        },
        {
            label: '#2 Write empty content string -> incomplete',
            toolName: 'Write',
            input: { file_path: 'x', content: '' },
            expected: true,
        },
        {
            label: '#3 Write Anthropic-style complete -> ok',
            toolName: 'Write',
            input: { file_path: 'x', content: 'hi' },
            expected: false,
        },
        {
            label: '#4 Write Kiro-style keys (path/text) -> ok (defect 2b)',
            toolName: 'Write',
            input: { path: 'x', text: 'hi' },
            expected: false,
        },
        {
            label: '#5 Edit with new_string="" deletion -> ok (defect 2a fixed)',
            toolName: 'Edit',
            input: { file_path: 'x', old_string: 'a', new_string: '' },
            expected: false,
        },
        {
            label: '#6 Edit missing old_string -> incomplete',
            toolName: 'Edit',
            input: { file_path: 'x' },
            expected: true,
        },
        {
            label: '#7 Bash unrelated tool -> ok',
            toolName: 'Bash',
            input: { command: 'ls' },
            expected: false,
        },
    ];

    test.each(cases)('$label', ({ toolName, input, expected }) => {
        expect(isIncompleteFileToolCall(toolName, input)).toBe(expected);
    });

    test('#8a non-object input (null) -> ok', () => {
        expect(isIncompleteFileToolCall('Write', null)).toBe(false);
    });

    test('#8b non-object input (undefined) -> ok', () => {
        expect(isIncompleteFileToolCall('Write', undefined)).toBe(false);
    });
});
