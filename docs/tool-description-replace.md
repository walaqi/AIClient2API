# Tool Description Replace —— 需求与实现

## 一、背景与需求

### 起因
Kiro 渠道按上下文 token 计费，工具描述（`tools[].description`）会随每次请求作为输入 token 反复结算。客户端（如 Claude Code）下发的工具描述往往很长，里面包含大量示例和叙述性 prose，存在压缩空间。原先 `claude-kiro.js` 里有一套"超长 description 头+尾截断"的代码处理这个问题，但策略粗糙：

- 截断位置在中部，会丢失藏在中段的关键约束
- 用 `TRUNCATION_WHITELIST` 硬编码豁免几个工具，灵活性差
- 配套的 `OUTPUT_RESERVE_TOOL_RESULT_TRUNCATE` 对历史消息 `tool_result` 做截断，会改写 LLM 已经输出过的工具结果，可能影响后续推理

### 三个目标
1. **删除历史消息 `tool_result` 截断**：删除 description 截断会丢信息，但删 tool_result 更危险——会让模型看到与它原始输出不一致的历史，因此先把这条整段移除
2. **删除工具描述截断与"空 description 丢弃"过滤**：把"自动改写"的逻辑全部下线，回归原样转发
3. **新增 `TOOL_DESCRIPTION_REPLACEMENTS` 配置**：用户可手动按 tool 名定向替换/压缩 description，由用户对内容负完全控制权

### 设计要点（在讨论中确认）
- **强制按 tool 名定向**：每条规则必填 `tool` 字段（与 `tools[i].name` **大小写敏感精确匹配**），避免一刀切误伤
- **不要"全局缺省"语义**：缺 `tool` 字段的规则启动时 warn + 跳过，不容忍隐式行为
- **找不到 tool 静默丢弃**：不同客户端工具集不同，配置里有但请求里没有的规则不打日志
- **多条规则顺序应用**：同一 tool 的多条规则按数组顺序串行，前一条结果作为后一条输入
- **仅作用于 Anthropic / Kiro 形态**：按 `tools[i].name` 匹配，OpenAI 的 `tools[i].function.name` 与 Gemini 的 `functionDeclarations[].name` 暂不支持。这意味着规则即便配在其他 strategy 上也会因取不到 `tool.name` 而 no-op，等以后再扩展。

## 二、改动文件清单

| 文件 | 改动 |
|---|---|
| `src/providers/claude/claude-kiro.js` | 删除 tool_result 截断、tool description head+tail 截断、空 description 过滤、`TRUNCATION_WHITELIST`、`pickAdaptiveDescBudget` / `ADAPTIVE_DESC_TABLE`、`adaptiveDesc` 路径；`getOutputReserveConfig` 简化为只返回 `pressureFactor` |
| `src/converters/utils.js` | 新增 `applyReplacementsToToolDescriptions(requestBody, replacements)`，按 `tool.name` 分桶定向匹配 |
| `src/core/config-manager.js` | 新增默认值 `TOOL_DESCRIPTION_REPLACEMENTS: []` |
| `src/ui-modules/config-api.js` | 三处加入字段——GET 配置返回（line 94）、PATCH 写入校验（line 180）、保存写盘白名单（line 335） |
| `src/providers/claude/claude-strategy.js` 等 7 个 strategy | 在 `applySystemPromptFromFile` 入口处与 `applyReplacementsToClientSystem` 并列调用 `applyReplacementsToToolDescriptions(requestBody, config.TOOL_DESCRIPTION_REPLACEMENTS)` |
| `src/ui-modules/config-api.js` / `static/components/section-tutorial.html` | 删除已下线配置字段 `OUTPUT_RESERVE_TOOL_RESULT_TRUNCATE` / `OUTPUT_RESERVE_TOOL_RESULT_MAX_CHARS` / `OUTPUT_RESERVE_TOOL_DESC_ADAPTIVE` 的暴露与文档行 |

## 三、配置使用

### config.json 示例

```json
{
  "TOOL_DESCRIPTION_REPLACEMENTS": [
    { "tool": "Bash", "old": "git push --force", "new": "(redacted)" },
    { "tool": "Bash", "old": "long boilerplate paragraph...", "new": "" },
    { "tool": "Read", "old": "By default, it reads up to 2000 lines", "new": "Reads up to 2000 lines" }
  ]
}
```

### 字段语义

