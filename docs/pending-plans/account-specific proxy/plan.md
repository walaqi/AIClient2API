# 每账号独立 Proxy 支持

## Context

当前系统只能按 provider **类型**配置全局代理（[configs/config.json:70-75](configs/config.json#L70-L75) 的 `PROXY_URL` + `PROXY_ENABLED_PROVIDERS`）。同一 provider 下的所有账号必须共享同一个出口，账号池里没有 proxy 字段（见 [docs/pending-plans/account-specific proxy/cr.md](docs/pending-plans/account-specific%20proxy/cr.md)）。

何夕要求账号可以各自走不同代理或强制直连。已确认决策：账号级覆盖全局；支持账号级显式禁用；UI 同步；字段命名 `ACCOUNT_PROXY_URL` + `ACCOUNT_PROXY_DISABLED`；覆盖所有 poolable providers（Kiro / Gemini CLI / Codex / Qwen / Antigravity / iFlow / Grok Web）。

评审意见（[docs/pending-plans/account-specific proxy/review-1.md](docs/pending-plans/account-specific%20proxy/review-1.md)）已采纳：布尔字段改 select（避免 checkbox 渲染/保存链断裂）；`isProxyEnabledForProvider` 要注意早返回陷阱。

## 行为真值表（精确规范）

设 `A` = 账号的 `ACCOUNT_PROXY_URL`（非空字符串）；`D` = 账号的 `ACCOUNT_PROXY_DISABLED === true`；`G` = 全局 `PROXY_URL` 非空且 provider 在 `PROXY_ENABLED_PROVIDERS` 白名单内。

| 场景 | D | A | G | 结果 |
|------|---|---|---|------|
| 账号显式禁用（优先级最高） | ✅ | 任意 | 任意 | **不走代理** |
| 账号有 proxy，未禁用 | ❌/缺 | ✅ | 任意 | **走 A（账号代理）** |
| 账号无 proxy，未禁用，全局启用 | ❌/缺 | ❌ | ✅ | **走全局代理** |
| 账号无 proxy，未禁用，全局未启用 | ❌/缺 | ❌ | ❌ | **不走代理** |

**关键点**：
1. `D` 优先级最高——哪怕账号和全局都配了 proxy，只要 `D=true` 就直连。
2. `A` 非空时**绕过** `PROXY_ENABLED_PROVIDERS` 白名单——账号显式声明走代理即走。
3. 空字符串 `""` 视同未设置；`undefined`/`null` 同样视同未设置。老账号没这两个字段按"未设置"处理，行为与改造前完全一致。

## 核心架构利好

**不用改 provider adapter**。[src/services/service-manager.js:424](src/services/service-manager.js#L424) 已经 `deepmerge(config, selectedProviderConfig)`，账号字段会自动合并到传给 adapter 的 config。所有 10+ 个 proxy-utils 调用点都透明受益。

核心改动集中在 **proxy-utils.js 一处** + **账号默认 schema** + **UI 一处**。

## 实施步骤

### 1. 修改 proxy-utils.js 的优先级逻辑

文件：[src/utils/proxy-utils.js](src/utils/proxy-utils.js)

**问题**：当前 `isProxyEnabledForProvider` 第 63 行 `if (!config || !config.PROXY_URL || !config.PROXY_ENABLED_PROVIDERS) return false;` 会拦截"全局没代理但账号有代理"的场景。必须在这之前处理账号级。

**改造后 `isProxyEnabledForProvider(config, providerType)` 的逻辑顺序**：

```
1. if !config → return false
2. if config.ACCOUNT_PROXY_DISABLED === true → return false     // 场景 1
3. if config.ACCOUNT_PROXY_URL 是非空字符串 → return true         // 场景 2（绕过白名单）
4. if !config.PROXY_URL 或 !config.PROXY_ENABLED_PROVIDERS → return false
5. 原有白名单匹配（精确/前缀）→ return 结果
```

**改造后 `getProxyConfigForProvider(config, providerType)`**：

```
1. if !isProxyEnabledForProvider(config, providerType) → return null
2. 决定使用哪个 URL：
   - 若 config.ACCOUNT_PROXY_URL 非空 → 用这个（source = 'account')
   - 否则 → 用 config.PROXY_URL（source = 'global'）
3. parseProxyUrl(chosenUrl)
4. 日志里带上 source 标签，例如
   logger.info(`[Proxy] Using ${proxyType} proxy (${source}) for ${providerType}: ${url}`);
5. return proxyConfig
```

这两处改动就让所有调用点（`configureAxiosProxy` / `getGoogleAuthProxyConfig` / codex-core.js 里的 3 处等）自动走新逻辑，**无需逐个修改 adapter**。

### 2. 账号 schema 默认字段

文件：[src/utils/provider-utils.js](src/utils/provider-utils.js) 的 `createProviderConfig`（第 333 行）

在 `newProvider` 初始化对象中追加：

```js
ACCOUNT_PROXY_URL: '',
ACCOUNT_PROXY_DISABLED: false,
```

空字符串和 false 就是"未设置"，新旧账号行为一致。老账号读出是 `undefined`，proxy-utils 里用 `=== true` 和 `typeof === 'string' && xxx.length > 0` 严格判断，不会误命中。

### 3. UI 字段定义与渲染

**3a. 字段标签** — [static/app/utils.js](static/app/utils.js) 第 184-225 行 `getFieldLabel` 的 `labelMap`：

```js
'ACCOUNT_PROXY_URL': t('modal.provider.field.accountProxyUrl'),
'ACCOUNT_PROXY_DISABLED': t('modal.provider.field.accountProxyDisabled'),
```

**3b. 字段定义** — [static/app/utils.js](static/app/utils.js) 第 232 行 `getProviderTypeFields` 的 `fieldConfigs`。采纳 review-2 建议 6，抽成一个共享变量避免 7 份重复：

```js
// 在 getProviderTypeFields 函数顶部声明
const accountProxyFields = [
    {
        id: 'ACCOUNT_PROXY_URL',
        label: `${t('modal.provider.field.accountProxyUrl')} <span class="optional-tag">${t('config.optional')}</span>`,
        type: 'text',
        placeholder: 'socks5://host:port 或 http://host:port（留空走全局）'
    },
    {
        id: 'ACCOUNT_PROXY_DISABLED',
        label: `${t('modal.provider.field.accountProxyDisabled')} <span class="optional-tag">${t('config.optional')}</span>`,
        type: 'boolean',            // 采用 select 方案，避开 checkbox 渲染/保存断裂
        placeholder: ''
    }
];
```

然后在 7 个 poolable provider（`claude-kiro-oauth`、`gemini-cli-oauth`、`openai-qwen-oauth`、`gemini-antigravity`、`openai-iflow`、`openai-codex-oauth`、`grok-web`）的数组末尾 `...accountProxyFields`。未来新增 poolable provider 时一处维护。

**3c. i18n** — [static/app/i18n.js](static/app/i18n.js) 中英文两段：
- zh: `modal.provider.field.accountProxyUrl` = '账号代理 URL'，`modal.provider.field.accountProxyDisabled` = '强制禁用代理'
- en: 'Account Proxy URL' / 'Disable Proxy (force direct)'

### 4. modal.js 渲染布尔字段（review-1 阻塞问题）

文件：[static/app/modal.js](static/app/modal.js)

**放弃 `type: 'checkbox'`**。review-1 确认 checkbox 在 `renderProviderConfig`（展示模式 1076-1199 行）、新建表单（1689-1778 行）和 `collectDraftProviderConfig`（129-158 行）三处都不支持。

**采用 `type: 'boolean'` + select 方案**（与 `checkHealth` 同形态，见 [static/app/modal.js:1040-1050](static/app/modal.js#L1040)）。需要在 **4 个精确位置**新增 `else if (fieldDef.type === 'boolean')` 分支（review-2 指出行号）：

| 位置 | 行号 | 上下文 |
|------|------|--------|
| 展示模式 field1 | [static/app/modal.js:1125](static/app/modal.js#L1125) | `else {` 之前加 boolean 分支 |
| 展示模式 field2 | [static/app/modal.js:1187](static/app/modal.js#L1187) | 同上 |
| 新建模式 field1 | [static/app/modal.js:1725](static/app/modal.js#L1725) | `} else {` 之前 |
| 新建模式 field2 | [static/app/modal.js:1768](static/app/modal.js#L1768) | 同上 |

每处渲染为：

```html
<select class="form-control" data-config-key="${fieldKey}" data-config-value="${actualValue}" disabled>
    <option value="false" ${!actualValue ? 'selected' : ''}>否</option>
    <option value="true" ${actualValue ? 'selected' : ''}>是</option>
</select>
```

**值 fallback**（review-2 建议 4）：兼容 `undefined` / `false` / `'false'` / `true` / `'true'` 五种输入：

```js
const actualValue = provider[fieldKey] === true || provider[fieldKey] === 'true';
```

- 初始 `disabled`，编辑模式通过现有的 `querySelectorAll('select[data-config-key]')` 解除（[static/app/modal.js:1322-1323](static/app/modal.js#L1322)）。
- `collectDraftProviderConfig` 第 143-146 行已经把 `select.value === 'true'` 转成 boolean，**无需改**。
- 新建模式下 value 默认为 `false`，渲染"否"被选中。

这样布尔字段形态与 `checkHealth` 完全一致，链路闭合。

### 5. 兼容性与健康检查路径

**PoolManager 的 refresh 路径**：[src/providers/provider-pool-manager.js:469-473](src/providers/provider-pool-manager.js#L469) 用 `{...this.globalConfig, ...config}` 构造 tempConfig 传给 adapter。注意这是 **spread 浅合并**，不同于 service-manager 的 `deepmerge`。由于 `ACCOUNT_PROXY_URL`（字符串）和 `ACCOUNT_PROXY_DISABLED`（boolean）都是扁平值，浅/深合并行为一致——本次改动安全。（review-2 建议 5：未来若把账号字段扩展为嵌套对象，需要把这里也改成 deepmerge。）

**Auth 模块的 OAuth 设备流**（首次登录添加新账号，如 [src/auth/kiro-oauth.js:69](src/auth/kiro-oauth.js#L69)、[src/auth/qwen-oauth.js:39](src/auth/qwen-oauth.js#L39)、[src/auth/iflow-oauth.js:51](src/auth/iflow-oauth.js#L51)、[src/auth/codex-oauth.js:82](src/auth/codex-oauth.js#L82)）：这些路径用模块级全局 CONFIG。review-2 明确确认**不需要修改**——在 OAuth 设备流执行时账号**尚未存在**于号池中，没有账号级 config 可读；此时走全局 proxy 是唯一合理选择。未来批量添加账号的 JSON 导入功能（用户已规划）可以在导入对象中直接携带 `ACCOUNT_PROXY_URL` / `ACCOUNT_PROXY_DISABLED`，无缝落入池里后自动生效。

**正常运行时的 token refresh**：走 adapter → `_doTokenRefresh` → `this.axiosInstance`，`this.axiosInstance` 是 [src/providers/claude/claude-kiro.js:633](src/providers/claude/claude-kiro.js#L633) 之类调用 `configureAxiosProxy(axiosConfig, this.config, ...)` 创建的，`this.config` 是 deepmerge 后的账号级 config。✅ 自动受益。

## 关键文件清单

- [src/utils/proxy-utils.js](src/utils/proxy-utils.js) — 核心优先级逻辑
- [src/utils/provider-utils.js](src/utils/provider-utils.js) — 新账号 schema
- [static/app/utils.js](static/app/utils.js) — UI 字段定义 / labelMap
- [static/app/i18n.js](static/app/i18n.js) — 双语文案
- [static/app/modal.js](static/app/modal.js) — 新增 `type: 'boolean'` 渲染分支（展示模式 + 新建模式）

**无需修改**：所有 provider adapter（claude-kiro.js、gemini-core.js、codex-core.js、qwen-core.js 等）、[src/services/service-manager.js](src/services/service-manager.js)、[src/providers/provider-pool-manager.js](src/providers/provider-pool-manager.js)。

## 验证计划

对照真值表 4 个场景逐一验证（用 Kiro 账号）：

1. **场景 1（账号禁用优先）**：全局 PROXY_URL 有值且 `PROXY_ENABLED_PROVIDERS` 含 `claude-kiro-oauth`；某账号设 `ACCOUNT_PROXY_DISABLED=true`（`ACCOUNT_PROXY_URL` 可留空或有值均可）。发 chat 请求 → 日志**不应**出现 `[Proxy] Using ...`；请求直连。
2. **场景 2a（账号代理覆盖全局）**：全局有代理 A，账号设 `ACCOUNT_PROXY_URL` 为代理 B，`ACCOUNT_PROXY_DISABLED` 空/false。发请求 → 日志 `[Proxy] Using ... (account) for claude-kiro-oauth: B`。
3. **场景 2b（全局无代理，账号有代理）**：清空全局 `PROXY_URL` 或把 kiro 移出 `PROXY_ENABLED_PROVIDERS`；账号设 `ACCOUNT_PROXY_URL`。发请求 → 日志 `[Proxy] Using ... (account) ...`。这一条重点验证 review-1 建议 3 提到的 early-return 陷阱已修复。
4. **场景 3（落回全局）**：账号两字段都空；全局正常。发请求 → 日志 `[Proxy] Using ... (global) ...`（或现有格式），行为与改造前一致。
5. **场景 4（都没配）**：账号字段空 + 全局也没代理/白名单。发请求 → 直连，无 `[Proxy] Using` 日志。
6. **UI 往返**：打开账号编辑弹窗 → 两字段可见；切换"强制禁用代理"为"是"、填写代理 URL → 保存；查看 [configs/provider_pools.json](configs/provider_pools.json) 该账号出现 `ACCOUNT_PROXY_URL` 与 `ACCOUNT_PROXY_DISABLED: true`；重新打开弹窗值回显正确。
7. **老账号零迁移**：未升级的老账号（手写 JSON 不含这两字段）直接运行，行为等同场景 3 或 4，无报错、无额外日志。
8. **并发**：两个请求同时命中同一 provider 下两个不同账号（一个有 `ACCOUNT_PROXY_URL`、一个没有）→ 互不干扰（deepmerge 每次生成新 serviceConfig，天然隔离，但通过压测确认）。
9. **TLS Sidecar 无冲突**：`TLS_SIDECAR_PROXY_URL` 路径独立于 `PROXY_URL`，不读 `ACCOUNT_PROXY_URL`；确认账号级 proxy 开启后 TLS Sidecar 功能不受影响（若启用了 sidecar，测一个简单请求）。
10. **PROXY_ENABLED_PROVIDERS 缺失 edge case**（review-2 建议 7）：全局 config 完全没有 `PROXY_ENABLED_PROVIDERS` 字段（不是空数组，而是字段本身不存在），账号设 `ACCOUNT_PROXY_URL`，确认不抛异常且请求能正常走账号级代理。

测试命令：`npm start` → 浏览器操作 UI → 发 chat → `tail -f logs/*.log | grep -E "\[Proxy\]|\[Kiro\]"`。
