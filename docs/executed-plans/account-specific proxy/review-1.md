# 评审意见 — 第一轮

计划文档：`/home/chris/.claude/plans/proxy-snappy-sun.md`

---

## 总体评价

计划整体思路清晰，核心架构判断正确。利用 `deepmerge` 机制避免修改所有 provider adapter 是一个很好的设计决策。但在 UI 实现细节上存在一个关键遗漏，以及若干值得讨论的设计点。

---

## 核心假设验证

| 假设 | 验证结果 |
|------|----------|
| `deepmerge(config, selectedProviderConfig)` 会把账号字段合并进 config | ✅ 正确 — `service-manager.js:424` |
| 修改 `proxy-utils.js` 两个函数即可让所有调用点受益 | ✅ 正确 — 所有调用点都经过 `getProxyConfigForProvider` |
| `createProviderConfig` 在 `provider-utils.js:333` | ✅ 正确 |
| 7 个 poolable provider 都在 `fieldConfigs` 中有定义 | ✅ 正确 — `utils.js` 第 277-403 行 |

---

## 问题 1（阻塞）：`type: 'checkbox'` 在 modal.js 中无渲染支持

计划步骤 3b 提出给 `ACCOUNT_PROXY_DISABLED` 使用 `type: 'checkbox'`，步骤 4 也提到"若 checkbox 未支持则兜底"。

**实际情况**：`modal.js` 的 `renderProviderConfig`（展示模式，第 1076-1199 行）和新建 provider 表单（第 1689-1778 行）对"其他字段"的渲染逻辑只处理了三种情况：
1. `password` 类型（含 key/password 关键字）
2. OAuth 文件路径（含 `OAUTH_CREDS_FILE_PATH`）
3. 其他 → 一律渲染为 `<input type="${field.type}">`

如果 `field.type = 'checkbox'`，HTML 会生成 `<input type="checkbox">`，但：
- **展示模式**（`renderProviderConfig`）根本不走 `fieldConfigs` 的 type，而是按 key 名判断（password / OAuth），其余一律 `<input type="text">`，所以 checkbox 不会出现。
- **保存逻辑**（`collectDraftProviderConfig` 第 129-158 行）只处理 `input[data-config-key]`（取 `.value`）和 `select[data-config-key]`（转 boolean）。对 checkbox 的 `.checked` 属性没有处理。

**建议**：与 `checkHealth` 字段保持一致，使用 `<select>` + `true/false` 选项来实现布尔字段。这样：
- 展示模式需要在"其他字段"循环中加一个 `fieldDef.type === 'select'` 或 `fieldDef.type === 'boolean'` 的分支
- 新建模式同理
- `collectDraftProviderConfig` 已经能正确处理 `select[data-config-key]` → boolean

或者，如果确实想用 checkbox，需要在 `collectDraftProviderConfig` 中加：
```js
const configCheckboxes = providerDetail.querySelectorAll('input[type="checkbox"][data-config-key]');
configCheckboxes.forEach(cb => {
    providerConfig[cb.dataset.configKey] = cb.checked;
});
```
并在两处渲染逻辑中加 checkbox 分支。

---

## 问题 2（建议）：字段命名考量

`ACCOUNT_PROXY_URL` 和 `ACCOUNT_PROXY_DISABLED` 作为字段名可以工作，但有两点值得考虑：

1. **与现有字段命名风格不一致**：现有账号字段用的是 `KIRO_OAUTH_CREDS_FILE_PATH`、`GEMINI_BASE_URL`、`PROJECT_ID` 等——都是功能性命名，没有 `ACCOUNT_` 前缀。建议考虑 `PROXY_URL`（账号级）和 `PROXY_DISABLED`，因为在账号对象的上下文中已经隐含了"这是账号级"的语义。

