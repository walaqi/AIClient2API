# 每账号独立浏览器指纹方案（v2 — 评审修订版）

## Context

当前项目访问上游时，所有账号共享同一个 TLS 指纹（Chrome_Auto）和相同的 User-Agent，账号隔离仅依赖代理 IP。如果上游通过 TLS 指纹 + 行为模式关联多个账号，当前方案存在风险。本方案为每个账号生成唯一且稳定的浏览器指纹，从 TLS 层到 HTTP 头全面差异化。

## 方案概览

1. 升级 uTLS 到 v1.8.2 + 扩展 Go sidecar 支持多 TLS profile
2. 新建指纹生成模块，从账号 UUID 确定性派生指纹（版本号强绑定）
3. 扩展账号配置存储指纹数据（扁平字段，非嵌套对象）
4. 修改请求包装逻辑传递指纹 + 修复 ACCOUNT_PROXY_URL 支持
5. Grok 等需要浏览器头的 provider 使用指纹数据生成一致的 sec-ch-ua 头
6. 支持指纹轮换（generation 计数器）

---

## 指纹存储 Schema（扁平字段）

每账号在 `provider_pools.json` 中新增以下顶层字段（与现有 `ACCOUNT_PROXY_URL` 等平级）：

```json
{
  "uuid": "xxx",
  "ACCOUNT_PROXY_URL": "...",
  "ACCOUNT_TLS_PROFILE": "HelloChrome_131",
  "ACCOUNT_USER_AGENT": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "ACCOUNT_BROWSER_VERSION": "131",
  "ACCOUNT_PLATFORM": "Windows",
  "ACCOUNT_PLATFORM_VERSION": "15.0.0",
  "ACCOUNT_SEC_CH_UA": "\"Google Chrome\";v=\"131\", \"Chromium\";v=\"131\", \"Not A(Brand\";v=\"24\"",
  "ACCOUNT_SEC_CH_UA_FULL_VERSION": "131.0.6778.109",
  "ACCOUNT_SEC_CH_UA_FULL_VERSION_LIST": "\"Google Chrome\";v=\"131.0.6778.109\", \"Chromium\";v=\"131.0.6778.109\", \"Not A(Brand\";v=\"24.0.0.0\"",
  "ACCOUNT_FINGERPRINT_GENERATION": 0
}
```

**设计决策（解决评审 3.1）**：使用扁平字段而非嵌套对象，与现有 `{...globalConfig, ...config}` 浅合并语义兼容。

---

## 实现步骤

### Step 1: Go Sidecar 改造 (`tls-sidecar/main.go`)

**前置：升级 uTLS 到 v1.8.2**（解决评审 1.2）
- 修改 `go.mod`: `github.com/refraction-networking/utls v1.8.2`
- 已确认 v1.8.2 包含：HelloChrome_120, HelloChrome_131, HelloChrome_133, HelloFirefox_105, HelloFirefox_120, HelloSafari_16_0, HelloEdge_106, HelloIOS_14

**改动：**

1. 新增 `profileMap`：
```go
var profileMap = map[string]utls.ClientHelloID{
    "HelloChrome_Auto":    utls.HelloChrome_Auto,    // = HelloChrome_133
    "HelloChrome_120":     utls.HelloChrome_120,
    "HelloChrome_131":     utls.HelloChrome_131,
    "HelloChrome_133":     utls.HelloChrome_133,
    "HelloFirefox_Auto":   utls.HelloFirefox_Auto,   // = HelloFirefox_120
    "HelloFirefox_120":    utls.HelloFirefox_120,
    "HelloSafari_Auto":    utls.HelloSafari_Auto,    // = HelloSafari_16_0
    "HelloEdge_106":       utls.HelloEdge_106,
}
```

2. `handleProxy` 读取并验证 `X-TLS-Profile` 头：
   - 有效值 → 使用对应 profile
   - 无头 → 默认 `HelloChrome_Auto`（向后兼容）
   - **无效值 → 返回 HTTP 400**（解决评审 1.3，避免静默降级）

