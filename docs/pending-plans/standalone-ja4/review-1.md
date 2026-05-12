# 每账号独立浏览器指纹方案 — 评审第一轮

**评审日期**: 2026-05-12  
**评审对象**: `/home/chris/.claude/plans/account-magical-scone.md`  
**评审结论**: 方案方向正确，有若干设计问题需要在实施前解决

---

## 一、总体评价

方案目标清晰，分层合理（Go sidecar → 指纹生成 → 配置存储 → 请求包装 → Provider 适配），覆盖了从 TLS 层到 HTTP 头的完整链路。确定性派生（SHA-256 from UUID）是正确的设计选择，保证了幂等性和可恢复性。

主要风险集中在两个方面：**sidecar 与 Node 侧的 proxy 路径不一致**、**指纹一致性验证缺乏自动化**。（连接池问题已在修订中解决）

---

## 二、逐步评审

### Step 1: Go Sidecar 改造

#### 优点
- `X-TLS-Profile` 头选择 profile 的设计简洁，向后兼容（无头时默认 Chrome_Auto）
- 缓存 key 改为 `proxyURL|profile` 是必要的

#### 问题

| # | 严重度 | 问题 | 建议 |
|---|--------|------|------|
| 1.1 | ~~高~~ **已解决** | ~~缓存 key 改为 `proxyURL\|profile` 后连接数膨胀~~ 方案已补充 idle 回收机制（H2 连接 idle 2min 关闭、rtCache 条目 idle 5min 移除、60s 扫描 goroutine）及连接数评估（实际连接数 = 活跃账号数）。设计合理。 | ~~增加 maxIdleConnsPerHost 限制~~ **小建议**: 扫描 goroutine 应在 graceful shutdown 时退出（监听 context cancel），避免 sidecar 关闭时 goroutine 泄漏 |
| 1.2 | **中** | 方案列出的 profile 列表（Chrome 120/131/133, Firefox 105/120, Safari 16, Edge 106, iOS 14）需要实际验证。utls v1.6.7 的 `HelloChrome_131` 和 `HelloChrome_133` 是否真实存在？utls 的版本号命名不总是连续的 | 实施前用 `go doc` 或源码确认 `utls.HelloChrome_131` 等符号存在；若不存在需降级到 `HelloChrome_120` + `HelloChrome_Auto` |
| 1.3 | **低** | `X-TLS-Profile` 头如果传入无效值（拼写错误），当前方案未说明行为 | 建议无效 profile 时返回 400 而非 fallback，避免静默降级导致排查困难 |

### Step 2: 指纹生成模块

#### 优点
- 纯函数 + 确定性派生，可测试性好
- Grok 限定 Chrome 系列是正确的约束（Grok 检测非 Chrome 指纹）

#### 问题

