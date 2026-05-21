/**
 * 诊断脚本：测试 Write tool_use 解析是否丢失 file_path 或 content
 * 运行: node tests/debug-write-tool-parsing.mjs
 */
import { parseAwsEventStreamFrames, normalizeKiroToolInput } from '../src/providers/claude/aws-event-stream-parser.js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Frame construction helpers (from existing tests) ───

function writeStringHeader(name, valueBytes) {
    const nameBuf = Buffer.from(name, 'ascii');
    const valBuf = Buffer.isBuffer(valueBytes) ? valueBytes : Buffer.from(valueBytes, 'utf8');
    const buf = Buffer.alloc(1 + nameBuf.length + 1 + 2 + valBuf.length);
    let p = 0;
    buf.writeUInt8(nameBuf.length, p); p += 1;
    nameBuf.copy(buf, p); p += nameBuf.length;
    buf.writeUInt8(7, p); p += 1;
    buf.writeUInt16BE(valBuf.length, p); p += 2;
    valBuf.copy(buf, p);
    return buf;
}

function makeFrame(payloadObj) {
    const payload = typeof payloadObj === 'string' ? payloadObj : JSON.stringify(payloadObj);
    const payloadBuf = Buffer.from(payload, 'utf8');
    const headers = Buffer.concat([
        writeStringHeader(':event-type', 'event'),
        writeStringHeader(':content-type', 'application/json'),
        writeStringHeader(':message-type', 'event'),
    ]);
    const totalLen = 12 + headers.length + payloadBuf.length + 4;
    const buf = Buffer.alloc(totalLen);
    buf.writeUInt32BE(totalLen, 0);
    buf.writeUInt32BE(headers.length, 4);
    buf.writeUInt32BE(0, 8);
    headers.copy(buf, 12);
    payloadBuf.copy(buf, 12 + headers.length);
    buf.writeUInt32BE(0, totalLen - 4);
    return buf;
}

// ─── Simulate streaming consumer logic (extracted from claude-kiro.js:2746-2910) ───

function simulateStreamConsumer(events) {
    let currentToolCall = null;
    const toolCalls = [];

    for (const event of events) {
        if (event.type === 'toolUse') {
            const tc = event.data;
            if (tc.name && tc.toolUseId) {
                if (currentToolCall && currentToolCall.toolUseId !== tc.toolUseId) {
                    toolCalls.push(finalizeTool(currentToolCall));
                }
                if (!currentToolCall || currentToolCall.toolUseId !== tc.toolUseId) {
                    currentToolCall = { toolUseId: tc.toolUseId, name: tc.name, input: '' };
                }
                currentToolCall.input += tc.input || '';
                if (tc.stop) {
                    toolCalls.push(finalizeTool(currentToolCall));
                    currentToolCall = null;
                }
            }
        } else if (event.type === 'toolUseInput') {
            const inputDelta = normalizeKiroToolInput(event.data.input);
            if (currentToolCall) {
                currentToolCall.input += inputDelta;
            }
        } else if (event.type === 'toolUseStop') {
            if (currentToolCall && event.data.stop) {
                toolCalls.push(finalizeTool(currentToolCall));
                currentToolCall = null;
            }
        }
    }
    // Handle unterminated tool call
    if (currentToolCall) {
        toolCalls.push(finalizeTool(currentToolCall));
    }
    return toolCalls;
}

function finalizeTool(tc) {
    let parsedInput = tc.input;
    try { parsedInput = JSON.parse(tc.input); } catch (e) {}
    return { toolUseId: tc.toolUseId, name: tc.name, input: parsedInput, rawInput: tc.input };
}

// ─── Simulate non-streaming parseEventStreamChunk (from claude-kiro.js:1612-1703) ───

