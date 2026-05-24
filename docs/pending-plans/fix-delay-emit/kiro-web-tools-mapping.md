# Kiro `remote_web_search` 与 `web_fetch` 启用 — 过滤改映射
(本计划已经废弃)
## Context（背景）

用户反馈 web_search 被代码显式禁用没必要、Kiro 端有等价的 `remote_web_search`；同样 web_fetch 也应当开放。

涉及两条平行的「客户端原生工具→Kiro 原生工具」映射：

1. **Web Search** — 当前在 [claude-kiro.js:1209-1220](src/providers/claude/claude-kiro.js#L1209-L1220) 被显式过滤丢弃。Kiro 端有等价的 `remote_web_search`。
2. **Web Fetch** — 当前**未**在过滤列表，但 Anthropic 客户端发的 `WebFetch` schema 是 `{url, prompt}`，Kiro 原生 `web_fetch` schema 是 `{url, mode?, searchPhrase?}`，schema 不一致——直接透传会被 Kiro 端 `validationException` 拒绝（用户感受同为「工具不工作」）。

当前过滤代码：

```js
const filteredTools = tools.filter(tool => {
    const name = (tool.name || '').toLowerCase();
    const shouldIgnore = name === 'web_search' || name === 'websearch';
    if (shouldIgnore) {
        logger.info(`[Kiro] Ignoring tool: ${tool.name}`);
    }
    return !shouldIgnore;
});
```

引入 web_search 过滤的 commit 是 `340d6f9`（fix(claude-kiro): 修复工具调用token计算和web搜索工具过滤问题），commit message 未给出具体技术原因——很可能只是「Kiro 不接受这个 schema 名 / 报错」的兼容垫片。用户的提议方向正确：Kiro 平台本身有等价能力时应当**映射**而非**丢弃 / 任由 schema 不一致而失败**。

载体经用户提供的真实 Kiro 会话 tool-specification（`modelId: claude-opus-4.7`）确认，无需「试探性请求」验证：

- **位置**：两者均与现有用户工具同槽位 `request.conversationState.currentMessage.userInputMessage.userInputMessageContext.tools[*]`，**不**走 `additionalModelRequestFields`；
- **形态**：标准 `toolSpecification`，与普通工具的 wrapper 完全一致（`{toolSpecification: {name, description, inputSchema}}`），无任何 builtin/type 标记字段；
- **支持模型**：至少 `claude-opus-4.7` 已观察到。

工具 spec 的完整 schema 与来源详见 [kiro-tool-specs-source.md](kiro-tool-specs-source.md)。`additionalModelRequestFields` 路径（曾考虑的形态 Y）可彻底排除，本任务无「先验证再实施」探路阶段。

## 已识别的相关代码点

- [claude-kiro.js:1209-1220](src/providers/claude/claude-kiro.js#L1209-L1220) — 当前 web_search 过滤逻辑入口（web_fetch 不在过滤里，但 schema 不一致会被 Kiro 拒绝）
- [claude-kiro.js:1622-1677](src/providers/claude/claude-kiro.js#L1622-L1677) — Kiro 请求构造（工具最终落到 `userInputMessageContext.tools`）
- [CodexConverter.js:568-571](src/converters/strategies/CodexConverter.js#L568-L571) — Claude `web_search_20250305 → web_search` 映射先例
- [ClaudeConverter.js:2052-2055](src/converters/strategies/ClaudeConverter.js#L2052-L2055) — 同上先例
- 仓库内 `remote_web_search` 字面量为零，`web_fetch` 字面量也未在 claude-kiro.js 出现 — 两者均为**新增**映射目标，不是被错误命名的旧开关。

## Plan（推荐方案）

单阶段实施。把 [claude-kiro.js:1209-1220](src/providers/claude/claude-kiro.js#L1209-L1220) 的「过滤」循环替换为「识别上游形态 → 重写为 Kiro 原生 schema」，对 `web_search` 与 `web_fetch` 两条平行处理。工具 spec 常量从 [kiro-tool-specs-source.md](kiro-tool-specs-source.md) 描述的 `kiro-tool-specs.json` 引用。

### 实施 — Web Search 映射

1. **入参形态多样**：上游可能传四种 `web_search` 形态，每种都需识别（按 review-2 §3.3 原则，每个分支均附证据来源）：
   - `{name: "web_search"}`（小写）— 现 [claude-kiro.js:1213-1219](src/providers/claude/claude-kiro.js#L1213-L1219) 过滤代码 lowercase 比较已对此命中（commit `340d6f9` 引入），**码内证据**；
   - `{name: "websearch"}`（小写无下划线）— 同 [claude-kiro.js:1213-1219](src/providers/claude/claude-kiro.js#L1213-L1219) 已识别，**码内证据**；
   - `{type: "web_search"}`（无 name，仅 type）— [CodexConverter.js:568-571](src/converters/strategies/CodexConverter.js#L568-L571) / [ClaudeConverter.js:2052-2055](src/converters/strategies/ClaudeConverter.js#L2052-L2055) 转换器输出形态，**码内证据**；
   - `{type: "web_search_20250305"}` — Anthropic API 官方 tool spec 名（作为转换器输入），**码内证据**（同上两文件中的输入端识别）。

2. **映射内容固定**：因为 Kiro 端 schema 已知，**不**透传客户端传来的 description/inputSchema（避免 schema 不一致导致 validationException），用 Kiro 真实 spec 中的 description + schema 替换。

3. **配置开关**：加 `KIRO_REMOTE_WEB_SEARCH_ENABLED`（布尔，默认 `true`，因为载体已确认），关闭时退回当前过滤行为，便于一旦观察到 validationException 立即回退。命名遵循仓库现有 `RATE_LIMIT_COOLDOWN_ENABLED` / `LOG_ENABLED` / `TLS_SIDECAR_ENABLED` / `UI_ENABLED` 等布尔开关 `_ENABLED` 后缀约定（review-2 §5）。

### 实施 — Web Fetch 映射

1. **入参形态多样**：上游可能传四种 `web_fetch` 形态，按 review-2 §3.3 原则对每种标注证据来源；未命中证据的分支保留为 TODO，由 R5 verify 阶段实测后裁剪：
   - `{name: "WebFetch", input_schema: {url, prompt}}`（PascalCase）— [/mnt/c/Users/chris/Downloads/claude sessions/tool-specification.json](file:///mnt/c/Users/chris/Downloads/claude%20sessions/tool-specification.json) line 803-825，**capture 实证**；
   - `{name: "web_fetch", ...}`（小写）— 仓库内**零证据**；`// TODO: pending capture evidence — drop this branch if no client form is observed during R5 verify`；
   - `{type: "web_fetch"}`（无 name，仅 type）— **零证据**；同上 TODO 标注；
   - `{type: "web_fetch_20250910"}` — Anthropic API beta 公开命名，**仓库内零证据**（无现成转换器先例对应）；同上 TODO 标注。

   保留 TODO 分支而非直接删除的理由：漏识别真实客户端形态会让 web_fetch 直接走透传 → Kiro 必拒，用户感受为「工具不工作」；TODO 分支误识的代价仅是把不存在的形态 map 到正确 schema，无副作用。R5 verify 阶段实测命中后再裁剪未命中分支。

2. **schema 重写不可省**：与 web_search 不同，`web_fetch` 当前并未被代码过滤——但 Anthropic 风格 `{url, prompt}` 与 Kiro 风格 `{url, mode?, searchPhrase?}` 字段差异大（`prompt` 是描述性问题，`mode` 是行为枚举），直接透传必然被 Kiro 拒绝。所以替换 schema 是**必须**，不仅仅是「对齐工具名」。

3. **`prompt → searchPhrase` 处理**：客户端传的 `prompt` 在 Anthropic 语义里是「用户希望从这个 URL 提取什么内容」——与 Kiro 的 `searchPhrase`（「指导抽取的搜索短语」）语义最接近。但因为是模型在 tool_use 时填，实际由模型自行选择，**不需要在过滤层做参数搬运**——把 schema 替换为 Kiro 原生的，模型按新 schema 再生成参数即可（这正是用户认可的「模型会根据 spec 调整输出」原则）。

4. **配置开关**：加 `KIRO_WEB_FETCH_ENABLED`（布尔，默认 `true`），关闭时**完全丢弃**该工具（与现 web_search 旧行为一致），并 log `[Kiro] Ignoring tool: web_fetch (KIRO_WEB_FETCH_ENABLED=false)`。理由：直接透传 Anthropic schema 必被拒，没有「原样保留」的有意义路径。命名遵循 `_ENABLED` 后缀约定（review-2 §5）。

### 合并后的过滤循环

替换 [claude-kiro.js:1209-1220](src/providers/claude/claude-kiro.js#L1209-L1220) 的过滤逻辑（`KIRO_TOOL_SPECS` 即 [kiro-tool-specs-source.md](kiro-tool-specs-source.md) 描述的 `kiro-tool-specs.json` 常量）：

```js
const KIRO_TOOL_SPECS = require('./kiro-tool-specs.json');

const filteredTools = [];
for (const tool of tools) {
    const lowerName = (tool.name || '').toLowerCase();
    const lowerType = (tool.type || '').toLowerCase();

    // 4 forms: web_search / websearch (lowercase name) + type:web_search / type:web_search_20250305
    // all four forms have code-internal evidence (claude-kiro.js:1213-1219 + Codex/ClaudeConverter)
    const isWebSearch = lowerName === 'web_search' || lowerName === 'websearch'
        || lowerType === 'web_search' || lowerType === 'web_search_20250305';
    if (isWebSearch) {
        if (config.KIRO_REMOTE_WEB_SEARCH_ENABLED === false) {
            logger.info(`[Kiro] Ignoring tool: ${tool.name || tool.type} (KIRO_REMOTE_WEB_SEARCH_ENABLED=false)`);
            continue;
        }
        logger.info(`[Kiro] Mapping ${tool.name || tool.type} → remote_web_search`);
        filteredTools.push(KIRO_TOOL_SPECS.remote_web_search);
        continue;
    }

    // 4 forms: WebFetch (capture-confirmed), web_fetch / type:web_fetch / type:web_fetch_20250910
    // (TODO: capture pending; trim unconfirmed forms during R5 verify before merge)
    const isWebFetch = lowerName === 'web_fetch' || lowerName === 'webfetch'
        || lowerType === 'web_fetch' || lowerType === 'web_fetch_20250910';
    if (isWebFetch) {
        if (config.KIRO_WEB_FETCH_ENABLED === false) {
            logger.info(`[Kiro] Ignoring tool: ${tool.name || tool.type} (KIRO_WEB_FETCH_ENABLED=false)`);
            continue;
        }
        logger.info(`[Kiro] Mapping ${tool.name || tool.type} → web_fetch`);
        filteredTools.push(KIRO_TOOL_SPECS.web_fetch);
        continue;
    }

    filteredTools.push(tool);
}
```

注：

- 对象用 Anthropic 风格的 `name`/`description`/`input_schema` 字段名，因为 [claude-kiro.js:1242 起](src/providers/claude/claude-kiro.js#L1242) 的下游代码会负责包装成 Kiro 的 `{toolSpecification: {name, description, inputSchema: {json}}}` 形态；遵循「和其它工具同走一条转换路径」约定，避免另起 if 分支。具体下游字段名以现有代码为准（实施时核对一遍）。
- **保留 placeholder 路径**：[claude-kiro.js:1222-1234](src/providers/claude/claude-kiro.js#L1222-L1234) 的「全部被过滤后塞 `no_tool_available`」分支因为上面改成映射后几乎不会触发，但保留逻辑不动（作为防御）。

## Critical Files（关键文件）

- [src/providers/claude/claude-kiro.js](src/providers/claude/claude-kiro.js#L1209-L1220) — 过滤改映射的唯一编辑点（两条工具一起处理）
- `src/providers/claude/kiro-tool-specs.json` — **新增**常量文件，内容与来源详见 [kiro-tool-specs-source.md](kiro-tool-specs-source.md)
- [src/converters/strategies/CodexConverter.js#L568-L571](src/converters/strategies/CodexConverter.js#L568-L571) / [ClaudeConverter.js#L2052-L2055](src/converters/strategies/ClaudeConverter.js#L2052-L2055) — 上游 `web_search_20250305 → web_search` 转换先例（解释为什么本任务要同时识别 `tool.type` 形态）

## Verification（验证）

### Web Search 路径

1. **基础流通**：默认开关 on 时，发一条必然触发搜索的提示（「今天 AAPL 收盘价」），断言：
   - 代理日志出现 `[Kiro] Mapping web_search → remote_web_search`；
   - 不再出现 `[Kiro] Ignoring tool`；
   - 客户端收到 `tool_use` 块且 `name === 'remote_web_search'`、`input.query` 非空；
   - tool_result 回填后客户端能继续生成最终回答。
2. **回退路径**：`KIRO_REMOTE_WEB_SEARCH_ENABLED=false` 时，日志出现 `[Kiro] Ignoring tool: web_search (KIRO_REMOTE_WEB_SEARCH_ENABLED=false)`，行为等同于当前 commit（继续丢弃 + 必要时占位工具）。

### Web Fetch 路径

3. **基础流通**：默认开关 on 时，发一条必须抓取 URL 才能回答的提示（「总结 https://example.com 首页内容」），断言：
   - 代理日志出现 `[Kiro] Mapping WebFetch → web_fetch`（或 `web_fetch → web_fetch`，取决于客户端命名）；
   - 客户端收到 `tool_use` 块且 `name === 'web_fetch'`、`input.url` 非空；
   - 模型按新 schema 自行决定是否填 `mode` / `searchPhrase`（不强制断言两者出现）；
   - tool_result 回填后客户端能继续生成最终回答。
4. **回退路径**：`KIRO_WEB_FETCH_ENABLED=false` 时，日志出现 `[Kiro] Ignoring tool: WebFetch (KIRO_WEB_FETCH_ENABLED=false)`，该工具不被注册到 Kiro 侧（与 web_search 旧行为一致）。

### 共通

5. **schema 拒绝**：两条路径都需要确认 Kiro 端不返回 `validationException`（建议同步开 `KIRO_CAPTURE_RAW`，故障时立刻有原始字节可 replay）。
6. **多模型抽样**：opus-4.7 / sonnet-4.6 / opus-4.6 各发一条 web_search、一条 web_fetch 请求确认两条都能受理（schema 来源的 capture 是 opus-4.7，其它型号需补抽样）。
7. **web_fetch 形态实证**：在 PR 合并前用 Claude Code CLI、Anthropic SDK beta、其它已知客户端各发起一次需要 fetch URL 的请求，记录 `[Kiro] Mapping ... → web_fetch` 日志中实际命中的 `tool.name` / `tool.type` 字面量。R2 中标注 `// TODO: pending capture evidence` 的分支（`web_fetch` 小写 / `type:web_fetch` / `type:web_fetch_20250910`），合并前**只保留实测命中的形态**，未命中的删除以避免死分支（对齐 review-2 §3.3 原则）。

## 风险与回退

| 修复项 | 主要风险 | 回退手段 | 回退后行为 |
|---|---|---|---|
| Web 工具映射 | Kiro 后续修改 `remote_web_search` / `web_fetch` schema 后，仓库内固化的 `kiro-tool-specs.json` 常量与上游漂移；用户表现为 `validationException` 或工具调用结果异常 | `KIRO_REMOTE_WEB_SEARCH_ENABLED=false` 与 `KIRO_WEB_FETCH_ENABLED=false` 独立可关 | 任一关闭后该工具退回到「过滤丢弃」行为（与当前 main 对 web_search 的处理一致），不会造成用户体验降级 |

`KIRO_REMOTE_WEB_SEARCH_ENABLED` / `KIRO_WEB_FETCH_ENABLED` 两个开关因为 Kiro spec 漂移风险长期存在，建议**长期保留**作为应急开关。

## 文档同步

本 PR 落地时，在主 [README.md](README.md)、[README-ZH.md](README-ZH.md)、[README-JA.md](README-JA.md) 各自的环境变量段落补充两项：

- `KIRO_REMOTE_WEB_SEARCH_ENABLED`（布尔，默认 `true`）— 关闭后 web_search 退回过滤丢弃
- `KIRO_WEB_FETCH_ENABLED`（布尔，默认 `true`）— 关闭后 web_fetch 退回过滤丢弃

命名风格对齐仓库现有 `RATE_LIMIT_COOLDOWN_ENABLED` / `LOG_ENABLED` / `TLS_SIDECAR_ENABLED` / `UI_ENABLED` 与 `KIRO_OAUTH_CREDS_*` / `KIRO_REQUEST_MIN_INTERVAL_MS` 两类约定：布尔型用 `_ENABLED` 后缀，数值型保留 `_MS` / `_PATH` 等单位后缀。

[configs/config.json.example](configs/config.json.example) 不强制写入这两项 — 与现有 `KIRO_REQUEST_MIN_INTERVAL_MS` / `KIRO_STREAM_TIMEOUT_MS` 等 KIRO 行为类开关同样不出现在 example 中，保持一致。

## 与主任务的关系

附加任务**独立**于主任务（[fix-write-failed.md](fix-write-failed.md) 的 Write failed bug）：
- 主任务 Phase 1 的 `KIRO_CAPTURE_RAW` 抓取窗口里如果同时观察到 `remote_web_search` / `web_fetch` 调用，是顺带验证；
- 主任务的修复 A/B/D 与本任务不冲突，可同 PR 也可分 PR；
- 建议主修复（PR-2）合并并稳定 1-2 天后再合并本任务（PR-3），避免观察期相互干扰。