2. **但有命名冲突风险**：`deepmerge` 会把账号的字段合并到全局 config 上。如果账号字段也叫 `PROXY_URL`，它会覆盖全局的 `PROXY_URL`——这恰好是我们想要的行为！但 `PROXY_DISABLED` 在全局 config 中不存在，不会冲突。

   **结论**：如果用 `PROXY_URL` 作为账号字段名，deepmerge 后 `config.PROXY_URL` 就是账号的值，`proxy-utils.js` 甚至不需要改——现有逻辑直接就能用账号的 proxy URL。这是一个更简洁的方案，但需要确认：当账号想"清空"proxy（走直连）时，空字符串 `""` 会覆盖全局的非空 `PROXY_URL`，导致 `isProxyEnabledForProvider` 返回 false（因为 `!config.PROXY_URL` 为 true）。这正好是 `PROXY_DISABLED` 想实现的效果。

   不过这个替代方案有风险：如果用户想让某个账号"不设置 proxy，走全局默认"，空字符串和"未设置"无法区分（deepmerge 会把 `""` 合并上去）。所以当前计划用 `ACCOUNT_PROXY_URL` 作为独立字段名是更安全的选择。**保持现有命名即可。**

---

## 问题 3（建议）：`isProxyEnabledForProvider` 的逻辑顺序

计划说：
> `isProxyEnabledForProvider` 要先判 `ACCOUNT_PROXY_DISABLED`（返回 false）和 `ACCOUNT_PROXY_URL`（返回 true，绕过 `PROXY_ENABLED_PROVIDERS` 白名单）

当前函数签名是 `isProxyEnabledForProvider(config, providerType)`，第一行就检查 `!config.PROXY_URL`。如果账号没设全局 `PROXY_URL` 但设了 `ACCOUNT_PROXY_URL`，需要确保不会被第一行的 early return 拦截。

建议的逻辑顺序：
```
1. if ACCOUNT_PROXY_DISABLED === true → return false
2. if ACCOUNT_PROXY_URL 非空 → return true（不检查白名单）
3. 原有逻辑（检查 PROXY_URL + PROXY_ENABLED_PROVIDERS）
```

这与计划描述一致，只是提醒实现时注意第 63 行的 `!config.PROXY_URL` 不能拦截住情况 2。

---

## 问题 4（小问题）：`createProviderConfig` 的 `ACCOUNT_PROXY_DISABLED` 默认值

计划建议在 `createProviderConfig` 中加 `ACCOUNT_PROXY_DISABLED: false`。但现有逻辑中，老账号没有这个字段时值为 `undefined`，proxy-utils 里判断 `=== true` 就不会命中。所以新建账号加不加这个默认值都行。

但加了有一个好处：UI 编辑时 select 能正确回显"禁用"状态。如果不加，老账号编辑时 select 的值会是 `undefined`，需要在渲染时做 fallback。**建议保留，但同时确保 UI 渲染对 undefined 做 fallback 处理。**

---

## 问题 5（遗漏）：编辑模式的字段渲染

计划只提到了"展示模式"（`renderProviderConfig`）和"新建模式"的字段渲染。但 modal.js 还有一个**编辑模式**（点击编辑按钮后，字段从 readonly 变为可编辑）。需要确认编辑模式下 `ACCOUNT_PROXY_DISABLED` 的 select/checkbox 也能正确切换为可编辑状态。

查看 `modal.js:1322-1323`，编辑模式通过 `querySelectorAll('input[data-config-key]')` 和 `querySelectorAll('select[data-config-key]')` 来解除 readonly/disabled。如果用 select 方案，需要确保 select 元素带有 `data-config-key` 属性且初始为 `disabled`，编辑时解除——与 `checkHealth` 的处理方式一致。

---

## 验证计划补充建议

计划的验证步骤覆盖了主要场景，建议补充：

- **并发场景**：两个请求同时命中同一 provider 的不同账号（一个有 ACCOUNT_PROXY_URL，一个没有），确认互不干扰（因为 deepmerge 每次生成新 serviceConfig，应该没问题，但值得确认）。
- **TLS Sidecar 交互**：`proxy-utils.js` 还有 `configureTLSSidecar` 逻辑。当账号设了 `ACCOUNT_PROXY_URL` 且同时启用了 TLS Sidecar 时，两者的优先级关系需要明确（当前代码中 TLS Sidecar 有自己的 `TLS_SIDECAR_PROXY_URL`，与 `PROXY_URL` 是独立的，但需确认不会冲突）。

---

## 总结

| 类别 | 数量 |
|------|------|
| 阻塞问题 | 1（checkbox 渲染/保存不支持） |
| 设计建议 | 4 |
| 验证补充 | 2 |

核心方案（利用 deepmerge + 只改 proxy-utils）是正确的，改动量小且风险可控。解决 UI 渲染问题后即可实施。
