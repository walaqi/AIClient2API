# 上游抓取管理面板（Fixture Capture UI）— v1

## Context

承接 [docs/pending-plans/kiro protocal refine/plan.md](docs/pending-plans/kiro protocal refine/plan.md) 的 Round 2 完成（fixture 抓取已可工作，靠 `KIRO_CAPTURE_RAW=<dir>` 环境变量 + pm2 重启）。该机制有两个体感问题：

1. **流程笨**：每次抓 fixture 都得改 ecosystem 文件、`pm2 restart --update-env`、抓完再去 `--update-env` 关掉，否则磁盘会被填满
2. **不可见**：抓了哪些文件、能不能解析、要不要清理，全靠手 `ls`

[docs/pending-plans/fixture grap - full/research.md](docs/pending-plans/fixture grap - full/research.md) 提出把它做成管理端 UI 的"上游抓取"section，运行时切换 + 文件管理 + 解析体检。本计划是其 v1 实施版本。

**用户决策（已确认）**：
- 抓取范围：**仅 Kiro**，其他 provider 留 TODO 注释，未来加一行即可
- 状态持久化：**纯内存**，重启即关闭（安全默认）
- 保留策略：**50 文件 / 100 MB**，硬编码在常量里，超额按时间从老到新淘汰
- 批量导出 zip：**包含在 v1**，复用项目已有的 `adm-zip` 依赖

**保留兼容**：`KIRO_CAPTURE_RAW` 环境变量保留为"启动期开关"（适合 CLI / Docker 场景），UI 是"运行期开关"，互不干扰。如同时启用，UI 优先（环境变量分支跳过）。

---

## 关键文件

### 新增
- `src/ui-modules/fixture-capture.js` — 内存单例 manager（启用状态 / 文件列表 / 写入逻辑 / 保留策略）
- `src/ui-modules/fixture-api.js` — HTTP handler（status / toggle / list / download / delete / clear / export）
- `static/components/section-fixtures.html` — UI 骨架
- `static/components/section-fixtures.css` — 样式
- `static/app/fixture-manager.js` — 前端 manager（仿 [static/app/plugin-manager.js](static/app/plugin-manager.js)）

