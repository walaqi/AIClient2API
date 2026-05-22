# 计划审查 — 第2轮

**计划**: 在健康检查中添加账号代理地理位置验证  
**审查日期**: 2026-05-22  
**基于**: 计划已采纳第1轮大部分建议后的修订版

---

## 修订确认

第1轮提出的问题已在计划中修正：
- ✅ 配置字段改名为 `PROXY_GEO_VALIDATE_RULES`
- ✅ `performInitialHealthChecks` 使用 `markProviderUnhealthy`（渐进式）
- ✅ `ACCOUNT_PROXY_DISABLED === true` 时跳过验证
- ✅ 超时缩短为5秒
- ✅ 日志前缀统一为 `[ProxyGeoCheck]`
- ✅ `_rotateProxySession` 正则不匹配时记录警告并返回 `null`

---

## 第2轮新发现

### 🟡 中等问题

#### 1. `_rotateProxySession` 返回 `null` 时的处理未定义

计划说明正则不匹配时返回 `null`，但 `_checkAccountProxy` 的重试逻辑中没有说明收到 `null` 后如何处理。如果代理URL不含 session 模式：
- 重试没有意义（每次都会返回 `null`）
- 应该立即终止重试，返回当前地理位置不匹配的失败结果

**建议**：在 `_checkAccountProxy` 中，如果 `_rotateProxySession` 返回 `null`，立即跳出重试循环并返回失败。

#### 2. 首次检查与重试的计数语义不清

计划说"retry up to 5 times"，但初始请求算不算在内？
- 如果初始请求 + 5次重试 = 总共6次请求
- 如果初始请求算第1次 = 总共5次请求

对 ip-api.com 的请求总数影响速率限制（45次/分钟）。

**建议**：明确为"初始检查1次 + 最多N次轮换重试"，建议 N=5（总共6次请求）。

#### 3. 多节点共享同一代理URL时的重复验证

如果多个 provider 节点配置了相同的 `ACCOUNT_PROXY_URL`，每个节点都会独立执行代理验证。这意味着：
- 相同代理被重复检测（浪费 ip-api.com 配额）
- 如果第一个节点轮换了 session，后续节点仍用旧URL开始检测

当前架构下这不是阻塞问题（每个节点独立管理自己的 `ACCOUNT_PROXY_URL` 副本），但值得在实现时加一个短期缓存：同一个代理URL在同一轮健康检查中只验证一次。

**建议**：可作为后续优化，不阻塞当前实现。但建议在代码中留 TODO 注释。

#### 4. `parseProxyUrl` 返回 `null` 时的处理

如果 `ACCOUNT_PROXY_URL` 非空但格式无效（如 `"invalid-url"`），`parseProxyUrl` 会返回 `null`。计划中没有说明这种情况的处理。

**建议**：在 `_checkAccountProxy` 中，如果 `parseProxyUrl` 返回 `null`，应返回 `{ success: false, errorMessage: "Invalid ACCOUNT_PROXY_URL format" }`。

---

### 🟢 小问题

#### 5. axios 导入方式

当前文件中 axios 使用动态 `import()`（line 735）。新代码也应使用相同的动态导入方式，避免在文件顶部添加静态 import（保持一致性）。

#### 6. 轮换后的 URL 持久化时机

计划说在 `_checkAccountProxy` 内部直接修改 `providerConfig.ACCOUNT_PROXY_URL` 并调用 `_debouncedSave`。但如果后续的 `_checkProviderHealth` 失败了，节点会被标记为 unhealthy，此时已经保存了新的代理URL。这是正确行为（代理URL本身是有效的，只是API不可用），但应确认这是预期的。

**确认**：这是正确的——代理验证通过说明代理本身工作正常，API健康检查失败是独立问题，不应回滚代理URL。

---

## 实现就绪度评估

| 维度 | 状态 | 说明 |
|------|------|------|
| 需求清晰度 | ✅ | 目标、规则、流程都已明确 |
| 集成点 | ✅ | 两个健康检查方法的插入位置和标记策略已区分 |
| 边界情况 | ⚠️ | 需补充 `_rotateProxySession` 返回 null 和 `parseProxyUrl` 返回 null 的处理 |
| 可测试性 | ✅ | `_rotateProxySession` 是纯函数，`_checkAccountProxy` 可通过 mock axios 测试 |
| 性能影响 | ✅ | 5秒超时，最坏30秒/节点，可接受 |

---

## 总结

计划已接近实现就绪。需要补充的两个边界情况处理：
1. `_rotateProxySession` 返回 `null` → 立即终止重试
2. `parseProxyUrl` 返回 `null` → 返回格式错误失败

这两个修正很小，可以在实现时直接处理，不需要第三轮审查。

**建议**：通过审查，可进入实现阶段。