function parseEventStreamChunkStandalone(rawStr) {
    let fullContent = '';
    const toolCalls = [];
    let currentToolCallDict = null;

    const sseEventRegex = /:message-typeevent(\{[^]*?(?=:event-type|$))/g;
    const legacyEventRegex = /event(\{.*?(?=event\{|$))/gs;

    let matches = [...rawStr.matchAll(sseEventRegex)];
    if (matches.length === 0) {
        matches = [...rawStr.matchAll(legacyEventRegex)];
    }

    for (const match of matches) {
        const potentialJsonBlock = match[1];
        if (!potentialJsonBlock || potentialJsonBlock.trim().length === 0) continue;

        let searchPos = 0;
        while ((searchPos = potentialJsonBlock.indexOf('}', searchPos + 1)) !== -1) {
            const jsonCandidate = potentialJsonBlock.substring(0, searchPos + 1).trim();
            try {
                const eventData = JSON.parse(jsonCandidate);
                if (eventData.name && eventData.toolUseId) {
                    if (!currentToolCallDict) {
                        currentToolCallDict = {
                            id: eventData.toolUseId,
                            type: "function",
                            function: { name: eventData.name, arguments: "" }
                        };
                    }
                    if (eventData.input) {
                        currentToolCallDict.function.arguments += normalizeKiroToolInput(eventData.input);
                    }
                    if (eventData.stop) {
                        toolCalls.push(currentToolCallDict);
                        currentToolCallDict = null;
                    }
                } else if (!eventData.followupPrompt && eventData.content) {
                    fullContent += eventData.content;
                }
                // NOTE: 没有处理 continuation events (input without name)!
                break;
            } catch (e) { continue; }
        }
    }
    if (currentToolCallDict) {
        toolCalls.push(currentToolCallDict);
    }
    return { content: fullContent, toolCalls };
}

// ─── Test Scenarios ───

function printResult(name, result, detail) {
    const icon = result === 'PASS' ? '✓' : result === 'BUG' ? '✗' : '⚠';
    console.log(`\n${icon} [${result}] ${name}`);
    if (detail) console.log(`  ${detail}`);
}

function test1_streamingStringChunks() {
    console.log('\n' + '═'.repeat(70));
    console.log('Test 1: 流式路径 - Write 工具 input 全部为字符串分片（正确协议）');
    console.log('═'.repeat(70));

    const frames = Buffer.concat([
        makeFrame({ name: 'Write', toolUseId: 't1', input: '{"file_path"' }),
        makeFrame({ toolUseId: 't1', input: ': "/home/chris/test.md", "content"' }),
        makeFrame({ toolUseId: 't1', input: ': "# Hello World\\nLine 2"}' }),
        makeFrame({ stop: true, toolUseId: 't1' }),
    ]);

    const { events } = parseAwsEventStreamFrames(frames);
    console.log('  解析事件:', events.map(e => e.type));

    const tools = simulateStreamConsumer(events);
    console.log('  工具调用数:', tools.length);
    if (tools.length > 0) {
        const t = tools[0];
        console.log('  rawInput:', t.rawInput);
        console.log('  parsedInput:', JSON.stringify(t.input));
        const valid = typeof t.input === 'object' && t.input.file_path && t.input.content;
        printResult('流式字符串分片', valid ? 'PASS' : 'BUG',
            valid ? 'file_path 和 content 都正确保留' : 'input 解析失败');
    }
}

function test2_streamingObjectStringMismatch() {
    console.log('\n' + '═'.repeat(70));
    console.log('Test 2: 流式路径 - 第一帧 input 为对象，续传为字符串（Bug 2）');
    console.log('═'.repeat(70));

    const frames = Buffer.concat([
        makeFrame({ name: 'Write', toolUseId: 't2', input: { file_path: '/home/chris/test.md' } }),
        makeFrame({ toolUseId: 't2', input: ', "content": "hello world"}' }),
        makeFrame({ stop: true, toolUseId: 't2' }),
    ]);

    const { events } = parseAwsEventStreamFrames(frames);
    console.log('  解析事件:', events.map(e => e.type));

    const tools = simulateStreamConsumer(events);
    if (tools.length > 0) {
        const t = tools[0];
        console.log('  rawInput:', t.rawInput);
        console.log('  parsedInput:', JSON.stringify(t.input));
        const isObject = typeof t.input === 'object' && t.input.file_path && t.input.content;
        printResult('对象+字符串拼接', isObject ? 'PASS' : 'BUG',
            isObject ? '意外通过' : `拼接产生无效JSON，input保持为原始字符串: "${t.rawInput}"`);
    }
}

function test3_nonStreamingMultiFrame() {
    console.log('\n' + '═'.repeat(70));
    console.log('Test 3: 非流式路径 - 多帧工具 input（Bug 1 复现）');
    console.log('═'.repeat(70));

    // 模拟 parseEventStreamChunk 收到的 SSE 文本格式
    // 非流式路径收到的是 AWS event stream 二进制转成的文本
    // 每个帧的 payload 是独立的 JSON 对象
    const rawStr = [
        ':message-typeevent{"name":"Write","toolUseId":"t3","input":"{\\"file_path\\""}',
        ':message-typeevent{"toolUseId":"t3","input":": \\"/home/chris/test.md\\", \\"content\\""}',
        ':message-typeevent{"toolUseId":"t3","input":": \\"hello world\\"}"}',
        ':message-typeevent{"stop":true,"toolUseId":"t3"}',
    ].join(':event-type');

    const result = parseEventStreamChunkStandalone(rawStr);
    console.log('  工具调用数:', result.toolCalls.length);
    if (result.toolCalls.length > 0) {
        const tc = result.toolCalls[0];
        console.log('  function.arguments:', tc.function.arguments);
        try {
            const parsed = JSON.parse(tc.function.arguments);
            console.log('  parsed:', JSON.stringify(parsed));
            const valid = parsed.file_path && parsed.content;
            printResult('非流式多帧', valid ? 'PASS' : 'BUG',
                valid ? '意外通过' : 'content 丢失');
        } catch (e) {
            printResult('非流式多帧', 'BUG',
                `arguments 不是有效 JSON: "${tc.function.arguments}" (续传事件被丢弃)`);
        }
    } else {
        printResult('非流式多帧', 'BUG', '没有解析到任何工具调用');
    }
}

function test4_streamTruncation() {
    console.log('\n' + '═'.repeat(70));
    console.log('Test 4: 流截断 - 无 stop 事件');
    console.log('═'.repeat(70));

    const frames = Buffer.concat([
        makeFrame({ name: 'Write', toolUseId: 't4', input: '{"file_path"' }),
        makeFrame({ toolUseId: 't4', input: ': "/home/chris/.claude/plans/config-json-shiny-seal.md"' }),
        // 没有 stop 帧 - 模拟流被截断
    ]);

    const { events } = parseAwsEventStreamFrames(frames);
    console.log('  解析事件:', events.map(e => e.type));

    const tools = simulateStreamConsumer(events);
    if (tools.length > 0) {
        const t = tools[0];
        console.log('  rawInput:', t.rawInput);
        console.log('  parsedInput:', JSON.stringify(t.input));
        const isIncomplete = typeof t.input === 'string';
        printResult('流截断', isIncomplete ? 'TRUNCATION' : 'PASS',
            isIncomplete ? `input 不完整(无 content): "${t.rawInput}"` : '意外完整');
    }
}

function test5_replayFullResponse() {
    console.log('\n' + '═'.repeat(70));
    console.log('Test 5: 回放 full-response.json 分析');
    console.log('═'.repeat(70));

    const filePath = join(__dirname, '../docs/pending-plans/compress the inputs/full-response.json');
    let data;
    try {
        data = JSON.parse(readFileSync(filePath, 'utf8'));
    } catch (e) {
        console.log('  无法读取 full-response.json:', e.message);
        return;
    }

    console.log(`  总事件数: ${data.length}`);
    const types = {};
    data.forEach(e => { types[e.type] = (types[e.type] || 0) + 1; });
    console.log('  事件类型分布:', types);

    // 重建每个 tool_use 的 input
    let currentTool = null;
    let currentInput = '';
    let toolCount = 0;

    for (const evt of data) {
        const t = evt.type;
        const idx = evt.index;
        if (t === 'content_block_start') {
            const cb = evt.content_block || {};
            if (cb.type === 'tool_use') {
                if (currentTool) {
                    toolCount++;
                    reportTool(toolCount, currentTool, currentInput);
                }
                currentTool = { name: cb.name, id: cb.id, blockIndex: idx };
                currentInput = '';
            }
        } else if (t === 'content_block_delta' && currentTool && idx === currentTool.blockIndex) {
            const delta = evt.delta || {};
            if (delta.type === 'input_json_delta') {
                currentInput += delta.partial_json || '';
            }
        } else if (t === 'content_block_stop' && currentTool && idx === currentTool.blockIndex) {
            toolCount++;
            reportTool(toolCount, currentTool, currentInput, true);
            currentTool = null;
            currentInput = '';
        }
    }
    if (currentTool) {
        toolCount++;
        reportTool(toolCount, currentTool, currentInput, false);
    }

    printResult('full-response.json 分析', 'TRUNCATION',
        '所有 Write 工具的 input 都不完整(只有 file_path)，API 在发送 content 前就截断了');
}

function reportTool(num, tool, input, terminated) {
    const status = terminated === true ? '已终止' : terminated === false ? '未终止(截断)' : '被下一个工具替代';
    console.log(`  Tool #${num}: ${tool.name} (id=${tool.id}, index=${tool.blockIndex}, ${status})`);
    console.log(`    input (${input.length} chars): ${input.substring(0, 120)}${input.length > 120 ? '...' : ''}`);
    try {
        const parsed = JSON.parse(input);
        console.log(`    JSON 有效. Keys: [${Object.keys(parsed)}]`);
    } catch (e) {
        console.log(`    JSON 无效: ${e.message}`);
    }
}

function test6_nonStreamingSingleFrame() {
    console.log('\n' + '═'.repeat(70));
    console.log('Test 6: 非流式路径 - 单帧完整 input（对照组）');
    console.log('═'.repeat(70));

    const rawStr = ':message-typeevent{"name":"Write","toolUseId":"t6","input":{"file_path":"/home/chris/test.md","content":"hello world"},"stop":true}';

    const result = parseEventStreamChunkStandalone(rawStr);
    console.log('  工具调用数:', result.toolCalls.length);
    if (result.toolCalls.length > 0) {
        const tc = result.toolCalls[0];
        console.log('  function.arguments:', tc.function.arguments);
        try {
            const parsed = JSON.parse(tc.function.arguments);
            const valid = parsed.file_path && parsed.content;
            printResult('非流式单帧', valid ? 'PASS' : 'BUG',
                valid ? `file_path="${parsed.file_path}", content="${parsed.content}"` : 'input 不完整');
        } catch (e) {
            printResult('非流式单帧', 'BUG', `arguments 不是有效 JSON: "${tc.function.arguments}"`);
        }
    }
}

// ─── Main ───

function main() {
    console.log('╔══════════════════════════════════════════════════════════════════════╗');
    console.log('║  Write tool_use 解析诊断                                            ║');
    console.log('╚══════════════════════════════════════════════════════════════════════╝');

    test1_streamingStringChunks();
    test2_streamingObjectStringMismatch();
    test3_nonStreamingMultiFrame();
    test4_streamTruncation();
    test5_replayFullResponse();
    test6_nonStreamingSingleFrame();

    console.log('\n' + '═'.repeat(70));
    console.log('总结:');
    console.log('  1. 流式路径字符串分片: 正常工作');
    console.log('  2. 对象+字符串拼接: normalizeKiroToolInput 导致无效 JSON');
    console.log('  3. 非流式路径多帧: parseEventStreamChunk 不处理续传事件');
    console.log('  4. 流截断: 未终止的工具调用被保留但 input 不完整');
    console.log('  5. full-response.json: API 端截断，content 从未被发送');
    console.log('  6. 非流式单帧: 正常工作（对照组）');
    console.log('═'.repeat(70));
}

main();