3. 修改缓存 key 为 `proxyURL|profile`

4. `dialUTLS` 接受 `clientHelloID` 参数

5. **idle 回收机制**：
   - H2 连接 idle 超过 2 分钟自动关闭
   - rtCache 条目 idle 超过 5 分钟移除
   - 后台 goroutine 每 60s 扫描，监听 context cancel 实现 graceful shutdown

6. 从 `X-TLS-Profile` 头列表中剥离（不转发给上游）

### Step 2: 指纹生成模块 (新建 `src/utils/fingerprint-generator.js`)

**Profile 数据库 Schema（解决评审 2.2）**：

```javascript
const PROFILE_DATABASE = [
  {
    tlsProfile: 'HelloChrome_120',
    browserName: 'Google Chrome',
    majorVersion: '120',
    fullVersion: '120.0.6099.130',
    chromiumVersion: '120.0.6099.130',
    notABrand: { brand: 'Not A(Brand', version: '24' },
    platforms: [
      { name: 'Windows', versions: ['10.0.0', '14.0.0', '15.0.0'], arch: 'x86', bitness: '64' },
      { name: 'macOS', versions: ['13.0.0', '14.0.0'], arch: 'arm', bitness: '64' },
    ]
  },
  // ... HelloChrome_131, HelloChrome_133, HelloFirefox_120, etc.
];
```

**版本号强绑定（解决评审 2.1）**：TLS profile、UA 版本号、sec-ch-ua 版本号从同一个 profile entry 派生，不可独立选择。

**生成逻辑**：
- 输入：`uuid` + `providerType` + `generation`（默认 0）
- 种子：`SHA-256(uuid + ':' + generation)` 取前 4 字节作为 uint32（解决评审 2.3 取模偏差）
- Grok provider：只从 Chrome 系列 profile 中选择
- 其他 provider：可选全部 profile
- 平台版本号使用正确的 Chromium 映射（解决评审 2.4）：
  - Windows 10: platformVersion `"1.0.0"` ~ `"10.0.0"`
  - Windows 11: platformVersion `"13.0.0"` ~ `"15.0.0"`
  - macOS: platformVersion `"13.0.0"` ~ `"15.0.0"`

**指纹轮换（解决评审 3.2）**：
- `ACCOUNT_FINGERPRINT_GENERATION` 字段，默认 0
- 封禁时递增 generation → 自动获得新指纹
- 提供 `regenerateFingerprint(uuid, providerType, generation)` 方法

### Step 3: 账号配置扩展 (`src/utils/provider-utils.js`)

- `createProviderConfig()` 新增扁平字段：`ACCOUNT_TLS_PROFILE: ''`, `ACCOUNT_USER_AGENT: ''`, 等
- 空字符串表示未生成，触发懒加载
- `_ensureFingerprint(config, providerType)` 方法：已有值时 early return（解决评审 3.2 性能）

### Step 4: 请求包装改造

**修复 ACCOUNT_PROXY_URL 支持（解决评审 4.1）**：

`src/utils/proxy-utils.js` — `configureTLSSidecar()` 修改为：
```javascript
// 代理优先级：ACCOUNT_PROXY_URL > TLS_SIDECAR_PROXY_URL > null
const proxyUrl = (config.ACCOUNT_PROXY_DISABLED ? null :
    config.ACCOUNT_PROXY_URL?.trim()) || config.TLS_SIDECAR_PROXY_URL || null;
```

**传递 profile（解决评审 4.2）**：

`src/utils/tls-sidecar.js` — `wrapAxiosConfig` 改为 options 对象：
```javascript
wrapAxiosConfig(axiosConfig, options = {}) {
    const { proxyUrl, tlsProfile } = options;
    // ...
    if (tlsProfile) axiosConfig.headers['X-TLS-Profile'] = tlsProfile;
}
```