| # | 严重度 | 问题 | 建议 |
|---|--------|------|------|
| 2.1 | **高** | UA 字符串中的 Chrome 版本号必须与 TLS profile 的 ClientHello 特征一致。例如 `HelloChrome_120` 的 ClientHello 对应 Chrome 120 的 cipher suite 顺序和扩展，如果 UA 写 Chrome 131 就会产生不一致，反而更容易被检测 | 指纹生成模块必须将 TLS profile 版本号与 UA/sec-ch-ua 版本号绑定为一个原子单元，不能独立选择 |
| 2.2 | **中** | 方案说"profile 数据库内置在此模块中"，但未定义数据结构。每个 profile 需要包含：TLS profile name、对应的 Chrome/Firefox 大版本号、完整 UA 模板、sec-ch-ua 模板、支持的平台列表。这是一个非平凡的数据集 | 建议先定义 profile 数据的 schema，再填充数据。可参考 [AnyScript/browser-fingerprint](https://github.com/nicedoc/browser-fingerprint) 等开源项目 |
| 2.3 | **中** | SHA-256(UUID) 选择 profile 的分布均匀性依赖于 profile 数量。8 个 profile 时 `hash[0] % 8` 分布足够均匀，但如果 Grok 限定只有 3 个 Chrome profile，`hash[0] % 3` 会有轻微偏差（256 不能被 3 整除） | 使用 rejection sampling 或取 hash 的前 4 字节作为 uint32 再取模，偏差可忽略 |
| 2.4 | **低** | 平台版本范围 "Windows 10 (版本 10.0.0-19.0.0)" 不太准确。Windows 10 的 `platformVersion` 在 sec-ch-ua-platform-version 中报告为 `"1.0.0"` 到 `"10.0.0"`，Windows 11 从 `"13.0.0"` 开始 | 参考 Chromium 源码中 `GetPlatformVersion()` 的实际映射 |

### Step 3: 账号配置扩展

#### 优点
- 利用现有 `createProviderConfig()` 扩展点，改动最小化
- 持久化自动继承（`_flushPendingSaves` 会写入所有 config 字段）

#### 问题

| # | 严重度 | 问题 | 建议 |
|---|--------|------|------|
| 3.1 | **中** | 方案将 `browserFingerprint` 作为嵌套对象存入 config。当前 config 是扁平结构（所有字段都是顶层 key），引入嵌套对象可能与 `{...globalConfig, ...config}` 的浅合并语义冲突 | 要么保持扁平（`ACCOUNT_TLS_PROFILE`、`ACCOUNT_USER_AGENT` 等独立字段），要么确认合并逻辑对嵌套对象的处理正确 |
| 3.2 | **低** | `_ensureFingerprint` 在 `initializeProviderStatus()` 中执行，意味着每次启动都会遍历所有账号。对于大量账号（100+）这是否有性能影响？ | 影响应该很小（SHA-256 很快），但建议加 early return（已有指纹时跳过） |

### Step 4: 请求包装改造

#### 问题

| # | 严重度 | 问题 | 建议 |
|---|--------|------|------|
| 4.1 | **高** | 当前 `configureTLSSidecar()` 使用全局 `config.TLS_SIDECAR_PROXY_URL`，完全忽略 `config.ACCOUNT_PROXY_URL`。方案未提及修复这个已有 bug。如果账号 A 有独立代理但 sidecar 仍用全局代理，指纹隔离就不完整 | 本方案应同时修复：`configureTLSSidecar` 优先使用 `config.ACCOUNT_PROXY_URL`（如果非空且未 disabled），否则 fallback 到全局 |
| 4.2 | **中** | `wrapAxiosConfig(config, proxyUrl, tlsProfile)` 的第三参数设计可以工作，但调用链较长（provider → proxy-utils → tls-sidecar）。如果未来有更多 sidecar 控制头（如 HTTP 版本偏好），参数会膨胀 | 考虑传入 options 对象 `{ proxyUrl, tlsProfile }` 而非位置参数，便于扩展 |

### Step 5: Grok 浏览器头适配

#### 优点
- 保留 `GROK_USER_AGENT` 手动覆盖是正确的（用户可能需要 pin 特定 UA）
- Fallback 到硬编码值保证兼容

#### 问题

| # | 严重度 | 问题 | 建议 |
|---|--------|------|------|
| 5.1 | **中** | 方案只提到 Grok provider，但探索发现 Claude provider (`Claude-core.js`) 也有完全相同的硬编码 sec-ch-ua 头问题。是否应该同步改造？ | 如果 Claude provider 也走 sidecar，应该一并适配；否则说明为何排除 |
| 5.2 | **低** | `buildHeaders()` 中 `sec-ch-ua-platform-version` 当前硬编码为 `"19.0.0"`（Windows 11 最新），如果指纹选择了 macOS 平台但 platform-version 仍是 Windows 格式，会产生矛盾 | 指纹生成模块需要保证 platform + platformVersion + UA 三者一致 |

---

## 三、架构层面的遗漏

### 3.1 非 Sidecar 路径未覆盖

当 sidecar 未启用时，Grok 使用 Node.js 原生 `https.Agent` + 硬编码 cipher suite（Chrome 136）。方案未说明非 sidecar 路径是否也需要指纹差异化。如果不需要，应明确说明原因（例如"非 sidecar 路径仅用于开发环境"）。

### 3.2 指纹轮换策略缺失

确定性派生意味着指纹永不变化。如果某个指纹被上游标记/封禁，没有轮换机制。建议：
- 在 UUID 后附加 `generation` 计数器：`SHA-256(UUID + generation)`
- 封禁时递增 generation 即可获得新指纹
- 或者提供手动 `resetFingerprint` 命令

### 3.3 JA4 vs JA3

方案标题提到 JA4，但验证方式（Step 5 in plan）只验证 JA3 hash。JA4 包含更多信号（TLS 版本、SNI、ALPN 顺序等）。如果目标是对抗 JA4 检测，验证也应覆盖 JA4。

---

## 四、验证方案补充建议

方案中的验证方式（browserleaks.com）适合手动验证，但缺乏自动化：

1. **单元测试**: 指纹生成模块的确定性、一致性、版本号匹配
2. **集成测试**: 启动 sidecar → 发送带不同 `X-TLS-Profile` 的请求 → 验证返回的 JA3/JA4 不同
3. **回归测试**: 无 `X-TLS-Profile` 头时行为与改造前一致
4. **一致性检查**: 自动验证 UA 版本号 == TLS profile 版本号 == sec-ch-ua 版本号

---

## 五、优先级排序

如果需要分阶段实施，建议顺序：

1. **P0 — 必须在实施前解决**: 1.2（确认 profile 存在）、2.1（版本号一致性绑定）、3.1（嵌套 vs 扁平）、4.1（account proxy 修复）
2. **P1 — 实施中解决**: 2.2（profile schema）、5.1（Claude provider）
3. **P2 — 后续迭代**: 3.2（轮换策略）、1.3（无效 profile 处理）、2.3（取模偏差）
4. **已解决**: ~~1.1（连接池限制）~~ — 方案已补充 idle 回收 + 连接数评估

---

## 六、结论

方案整体可行，核心设计（确定性派生 + sidecar profile 选择 + 配置自动持久化）是正确的。主要需要补充：

1. TLS profile 版本号与 HTTP 头版本号的强绑定机制
2. `configureTLSSidecar` 对 `ACCOUNT_PROXY_URL` 的支持
3. 嵌套对象 vs 扁平字段的决策
4. 自动化验证方案

建议修订方案后进入第二轮评审。
