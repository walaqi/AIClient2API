# 每账号独立浏览器指纹方案 — 评审第二轮

**评审日期**: 2026-05-12  
**评审对象**: `/home/chris/.claude/plans/account-magical-scone.md`（v2 — 评审修订版）  
**评审结论**: 第一轮问题已全部回应，方案可进入实施。有少量实施注意事项。

---

## 一、第一轮问题解决状态

| # | 问题 | 状态 | 评价 |
|---|------|------|------|
| 1.1 | 连接池膨胀 | ✅ 已解决 | idle 回收 + graceful shutdown，设计合理 |
| 1.2 | profile 符号存在性 | ✅ 已解决 | 升级 uTLS v1.8.2，profile 列表已确认 |
| 1.3 | 无效 profile 行为 | ✅ 已解决 | 返回 HTTP 400，避免静默降级 |
| 2.1 | 版本号强绑定 | ✅ 已解决 | Profile 数据库原子条目，TLS/UA/sec-ch-ua 不可独立选择 |
| 2.2 | Profile schema 未定义 | ✅ 已解决 | 给出了完整的 PROFILE_DATABASE schema |
| 2.3 | 取模偏差 | ✅ 已解决 | 前 4 字节 uint32 取模 |
| 2.4 | 平台版本号不准确 | ✅ 已解决 | 使用正确的 Chromium 映射 |
| 3.1 | 嵌套 vs 扁平 | ✅ 已解决 | 采用扁平字段，与浅合并兼容 |
| 3.2 | 指纹轮换缺失 | ✅ 已解决 | generation 计数器 |
| 4.1 | ACCOUNT_PROXY_URL 未支持 | ✅ 已解决 | 优先级链：ACCOUNT > GLOBAL > null |
| 4.2 | 参数膨胀 | ✅ 已解决 | 改为 options 对象 |
| 5.1 | Claude provider 未覆盖 | ✅ 已解决 | 明确说明 Claude API 不检查浏览器头，只需 TLS 差异化 |
| 5.2 | platform 不一致 | ✅ 已解决 | 由 profile 数据库保证三者一致 |
| 架构 3.1 | 非 sidecar 路径 | ✅ 已解决 | 明确为调试/开发路径，不做差异化 |
| 架构 3.2 | 轮换策略 | ✅ 已解决 | generation 计数器 |
| 架构 3.3 | JA4 验证 | ⚠️ 部分 | 手动验证提到 JA3/JA4，但自动化测试只验证 JA3 hash |

---

## 二、新发现的问题

### 2.1 uTLS 升级风险（中等）

**问题**: `go.mod` 当前依赖 `cloudflare/circl v1.5.0`、`golang.org/x/crypto v0.31.0`、`golang.org/x/net v0.33.0`。utls v1.8.2 很可能要求更高版本的这些依赖（尤其是 circl，用于 post-quantum key exchange）。此外 `go.sum` 未提交到仓库。

**建议**: 
- 实施 Step 1 时先执行 `go get github.com/refraction-networking/utls@v1.8.2 && go mod tidy`
- 验证编译通过后提交 `go.sum`
- 如果 circl 升级引入 CGO 依赖或构建问题，备选方案是保持 v1.6.7 + 只使用已确认存在的 profile（HelloChrome_Auto, HelloChrome_120, HelloFirefox_Auto, HelloSafari_Auto）

### 2.2 wrapAxiosConfig 签名变更影响范围（低风险，已确认）

**确认**: `wrapAxiosConfig` 只有 1 个调用点（`proxy-utils.js:205`），所有 10 个 provider 通过 `configureTLSSidecar()` 间接调用，无直接调用。签名变更的 blast radius 完全可控。

### 2.3 ACCOUNT_PROXY_DISABLED 与 sidecar 路径的交互（低）

**问题**: 方案中 proxy 优先级逻辑：
```javascript
const proxyUrl = (config.ACCOUNT_PROXY_DISABLED ? null :
    config.ACCOUNT_PROXY_URL?.trim()) || config.TLS_SIDECAR_PROXY_URL || null;
```

当 `ACCOUNT_PROXY_DISABLED = true` 时，会 fallback 到全局 `TLS_SIDECAR_PROXY_URL`。但 `ACCOUNT_PROXY_DISABLED` 的语义是"此账号不使用代理"，应该意味着 proxyUrl = null（直连），而非 fallback 到全局代理。

**建议**: 修改为：
```javascript
let proxyUrl = null;
if (!config.ACCOUNT_PROXY_DISABLED) {
    proxyUrl = config.ACCOUNT_PROXY_URL?.trim() || config.TLS_SIDECAR_PROXY_URL || null;
}
```

### 2.4 扁平字段数量较多（低，可接受）

**观察**: 新增 8 个 `ACCOUNT_*` 字段。`provider_pools.json` 中每个账号对象会从 ~15 个字段增长到 ~23 个字段。这不是问题，但建议在 `createProviderConfig()` 中用注释分组标记（proxy 相关 / fingerprint 相关），便于维护。

### 2.5 generation 递增的触发方式未明确（低）

**问题**: 方案提到"封禁时递增 generation"，但未说明触发入口。是手动编辑 JSON？管理 API？还是自动检测封禁后递增？

**建议**: 第一版可以只支持手动（编辑 provider_pools.json 或通过管理接口），自动检测作为后续迭代。但应在方案中明确说明。

---

## 三、实施顺序建议

方案的实施顺序隐含在 Step 1-6 中，但有依赖关系值得明确：

```
Step 1 (Go sidecar)  ←── 可独立实施并验证
     ↓
Step 2 (fingerprint-generator.js)  ←── 可独立实施并单元测试
     ↓
Step 3 (provider-utils.js)  ←── 依赖 Step 2
     ↓
Step 4 (proxy-utils + tls-sidecar.js)  ←── 依赖 Step 1 完成
     ↓
Step 5 (grok-core.js)  ←── 依赖 Step 3
```

**建议**: Step 1 和 Step 2 可以并行开发（Go 和 JS 无依赖），缩短总工期。

---

## 四、遗留小项（不阻塞实施）

1. **JA4 自动化验证**: 集成测试目前只验证 JA3 hash 不同。JA4 包含 ALPN 顺序、扩展数量等额外信号。如果目标是对抗 JA4 指纹识别，建议后续补充 JA4 验证（可用 https://github.com/FoxIO-LLC/ja4 工具）。
2. **Profile 数据库维护**: Chrome 每 6 周发布新版本，profile 数据库需要定期更新。建议在代码注释中标注"最后更新日期"和"下次检查时间"。
3. **go.sum 提交**: 当前未提交 go.sum，建议在 utls 升级后一并提交，确保构建可复现。

---

## 五、结论

v2 方案质量显著提升，第一轮提出的所有 P0/P1 问题均已得到合理回应。新发现的问题均为低-中风险，不阻塞实施。

**可以开始实施**，注意：
1. Step 1 先验证 utls v1.8.2 编译通过（问题 2.1）
2. 修正 `ACCOUNT_PROXY_DISABLED` 的 fallback 逻辑（问题 2.3）
3. 明确 generation 递增的触发入口（问题 2.5）