### Step 5: Grok 浏览器头适配 (`src/providers/grok/grok-core.js`)

`buildHeaders()` 使用账号指纹字段：
- `ACCOUNT_SEC_CH_UA` → `sec-ch-ua`
- `ACCOUNT_SEC_CH_UA_FULL_VERSION` → `sec-ch-ua-full-version`
- `ACCOUNT_SEC_CH_UA_FULL_VERSION_LIST` → `sec-ch-ua-full-version-list`
- `ACCOUNT_PLATFORM` → `sec-ch-ua-platform`
- `ACCOUNT_PLATFORM_VERSION` → `sec-ch-ua-platform-version`
- `ACCOUNT_USER_AGENT` → `user-agent`

优先级：`GROK_USER_AGENT`（手动覆盖）> `ACCOUNT_USER_AGENT`（自动生成）> 硬编码默认值

**关于 Claude provider（评审 5.1）**：Claude API 使用 `x-api-key` 认证，不检查浏览器头。只需 TLS profile 差异化（通过 sidecar 自动生效），无需修改 Claude 的 headers 逻辑。

### Step 6: 非 Sidecar 路径说明（评审 3.1）

当 sidecar 未启用时（`TLS_SIDECAR_ENABLED=false`）：
- Grok 使用 Node.js `https.Agent` + 硬编码 Chrome cipher suite
- 此路径**不做指纹差异化**，原因：sidecar 是生产必需组件，非 sidecar 路径仅用于调试/开发
- 如果未来需要，可在 Node.js 层通过 `ciphers` 参数实现有限差异化（但效果远不如 uTLS）

---

## 关键文件

| 文件 | 改动 |
|------|------|
| `tls-sidecar/go.mod` | 升级 uTLS v1.6.7 → v1.8.2 |
| `tls-sidecar/main.go` | 多 profile 支持 + idle 回收 + 400 错误处理 |
| `src/utils/fingerprint-generator.js` | **新建**，profile 数据库 + 确定性生成逻辑 |
| `src/utils/tls-sidecar.js` | wrapAxiosConfig 改为 options 对象 |
| `src/utils/proxy-utils.js` | configureTLSSidecar 修复 ACCOUNT_PROXY_URL + 传递 profile |
| `src/utils/provider-utils.js` | 账号配置新增扁平字段 |
| `src/providers/provider-pool-manager.js` | _ensureFingerprint 迁移逻辑 |
| `src/providers/grok/grok-core.js` | buildHeaders 使用指纹字段 |

---

## 迁移策略

- 懒加载：现有账号首次启动时自动生成指纹并写入 `provider_pools.json`
- 确定性：即使字段丢失，从 UUID + generation 重新生成结果一致
- 向后兼容：sidecar 无 `X-TLS-Profile` 头时默认 Chrome_Auto
- 轮换：递增 `ACCOUNT_FINGERPRINT_GENERATION` 即可获得新指纹

---

## 验证方式

### 自动化测试（解决评审第四节）

1. **单元测试** (`fingerprint-generator.test.js`)：
   - 确定性：同 UUID 多次调用结果一致
   - 唯一性：不同 UUID 产出不同指纹
   - 版本一致性：`ACCOUNT_TLS_PROFILE` 中的版本号 == `ACCOUNT_USER_AGENT` 中的版本号 == `ACCOUNT_SEC_CH_UA` 中的版本号
   - 平台一致性：platform + platformVersion + UA 三者匹配
   - Grok 约束：providerType=grok 时只产出 Chrome profile

2. **集成测试**：
   - 启动 sidecar → 发送带不同 `X-TLS-Profile` 的请求 → 验证 JA3 hash 不同
   - 发送无效 profile → 验证返回 400
   - 无 `X-TLS-Profile` 头 → 验证行为与改造前一致（回归）

3. **手动验证**：
   - 请求 https://tls.browserleaks.com/json 对比 JA3/JA4
   - 实际 Grok 请求验证不被拦截
