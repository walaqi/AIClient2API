# 计划审查 — 第1轮

**计划**: 在健康检查中添加账号代理地理位置验证  
**审查日期**: 2026-05-22

---

## 总体评价

计划整体思路清晰，目标明确：在健康检查流程中增加代理出口IP的地理位置验证，确保请求通过正确的地理节点路由。方案利用了现有的 `parseProxyUrl`、`markProviderUnhealthyImmediately`、`_debouncedSave` 等基础设施，复用度较好。

**评分: 7/10** — 可行但有若干设计问题需要解决。

---

## 问题与建议

### 🔴 严重问题

#### 1. `performInitialHealthChecks` 中使用了 `markProviderUnhealthy` 而非 `markProviderUnhealthyImmediately`

计划中写的是在两个方法中都调用 `markProviderUnhealthyImmediately`，但实际代码中 `performInitialHealthChecks` 使用的是 `markProviderUnhealthy`（渐进式标记）。如果代理检查失败直接调用 `markProviderUnhealthyImmediately`，会跳过错误计数累积逻辑，与初始检查的现有行为不一致。

**建议**：在 `performInitialHealthChecks` 中使用 `markProviderUnhealthy` 保持一致性；在 `performHealthChecks` 中使用 `markProviderUnhealthyImmediately` 是合理的。

---

### 🟡 中等问题

#### 3. 重试5次的性能影响

每次健康检查如果代理地理位置不匹配，会重试5次（每次都要请求 ip-api.com）。考虑到：
- 每次请求有10秒超时
- 最坏情况下一个节点的代理检查可能耗时 60秒（初始 + 5次重试）
- 健康检查是串行执行的（`for...of` 循环）

这会严重拖慢整体健康检查流程。

**建议**：
- 将重试次数设为可配置（默认3次可能更合理）。
- 缩短超时时间到5秒（地理位置API响应通常很快）。
- 考虑将代理验证与API健康检查并行执行，或者降低代理验证频率（不必每次健康检查都验证）。

#### 4. Session 轮换的正则表达式过于宽泛

计划中的正则 `/session-([a-zA-Z0-9]+)-sessionduration/` 假设 session ID 只包含字母数字。但示例中的 `session-kiro9-sessionduration` 暗示 ID 可能很短。如果代理URL格式变化（如包含下划线或连字符），正则会失败。

**建议**：明确文档化支持的代理URL格式，并在正则不匹配时记录警告日志而非静默失败。

#### 5. 缺少对 `ACCOUNT_PROXY_DISABLED` 的说明

计划提到"check regardless of `ACCOUNT_PROXY_DISABLED`"，即使代理被禁用也要验证。这个设计决策的理由不够充分：
- 如果代理被禁用，API请求不会走代理，验证代理地理位置没有实际意义。
- 如果目的是"预验证"以便后续启用时可用，应该在注释中说明。

**建议**：重新考虑这个决策。如果 `ACCOUNT_PROXY_DISABLED === true`，应该跳过代理验证。

---

### 🟢 小问题

#### 6. 缺少日志规范

计划没有说明日志格式和级别。建议统一使用 `[ProxyGeoCheck]` 前缀，与现有的 `[ScheduledHealthCheck]` 风格一致。

#### 7. 配置字段命名

`PROXY_VALIDATE_RULES` 放在全局 `config.json` 中是合理的，但命名建议改为 `PROXY_GEO_VALIDATE_RULES` 以更明确其用途，避免与未来可能的其他代理验证规则混淆。

#### 8. 缺少单元测试计划

验证部分只描述了手动测试步骤，没有提到单元测试。`_checkAccountProxy` 和 `_rotateProxySession` 都是可独立测试的纯逻辑，应该有对应的测试用例。

---

## 架构一致性检查

| 检查项 | 结果 |
|--------|------|
| 复用现有工具函数 | ✅ `parseProxyUrl`, `_debouncedSave`, `markProviderUnhealthyImmediately` |
| 与现有健康检查流程集成点正确 | ⚠️ 需区分两个方法的标记策略 |
| 配置持久化方式一致 | ✅ 使用 `_debouncedSave` |
| 错误处理模式一致 | ✅ |
| 日志风格一致 | ⚠️ 未明确定义 |

---

## 总结

计划的核心逻辑正确，但需要重点解决：
1. **性能影响**（重试次数和超时配置化）
2. **两个健康检查方法中标记策略的一致性**

建议修订后进入第二轮审查。
