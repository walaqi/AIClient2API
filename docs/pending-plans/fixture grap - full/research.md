类似抓fixture的事情以后常做, 是否可以在管理端UI中补充界面一键完成?

* * *

可以，且值得做。但**作用域和触发面不止 fixture 抓取**——管理端可以做成"上游流诊断中心"，把 fixture 抓取作为其中一个入口。下面是粗略方案。

* * *

## 一、定位与边界

**核心改动**：把现在的 `KIRO_CAPTURE_RAW` 环境变量替换成**运行时可切换的全局开关**，写到内存（不持久化），UI 控制开/关 + 列出/下载/删除文件。重启即关闭，避免忘关填爆磁盘。

**适用面**：现在只有 Kiro 流特殊（AWS event-stream 二进制），但 OpenAI / Gemini / Grok 也有 SSE 截断 / 字段缺失类问题。**抓取层抽象成"上游 stream tap"**——不关心 frame 格式，原始字节落盘，让解析问题暴露在 fixture 重放阶段，而不是抓取阶段。

* * *

## 二、UI 设计

放哪里有 3 种选择：

| 位置 | 优点 | 缺点 |
| --- | --- | --- |
| **新增 section "上游抓取"** | 独立、扩展性最好 | 增 sidebar 一项 |
| **合并到 Logs section 加 tab** | 不占 sidebar 位 | Logs 已有 i18n / autoscroll 逻辑，注入会复杂化 |
| **放 Playground section 里** | 语义贴近调试 | Playground 现是发请求工具，与抓取耦合奇怪 |

**推荐第一个**，新增 sidebar 项 `<i class="fas fa-tape"></i> 上游抓取` 或类似图标。

界面布局粗草：

```
┌─ 上游抓取 ──────────────────────────────────────────┐
│ 抓取状态: [● 关闭] [启用抓取]                        │
│   作用域: ☑ kiro  ☐ openai  ☐ gemini  ☐ grok       │
│   过滤:   account [自动 ▾]    provider [全部 ▾]     │
│   存储位置: tmp-fixtures/          [打开目录]        │
│   保留策略: 最近 50 个文件 / 累计 100 MB             │
│                                                       │
│ 已抓取文件 (12)                          [全部下载] │
│ ┌────┬──────────┬─────────┬──────┬─────────┐│
│ │ 时间│ provider │ 场景标记 │ size │ 事件数│ 操作    ││
│ ├────┼──────────┼─────────┼──────┼──────┼─────────┤│
│ │…   │ kiro     │ multi-tool│54 KB │ 142  │ 下载/删 ││
│ │…   │ kiro     │ single-tool│12 KB│ 38   │ 下载/删 ││
│ └────┴──────────┴─────────┴──────┴──────┴─────────┘│
│                                                       │
│ [清空所有] [导出选中为 fixture zip]                  │
└──────────────────────────────────────────────────────┘
```

关键元素：

*   **场景标记**：抓取面板上有个文本框 "下次请求标签"，输入 `multi-tool` 后下一个请求文件名带这个 tag，方便后续整理为 fixture
*   **事件数**：抓完后做一次 `parseAwsEventStreamFrames(buf)` 试解，显示 events 数量 / remaining 字节，**直接看出新解析器对该 fixture 是否完整解析**——这是天然的回归用例校验
*   **保留策略**：上限是必须的，否则忘关 → 磁盘填满
*   **导出 zip**：选中文件直接打包，方便丢进 `tests/fixtures/` 或附在 PR

* * *

## 三、后端最小改动面

1.  **新模块** [src/ui-modules/fixture-api.js](vscode-webview://02o6oaihn1evl1rnsgsvd6sggap7dcl2ecrpvbkpb2m8s8vmtt5k/src/ui-modules/fixture-api.js)
    *   `GET /api/fixtures/status` → `{ enabled, scopes, count, totalBytes }`
    *   `POST /api/fixtures/toggle` → 切换 enabled / scopes / nextLabel
    *   `GET /api/fixtures/list` → 列文件元信息（含试解结果）
    *   `GET /api/fixtures/:id/download` → 流式下载
    *   `DELETE /api/fixtures/:id` → 删
    *   `POST /api/fixtures/clear` → 清空
2.  **新 manager** `src/ui-modules/fixture-capture.js`：内存单例，持有 `enabled` / `scopes` / `nextLabel` / 输出目录。Provider 调用 `fixtureCapture.tap('kiro', chunk, requestId)`，模块自己负责按 requestId 分文件
3.  **provider 改造**：[claude-kiro.js:2268-2270](vscode-webview://02o6oaihn1evl1rnsgsvd6sggap7dcl2ecrpvbkpb2m8s8vmtt5k/src/providers/claude/claude-kiro.js#L2268-L2270) 当前的环境变量分支替换成 `fixtureCapture.tap('kiro', chunkBuf, requestId)`。其他 provider 同样的位置加一行
4.  **frontend** `static/app/fixture-manager.js` + `static/components/section-fixtures.{html,css}` \+ sidebar 加项 + i18n 加翻译

* * *

## 四、风险与权衡

*   **磁盘**：必须有上限保护（条数 + 总字节），且重启清零是安全默认值
*   **PII**：你说不管 D，但仍建议**抓取目录默认在 gitignore 里**，避免 `git add .` 一不小心把 raw stream 提交了
*   **scope 误开**：UI 上建议默认只允许"单 provider + 单 account"的窄抓取，避免一次跑 Claude Code 抓 50 个文件
*   **试解性能**：list 接口对每个文件都跑一次解析有点重，建议**只对 < 1 MB 的文件做试解**，超过的显示 "size 过大跳过试解"
*   **当前 KIRO\_CAPTURE\_RAW 兼容**：保留环境变量作为"启动期开关"，UI 抓取作为"运行期开关"，互不干扰；UI 优先

* * *

## 五、实施成本估计

| 模块 | 行数估计 | 复杂度 |
| --- | --- | --- |
| 后端 fixture-capture.js | ~150 | 中（内存状态 + fs 写 + 上限逻辑） |
| 后端 fixture-api.js | ~100 | 低（CRUD） |
| ui-manager.js 路由接入 | ~10 | 低 |
| provider 调用点改造 | ~5 / provider | 低 |
| 前端 manager + section + i18n | ~250 | 中 |
| 测试 | ~80 | 低 |

**约 1 个工作日**。比 fixture 抓取本身的需求大，但一次到位、未来所有 provider 通用，性价比合理。

* * *

## 六、要不要现在做

**两个走向**：

1.  **轻量优先**：先按上一轮回复实施"改进点 A"（capture 改成目录语义、每请求一文件），让你今天就能抓一次 fixture 完成 round 2 验证；UI 方案作为单独 PR 后续做
2.  **一步到位**：直接做 UI 方案，跳过环境变量这一步

我的倾向是 **1**（先轻量），原因：

*   阻塞当前 PR 完成度的是 fixture 抓取本身，不是抓取流程顺手
*   UI 方案值得单独 PR，让 review 聚焦
*   改进点 A 的 5 行改动是 UI 方案的子集，先做不浪费

你倾向哪个？或者有其他放置位置 / 命名偏好？