| 字段 | 必填 | 说明 |
|---|---|---|
| `tool` | 是 | 与 `tools[i].name` 精确匹配（大小写敏感）。缺失/空字符串 → 启动时 warn + 跳过 |
| `old` | 是 | 字面字符串匹配（`String.split().join()`，非正则）。不存在则规则被跳过 |
| `new` | 是 | 替换文本。不存在则规则被跳过 |

### 换行的写法

`config.json` 是 JSON 文件，按 JSON 字符串转义规则——文件中实际存储的是 **`\` + `n` 两个字符**（不是真换行，也不是 `\\n` 四个字符）：

```json
{ "tool": "Bash", "old": "first line\nsecond line", "new": "merged" }
```

JSON parser 解析后 `old` 在内存中是 `first line` + 0x0A + `second line`，再去匹配原 description 中的真换行段落。其他常用转义同 JSON 标准：`\t` 制表符、`\"` 双引号、`\\` 反斜杠；`(` `)` 不需要转义。

如果原 description 是 CRLF（`\r\n`），`\n` 是匹配不上的——要写 `\r\n` 或先归一化。

## 四、运行时行为

### 调用链

客户端请求 → `applySystemPromptFromFile`（每个 strategy）：

```js
applyReplacementsToClientSystem(requestBody, config.SYSTEM_PROMPT_REPLACEMENTS, protocolPrefix);
applyReplacementsToToolDescriptions(requestBody, config.TOOL_DESCRIPTION_REPLACEMENTS);
// ↓ 然后才走系统提示词文件注入
```

两步互不依赖：先无条件改写客户端原始 system / tool descriptions，再决定是否注入 system prompt 文件。即使没有配置 `SYSTEM_PROMPT_FILE_PATH` 也会生效。

### 匹配逻辑

```
对每条规则:
  rule.tool 不是非空字符串 → warn + 跳过(只在加载阶段一次)
  rule.old / rule.new 任一缺失 → 跳过
  否则按 tool 名分桶

对 requestBody.tools 中每个 tool:
  没有 tool.name (非 Anthropic 形态) → 静默跳过
  桶里没有这个 tool 名的规则 → 静默跳过
  否则按数组顺序对 tool.description 串行应用所有命中规则
```

### 与系统提示词替换的关系

`SYSTEM_PROMPT_REPLACEMENTS` 与 `TOOL_DESCRIPTION_REPLACEMENTS` 完全解耦：

| 维度 | SYSTEM_PROMPT_REPLACEMENTS | TOOL_DESCRIPTION_REPLACEMENTS |
|---|---|---|
| 作用对象 | `requestBody.system` / messages 里的 system 角色内容 / Gemini `systemInstruction` / Codex `instructions` | `tools[i].description`（Anthropic 形态） |
| 是否定向 | 否（按协议内所有 system 位置全扫） | **是**（强制按 `tool.name`） |
| 缺省行为 | 无 tool 字段时正常生效 | 无 tool 字段时 warn + 跳过 |

两套规则可同时配置，互不影响。

## 五、删除清单（与本次新增配套）

下列配置项已从代码与 UI 文档中移除：

- `OUTPUT_RESERVE_TOOL_RESULT_TRUNCATE`（历史 `tool_result` 截断开关）
- `OUTPUT_RESERVE_TOOL_RESULT_MAX_CHARS`（截断阈值）
- `OUTPUT_RESERVE_TOOL_DESC_ADAPTIVE`（自适应 description 长度预算）

如旧 `config.json` 里仍保留这些字段，不会报错——它们会被读取但无人消费，相当于死字段。下次 UI 保存时会因为不在白名单而被剔除。

## 六、压缩工具描述的实务建议

详见 user-level skill `~/.claude/skills/compress-tool-description/SKILL.md`。核心原则：

1. **constraint > narrative**——含 `IMPORTANT/MUST/NEVER/Do NOT` 的整句、工具白名单、参数枚举值（如 `"very thorough"` 不能简化为 `"thorough"`）必须逐字保留
2. **examples 全或无**——保留完整 `Tool({...})` 调用 + 真实 prompt 字符串，或整段删除；**严禁保留 example 容器但只放一句"对 example 的总结"**——浪费 token 且零信息
3. **典型尺寸/保真度**：60% ≈ ~95% 保真；25% ≈ ~60% 保真。若用户要求"压到 1/4"，明确告知会丢失 examples + 部分语义区分

## 七、关键提交点

- 删除 tool_result 截断 + 配置项
- 删除 description 头尾截断 + adaptive 预算 + truncation whitelist + 空 description 过滤
- 新增 `applyReplacementsToToolDescriptions` + 7 个 strategy 的并列调用
- `config-manager` / `config-api` / `section-tutorial.html` 同步更新
