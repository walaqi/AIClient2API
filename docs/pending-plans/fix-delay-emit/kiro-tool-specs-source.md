# Kiro 工具 spec 常量来源 — `remote_web_search` / `web_fetch`
(本计划已经废弃)
## Context（背景）

[kiro-web-tools-mapping.md](kiro-web-tools-mapping.md) 的过滤循环 `require('./kiro-tool-specs.json')` 引用本文件描述的常量文件。本文件记录该常量文件的内容、来源、维护策略与字段命名约定。

两个工具均通过用户提供的真实 Kiro session tool-specification（`modelId: claude-opus-4.7`）确认其完整 schema。

## 来源文件

- [/mnt/c/Users/chris/Downloads/kiro sessions/tool-specification.json](file:///mnt/c/Users/chris/Downloads/kiro%20sessions/tool-specification.json) — Kiro 端真实 schema 来源（仅用于生成 / 校验下面的常量文件）：
  - line 1085-1103 — `remote_web_search` 完整定义（`{query}`, required `["query"]`, `additionalProperties: false`）
  - line 1106-1153 — `web_fetch` 完整定义（`{url, mode?, searchPhrase?}`, required `["url"]`, mode enum `full|truncated|selective|rendered`, 默认 `truncated`）
- [/mnt/c/Users/chris/Downloads/claude sessions/tool-specification.json](file:///mnt/c/Users/chris/Downloads/claude%20sessions/tool-specification.json) — Anthropic 客户端 schema 来源（line 803-825 `WebFetch` 为 `{url, prompt}`，line 826-859 `WebSearch`），用于解释为什么 `web_fetch` 必须做 schema 替换而不能透传

## 常量文件内容（`src/providers/claude/kiro-tool-specs.json`）

把 `remote_web_search` 与 `web_fetch` 的完整 `description` / `inputSchema` 从来源文件中**逐字段复制**，固化进仓库新文件 `src/providers/claude/kiro-tool-specs.json`，结构与 Anthropic 工具规范对齐，便于过滤循环直接 `require` 引用：

```json
{
    "remote_web_search": {
        "name": "remote_web_search",
        "description": "<逐字段复制 spec line 1085 的 description 原文，包括 When to Use / When NOT to Use / Content Compliance Requirements / Usage Details / Output Usage / Error Handling / Output / Scope 全部小节，不做摘要>",
        "input_schema": {
            "$schema": "http://json-schema.org/draft-07/schema#",
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "query": {
                    "type": "string",
                    "description": "The search query to execute. Must be 200 characters or less."
                }
            },
            "required": ["query"]
        }
    },
    "web_fetch": {
        "name": "web_fetch",
        "description": "<逐字段复制 spec line 1107 的 description 原文，包括 SECURITY WARNING 与 RULES 1-3 全部内容，不做摘要>",
        "input_schema": {
            "$schema": "http://json-schema.org/draft-07/schema#",
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "mode": {
                    "default": "truncated",
                    "type": "string",
                    "enum": ["full", "truncated", "selective", "rendered"],
                    "description": "<逐字段复制 spec line 1115 的 description 原文>"
                },
                "searchPhrase": {
                    "anyOf": [
                        { "anyOf": [ { "not": {} }, { "type": "string" } ] },
                        { "type": "null" }
                    ],
                    "description": "Required only for Selective mode. The phrase to search for in the content. Only sections containing this phrase will be returned."
                },
                "url": {
                    "type": "string",
                    "description": "<逐字段复制 spec line 1143 的 description 原文，包括 CRITICAL RULES 1-4>"
                }
            },
            "required": ["url"]
        }
    }
}
```

## 取舍说明

审阅意见 3.2 给出两个选项——直接读取 spec 原文 or 固化常量文件。选后者，原因有三：

1. 仓库内常量文件可走 PR review、有 git 历史；
2. 用户机器上的 `tool-specification.json` 路径不在仓库内，CI 与其它开发机访问不到；
3. 未来 Kiro 升级 spec 时只需重新抓一份 capture、复制两段进 JSON、提一个独立的 spec-bump PR，diff 直观、可回滚。

## 实施约束

- **严格逐字段复制**：不允许手写 description 摘要——直接从 [/mnt/c/Users/chris/Downloads/kiro sessions/tool-specification.json](file:///mnt/c/Users/chris/Downloads/kiro%20sessions/tool-specification.json) line 1085-1153 复制；
- **PR commit message 中需记录**抓包源文件的来源会话与时间戳，便于未来对比；
- **字段命名风格**：使用 Anthropic 风格 `name`/`description`/`input_schema`（非 Kiro 风格 `toolSpecification.inputSchema.json`）。下游 [claude-kiro.js:1242 起](src/providers/claude/claude-kiro.js#L1242) 会做包装转换，遵循「和其它工具同走一条转换路径」约定。

## Critical Files（关键文件）

- `src/providers/claude/kiro-tool-specs.json` — 本文件描述的目标常量文件（**新增**）
- [src/providers/claude/claude-kiro.js:1242](src/providers/claude/claude-kiro.js#L1242) — 下游 wrapper 转换路径（与本常量文件字段命名风格的耦合点）
- [/mnt/c/Users/chris/Downloads/kiro sessions/tool-specification.json](file:///mnt/c/Users/chris/Downloads/kiro%20sessions/tool-specification.json) — schema 唯一来源（line 1085-1103 / line 1106-1153）

## 维护流程

未来 Kiro 升级 spec 时的 spec-bump PR：

1. 重新抓一份 Kiro session capture（保持 `KIRO_CAPTURE_RAW` 开启；或从最新会话保存 tool-specification）；
2. 对比两个工具的 description / inputSchema 与现有常量文件 diff；
3. 如有变更，逐字段复制更新 `src/providers/claude/kiro-tool-specs.json`；
4. 在 commit message 中记录新 capture 的来源会话与时间戳；
5. 单独 PR 提交，避免与功能性改动耦合。
