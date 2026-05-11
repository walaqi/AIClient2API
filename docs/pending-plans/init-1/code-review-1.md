看完了,改动分五个文件,我按严重程度评审。

  **主要问题**

  1. totalContent 污染 (claude-kiro.js:2677)

  } else if (event.type === 'reasoning' && event.text) {
      totalContent += event.text;  // ← 问题在这
  当 thinkingRequested=true 时,reasoning 进入 thinking 管道,不作为可见文本输出。但仍然累加到 totalContent,而末尾的 parseBracketToolCalls(totalContent) 会扫描 [tool] 格式的工具调用。如果模型在 reasoning
  里提到类似 [search(...)] 的内容,会被误当成工具调用。

  建议:只在走 text 分支时累加:
  } else if (event.type === 'reasoning' && event.text) {
      if (thinkingRequested) {
          yield* pushEvents(createThinkingDeltaEvents(event.text));
      } else {
          totalContent += event.text;
          streamState.buffer += event.text;
          if (streamState.buffer.endsWith('\\')) continue;
          yield* pushEvents(createTextDeltaEvents(streamState.buffer));
          streamState.buffer = '';
      }
  }

  2. reasoning 事件判别条件偏弱 (claude-kiro.js:2161)

  else if (parsed.text !== undefined && !parsed.name && !parsed.toolUseId && parsed.content === undefined)
  只要 text 字段存在且不是工具事件就匹配。如果 Kiro 未来给错误事件、状态事件等也带上 text,会被误归类。建议加一层类型断言:
  else if (typeof parsed.text === 'string' && !parsed.name && !parsed.toolUseId && parsed.content === undefined)

  3. MAX_DESCRIPTION_LENGTH 10× 放大 (claude-kiro.js:1164)

  9216 → 92160。这是本地截断阈值,但 Kiro 服务端可能有自己的硬限制。放大后本地不截断了,可能换成服务端 400/413。建议拿一个确实很长的工具描述打一次请求验证。
    **本条目已经修改. 改回原来的9216(9k)**

  **次要问题**

  4. 遗留注释代码 (claude-kiro.js:1049-1057)

  10 行注释掉的 builtInPrefix。如果确认不再需要,直接删掉;保留着会让下次读代码的人困惑。而且下面 systemPrompt = builtInPrefix + systemPrompt 现在等价于无操作,可以一起清掉。
    **这一点需要斟酌. 根据下面的逻辑,删除builtInPrefix可能导致systemPrompt在某些地方成为undifined**

  5. 诊断日志会污染生产日志 (claude-kiro.js:2206, 2315, 2902)

  三处新增日志都挺有用,但:
  - [Kiro Parse] Unrecognized event JSON 是 warn 级,每个未识别事件都会写一条
  - [Kiro Stream] Stream completed. 是 info 级,每次请求都会写一条

  诊断完问题后建议降到 debug 级或用环境变量 gate 掉,否则日志量会很大(看了下你的 instruction_logs.log 已经 2.6MB 了)。

  6. logger.js Buffer 解码,有优化空间 (logger.js:214-221)

  if (value && value.type === 'Buffer' && Array.isArray(value.data)) {
      const decoded = Buffer.from(value.data).toString('utf8');
      return decoded.length > 500 ? decoded.substring(0, 500) + '...[truncated]' : decoded;
  }
  如果 response body 有几 MB,Buffer.from(value.data) 会先把整个数组复制成 Buffer,再整个 toString 为字符串,最后才截断。可以先切数组再转:
  const slice = value.data.length > 2048 ? value.data.slice(0, 2048) : value.data;
  const decoded = Buffer.from(slice).toString('utf8');
  return decoded.length > 500 ? decoded.substring(0, 500) + '...[truncated]' : decoded;
  对日志路径来说不是大问题,可选优化。

  好的改动

  - busboy 加入 package.json — api-manager.js:13 一直在 import busboy from 'busboy',但没声明为依赖,这是真实的 bug 修复。
  - logger 的 Buffer 解码 — 思路正确,用 JSON.stringify 的 replacer 捕获序列化后的 Buffer 形态({type:'Buffer', data:[...]}),位置对。
  - reasoning 事件新增分支位置 — 插在 content handler 之后、tool handler 之前,顺序合理。
  - 流结束时 buffer 残留检测 — 对排查截断问题很有价值。

  需要确认的改动

  - GITHUB_REPO: 'justlovemaki/AIClient2API' → 'walaqi/AIClient2API'(update-api.js:13)——这会让更新检查器指向你的 fork。如果是故意的(自建更新通道),OK。如果是调试时误改的,记得还原。
**确认是故意的**
  ---
  综合评价:核心的 reasoning 支持和 Buffer 解码思路都对,主要风险是 totalContent 污染那一条,建议先修。其他都是收尾问题。