### 修改
- [src/services/ui-manager.js](src/services/ui-manager.js) — 注册 6 个新路由
- [src/providers/claude/claude-kiro.js](src/providers/claude/claude-kiro.js#L2229-L2276) — 用 `fixtureCapture.tap()` 包裹现有 `KIRO_CAPTURE_RAW` 分支
- [static/components/sidebar.html](static/components/sidebar.html) — 加 nav 项
- [static/app/component-loader.js](static/app/component-loader.js#L101-L114) — section 列表加一行
- [static/app/app.js](static/app/app.js#L140-L149) — `setSectionLoaders` 加一项；`init` 列表加一行
- [static/app/i18n.js](static/app/i18n.js) — 加 `nav.fixtures.*` / `fixtures.*` 两套翻译（zh-CN + en）
- [.gitignore](.gitignore) — 加 `tmp-fixtures/` 默认抓取目录（避免误提交）

---

## 实施步骤

### Step 1 — 后端 manager 单例 (`src/ui-modules/fixture-capture.js`，~150 行)

参照 [src/core/plugin-manager.js:549-598](src/core/plugin-manager.js#L549-L598) 单例模式：

```js
import { existsSync, mkdirSync, appendFileSync, readdirSync, readFileSync, statSync, unlinkSync } from 'fs';
import path from 'path';
import logger from '../utils/logger.js';
import { parseAwsEventStreamFrames } from '../providers/claude/aws-event-stream-parser.js';

const MAX_FILES = 50;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const TRIAL_PARSE_MAX_BYTES = 1024 * 1024;            // > 1MB 不试解
const CAPTURE_DIR = path.join(process.cwd(), 'tmp-fixtures');

class FixtureCaptureManager {
    constructor() {
        this.enabled = false;
        this.scopes = new Set(['kiro']);                 // v1 仅 kiro
        this.nextLabel = '';
    }

    isEnabledFor(provider) {
        return this.enabled && this.scopes.has(provider);
    }

    /** 在 provider streaming 路径调用：返回当前请求的 capture file path 或 null */
    beginRequest(provider, requestId) {
        if (!this.isEnabledFor(provider)) return null;
        if (!existsSync(CAPTURE_DIR)) mkdirSync(CAPTURE_DIR, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const label = this.nextLabel ? `-${this.nextLabel.replace(/[^a-zA-Z0-9_-]/g, '')}` : '';
        const file = path.join(CAPTURE_DIR, `${provider}-${stamp}-${requestId.substring(0, 8)}${label}.bin`);
        this.nextLabel = '';                              // 一次性 label
        return file;
    }

    tapChunk(filePath, chunkBuf) {
        if (!filePath) return;
        try { appendFileSync(filePath, chunkBuf); } catch (e) { /* ignore */ }
    }

    finishRequest() {
        this._enforceRetention();
    }

    listFiles() {
        if (!existsSync(CAPTURE_DIR)) return [];
        return readdirSync(CAPTURE_DIR)
            .filter(n => n.endsWith('.bin'))
            .map(name => {
                const full = path.join(CAPTURE_DIR, name);
                const st = statSync(full);
                const meta = { id: name, size: st.size, mtime: st.mtimeMs };
                if (st.size <= TRIAL_PARSE_MAX_BYTES) {
                    try {
                        const buf = readFileSync(full);
                        const { events, remaining } = parseAwsEventStreamFrames(buf);
                        meta.eventCount = events.length;
                        meta.remainingBytes = remaining.length;
                        meta.eventTypes = [...new Set(events.map(e => e.type))];
                    } catch (e) { meta.parseError = e.message; }
                } else { meta.skipTrialParse = true; }
                return meta;
            })
            .sort((a, b) => b.mtime - a.mtime);
    }

    deleteFile(id) {
        const safe = path.basename(id);                   // 防 path traversal
        const full = path.join(CAPTURE_DIR, safe);
        if (existsSync(full) && full.startsWith(CAPTURE_DIR + path.sep)) unlinkSync(full);
    }

    clearAll() { this.listFiles().forEach(f => this.deleteFile(f.id)); }

    getCaptureDir() { return CAPTURE_DIR; }

    _enforceRetention() {
        const files = this.listFiles();
        let total = files.reduce((s, f) => s + f.size, 0);
        const sorted = [...files].sort((a, b) => a.mtime - b.mtime);   // 老到新
        while (sorted.length > MAX_FILES || total > MAX_TOTAL_BYTES) {
            const oldest = sorted.shift();
            if (!oldest) break;
            total -= oldest.size;
            this.deleteFile(oldest.id);
        }
    }
}

const fixtureCapture = new FixtureCaptureManager();
export function getFixtureCapture() { return fixtureCapture; }
```

**安全要点**：
- `path.basename(id)` 防止 `../` 越界
- 删除前验 `full.startsWith(CAPTURE_DIR + sep)` 双保险
- `nextLabel` 仅 ASCII 安全字符

### Step 2 — 后端 HTTP handler (`src/ui-modules/fixture-api.js`，~150 行)

7 个 handler 都遵循 access-api/plugin-api 的现有 pattern（`res.writeHead + res.end`，错误返回 `{ error: { message } }`）：

| Handler | Method | Path |
|---|---|---|
| `handleGetStatus` | GET | `/api/fixtures/status` → `{ enabled, scopes, nextLabel, count, totalBytes, captureDir }` |
| `handleToggle` | POST | `/api/fixtures/toggle` body `{ enabled?, scopes?, nextLabel? }` |
| `handleList` | GET | `/api/fixtures/list` → `{ files: [...] }` |
| `handleDownload` | GET | `/api/fixtures/:id/download` 流式 |
| `handleDelete` | DELETE | `/api/fixtures/:id` |
| `handleClear` | POST | `/api/fixtures/clear` |
| `handleExportZip` | POST | `/api/fixtures/export` body `{ ids: string[] }` → `application/zip` |

`handleExportZip` 用 `import AdmZip from 'adm-zip'`（已在 [package.json:7](package.json#L7) 依赖中）：

```js
const zip = new AdmZip();
for (const id of ids) {
    const safe = path.basename(id);
    const full = path.join(fixtureCapture.getCaptureDir(), safe);
    if (existsSync(full)) zip.addLocalFile(full);
}
const buffer = zip.toBuffer();
res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': 'attachment; filename="fixtures.zip"'
});
res.end(buffer);
```

每次 toggle / delete / clear 后 `broadcastEvent('fixture_update', { ... })` 通知前端刷新（复用 [src/ui-modules/event-broadcast.js:18](src/ui-modules/event-broadcast.js#L18)）。

### Step 3 — 路由注册 ([src/services/ui-manager.js](src/services/ui-manager.js))

参照 [ui-manager.js:412-416](src/services/ui-manager.js#L412-L416) plugin toggle 的正则匹配模式，在 `handleUIApiRequests` 末尾 `return false` 之前插入：

```js
import * as fixtureApi from '../ui-modules/fixture-api.js';

// ...
if (method === 'GET' && pathParam === '/api/fixtures/status') return fixtureApi.handleGetStatus(req, res);
if (method === 'POST' && pathParam === '/api/fixtures/toggle') return fixtureApi.handleToggle(req, res);
if (method === 'GET' && pathParam === '/api/fixtures/list') return fixtureApi.handleList(req, res);
if (method === 'POST' && pathParam === '/api/fixtures/clear') return fixtureApi.handleClear(req, res);
if (method === 'POST' && pathParam === '/api/fixtures/export') return fixtureApi.handleExportZip(req, res);
const fxDownloadMatch = pathParam.match(/^\/api\/fixtures\/(.+)\/download$/);
if (method === 'GET' && fxDownloadMatch) return fixtureApi.handleDownload(req, res, decodeURIComponent(fxDownloadMatch[1]));
const fxDeleteMatch = pathParam.match(/^\/api\/fixtures\/(.+)$/);
if (method === 'DELETE' && fxDeleteMatch) return fixtureApi.handleDelete(req, res, decodeURIComponent(fxDeleteMatch[1]));
```

注意 path 前缀 `/api/fixtures/` 自动被 `isUIApiPath` 视为需鉴权（[src/utils/ui-utils.js:21-25](src/utils/ui-utils.js#L21-L25)），无需额外白名单改动。

### Step 4 — provider 接入点 ([src/providers/claude/claude-kiro.js](src/providers/claude/claude-kiro.js#L2229-L2276))

把现有 `KIRO_CAPTURE_RAW` 分支扩展为"环境变量优先 + UI 兜底"：

```js
const captureRawDir = process.env.KIRO_CAPTURE_RAW;
let captureFs = null;
let captureFilePath = null;

const { getFixtureCapture } = await import('../../ui-modules/fixture-capture.js');
const fixtureCapture = getFixtureCapture();

if (captureRawDir) {
    // 环境变量分支（兼容旧用法）
    const fsModule = await import('fs');
    captureFs = fsModule.default || fsModule;
    captureFs.mkdirSync(captureRawDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    captureFilePath = `${captureRawDir}/kiro-${stamp}-${invocationId.substring(0, 8)}.bin`;
    logger.info(`[Kiro Stream] KIRO_CAPTURE_RAW enabled, writing to ${captureFilePath}`);
} else {
    // UI 分支
    captureFilePath = fixtureCapture.beginRequest('kiro', invocationId);
    if (captureFilePath) logger.info(`[Kiro Stream] UI capture enabled, writing to ${captureFilePath}`);
}

// chunk 写入分支保留：环境变量走 captureFs.appendFileSync, UI 走 fixtureCapture.tapChunk
// （或统一改成 tapChunk(captureFilePath, chunkBuf)，因为它的实现也是 appendFileSync）
```

**简化建议**：把 chunk 写入统一交给 `fixtureCapture.tapChunk(captureFilePath, chunkBuf)`，去掉环境变量专用的 `captureFs` 局部变量。两条路径合并成一条 write 调用：

```js
if (captureFilePath) fixtureCapture.tapChunk(captureFilePath, chunkBuf);
```

请求结束（`for await` 退出后）调用一次 `fixtureCapture.finishRequest()` 触发保留策略（仅在 UI 分支有效，环境变量分支不做淘汰，让用户手动管理）。

### Step 5 — 前端 section ([static/components/section-fixtures.html](static/components/section-fixtures.html))

```html
<link rel="stylesheet" href="components/section-fixtures.css">
<section id="fixtures" class="section" aria-labelledby="fixtures-title">
    <h2 id="fixtures-title" data-i18n="fixtures.title">上游抓取</h2>

    <div class="fixtures-status-bar">
        <span class="fixtures-status-pill" id="fixturesStatusPill" data-state="off">
            <span data-i18n="fixtures.status.off">关闭</span>
        </span>
        <button class="btn btn-primary" id="toggleFixturesCaptureBtn" data-i18n="fixtures.toggle.enable">启用抓取</button>
        <input type="text" id="fixturesNextLabel" placeholder="下次请求标签 (可选)" data-i18n-placeholder="fixtures.label.placeholder" />
        <button class="btn btn-secondary" id="refreshFixturesBtn"><i class="fas fa-sync"></i></button>
    </div>

    <div class="fixtures-stats" id="fixturesStats">
        <!-- 由 JS 填充：count, totalBytes, captureDir -->
    </div>

    <div class="fixtures-table-wrap">
        <table class="fixtures-table">
            <thead>
                <tr>
                    <th><input type="checkbox" id="fixturesSelectAll" /></th>
                    <th data-i18n="fixtures.col.time">时间</th>
                    <th data-i18n="fixtures.col.name">文件名</th>
                    <th data-i18n="fixtures.col.size">大小</th>
                    <th data-i18n="fixtures.col.events">事件数</th>
                    <th data-i18n="fixtures.col.remaining">残留</th>
                    <th data-i18n="fixtures.col.types">类型</th>
                    <th data-i18n="fixtures.col.actions">操作</th>
                </tr>
            </thead>
            <tbody id="fixturesTableBody"></tbody>
        </table>
    </div>

    <div class="fixtures-bulk-actions">
        <button class="btn btn-secondary" id="exportFixturesZipBtn" data-i18n="fixtures.export">导出选中为 zip</button>
        <button class="btn btn-danger" id="clearFixturesBtn" data-i18n="fixtures.clearAll">清空所有</button>
    </div>
</section>
```

**事件数列**直接显示 `parseAwsEventStreamFrames` 的结果——这是天然的解析器回归校验。

### Step 6 — 前端 manager ([static/app/fixture-manager.js](static/app/fixture-manager.js)，~200 行)

仿 [static/app/plugin-manager.js](static/app/plugin-manager.js)：

```js
import { t } from './i18n.js';
import { showToast, apiRequest, bindOnce } from './utils.js';

export function initFixtureManager() {
    bindOnce(document.getElementById('toggleFixturesCaptureBtn'), 'click', toggleCapture, 'fixturesToggle');
    bindOnce(document.getElementById('refreshFixturesBtn'), 'click', loadFixtures, 'fixturesRefresh');
    bindOnce(document.getElementById('clearFixturesBtn'), 'click', clearFixtures, 'fixturesClear');
    bindOnce(document.getElementById('exportFixturesZipBtn'), 'click', exportZip, 'fixturesExport');
    bindOnce(document.getElementById('fixturesSelectAll'), 'change', toggleSelectAll, 'fixturesSelectAll');
}

export async function loadFixtures() { /* GET /api/fixtures/status + /list, 渲染 status pill / 统计 / 表格 */ }
async function toggleCapture() { /* POST /api/fixtures/toggle 含 nextLabel */ }
async function deleteFixture(id) { /* DELETE */ }
async function clearFixtures() { /* confirm + POST /clear */ }
async function exportZip() { /* 收集复选框选中 ids → POST /export → blob 下载 */ }
function toggleSelectAll() { /* */ }
```

订阅 SSE `fixture_update` 事件自动刷新（参照 [event-stream.js:48](static/app/event-stream.js#L48) `provider_update` 模式）。

### Step 7 — 接线（4 处小修改）

1. [static/components/sidebar.html](static/components/sidebar.html) — 在 `#logs` 之后加：
   ```html
   <a href="#fixtures" class="nav-item" data-section="fixtures" data-i18n-aria-label="nav.fixtures">
       <i class="fas fa-tape" aria-hidden="true"></i> <span data-i18n="nav.fixtures">上游抓取</span>
   </a>
   ```
2. [static/app/component-loader.js:113](static/app/component-loader.js#L113) — `sectionComponents` 数组加 `{ path: \`${basePath}section-fixtures.html\`, container: '#content-container', position: 'beforeend' }`
3. [static/app/app.js:147](static/app/app.js#L147) — `setSectionLoaders({ ..., fixtures: loadFixtures })`，`init` 列表加 `initFixtureManager();`
4. [static/app/i18n.js](static/app/i18n.js) — zh-CN + en 两段翻译加 `nav.fixtures` / `fixtures.title` / `fixtures.toggle.*` / `fixtures.col.*` / `fixtures.export` / `fixtures.clearAll` / `fixtures.label.placeholder` / `fixtures.status.{on,off}` ~15 个 key

### Step 8 — gitignore

[.gitignore](.gitignore) 加一行 `tmp-fixtures/`，防止抓取目录被 `git add .` 误提交。`tests/fixtures/kiro-stream/*.bin`（手动 curate 后的 fixture）不在 ignore 内，正确。

---

## 验证步骤

1. **后端单元**：现有 25/25 测试不受影响，跑 `npx jest --no-coverage` 应继续全绿
2. **路由可达**：起服务后 `curl -H "Authorization: Bearer $TOKEN" localhost:3000/api/fixtures/status` 返回 `{ enabled: false, ... }`
3. **UI 可用**（首跑流程）：
   - 浏览器进 `#fixtures`，状态 pill 显示「关闭」
   - 输入标签 `pure-text-2`，点「启用抓取」，pill 变「开启」
   - 用 Claude Code 发一次纯文本请求
   - 表格出现一条记录，文件名含 `pure-text-2`，事件数 > 0，残留 = 0（说明解析器仍工作）
   - 再发 3 次不同场景请求，表格累积 4 条
   - 全选 → 「导出选中为 zip」 → 浏览器下载 `fixtures.zip`，解压 4 个 .bin 完整
4. **保留策略**：临时把 `MAX_FILES = 3`，发 5 次请求，确认表格只剩最新 3 条；改回 50 提交
5. **路径越界防御**：`curl -X DELETE 'localhost:3000/api/fixtures/..%2F..%2Fpackage.json'` 应只对 `tmp-fixtures/package.json`（不存在）做 noop，不删 repo 根文件
6. **环境变量兼容**：保留 `KIRO_CAPTURE_RAW=/tmp/legacy-capture` 同时开 UI 抓取，确认走环境变量分支（日志显示 `KIRO_CAPTURE_RAW enabled`），UI 抓取被旁路
7. **重启清零**：重启服务后回 `#fixtures`，pill 自动变「关闭」（内存状态丢失，但磁盘文件仍在并被表格列出）
8. **前端 i18n**：切英文，所有按钮 / 列名 / 状态 pill 切英文文案

---

## 不在本次范围

- **多 provider tap**：v1 仅 Kiro。其他 provider 接入留 TODO 注释，未来在 14 处 streaming 入口逐个加一行 `fixtureCapture.tapChunk(...)`
- **PII 内容审查 / 脱敏**：用户已明确跳过
- **磁盘上限可配置**：硬编码 50/100MB，超出再做 UI 配置
- **抓取期间实时 events 流式预览**：抓取完后 list 接口才试解，不做实时 tail
- **多 account 过滤、provider 多选**：v1 单 provider，scope 只是 `Set(['kiro'])` 占位，UI 不暴露多选

---

## 预期收益

- 抓 fixture 流程从「改 ecosystem.config + pm2 restart --update-env + 抓 + 关掉 + 重启」**5 步降到 1 步**（UI 上点开关 + 输标签）
- 「事件数 / 残留字节」列让每次抓取就是一次解析器回归测试，**不再需要等到写 fixture 测试才发现解析问题**
- 重启自动关闭，磁盘安全
- zip 导出让 fixture 整理为 PR 资产成为一键操作
