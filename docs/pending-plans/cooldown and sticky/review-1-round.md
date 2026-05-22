# 评审意见：429 Handling - Mark Unhealthy During Retry & Add 429 Rate Scoring

## 总体评价

计划对问题的诊断准确，核心逻辑链条验证无误。方案整体可行，但存在几个需要讨论的设计问题和潜在风险。

---

## 问题诊断验证 ✓

计划描述的 bug 经代码验证属实：

1. `claude-kiro.js:1920` 和 `:2508` 确认 429 错误设置了 `skipErrorCount = true`
2. 但 429 错误 **没有** 设置 `shouldSwitchCredential = true`
3. 因此 3 次重试耗尽后的执行路径：
   - `common.js:858` — `skipErrorCount=true` 导致跳过 unhealthy 标记
   - `common.js:873` — `shouldSwitchCredential=false` 导致跳过凭证切换触发
   - `common.js:879` — `credentialMarkedUnhealthy=false` 导致不进入凭证切换逻辑
   - **结果：请求直接失败，无任何恢复动作**
4. 与 `api-manager.js:284-289` 的对比正确——图片生成路径确实正确调用了 `markProviderUnhealthyWithRecoveryTime`

---

## 具体评审意见

### 1. [建议] `markProviderHealthy` 清除 `scheduledRecoveryTime` (1a)

**赞同**。当前 `markProviderHealthy` (provider-pool-manager.js:1733-1774) 确实没有清除 `scheduledRecoveryTime`。这是一个遗漏——如果账号恢复健康但 `scheduledRecoveryTime` 残留，可能在其他逻辑中产生误判。

### 2. [需讨论] 429 重试期间立即标记 unhealthy (2a 核心变更)

**这是方案最关键的变更，也是最需要讨论的点。**

计划提议：收到 429 后立即 `markProviderUnhealthyWithRecovery`，然后在同一账号上重试。

**问题**：标记 unhealthy 后，该账号从调度池移除。如果重试成功，需要调用 `markProviderHealthy` 恢复。但计划中的重试代码（递归调用 `handleStreamRequest`）在成功时的恢复路径是什么？

当前代码中，成功的请求会在哪里调用 `markProviderHealthy`？如果成功路径不会主动调 `markProviderHealthy`，那么账号只能等 `scheduledRecoveryTime` 到期后自动恢复——这意味着即使重试成功，账号也会在 cooldown 期间内不可用。

**建议**：确认成功路径是否有 `markProviderHealthy` 调用。如果没有，需要在重试成功后显式恢复。流程图中画了 `markProviderHealthy()` 但代码片段中没有体现这一步。

### 3. [风险] 重试同一个已标记 unhealthy 的账号

标记 unhealthy 后再重试同一账号，存在逻辑矛盾：
- 标记 unhealthy 的目的是让调度器不再选中该账号
- 但重试逻辑绕过调度器直接使用该账号

这本身不是 bug（因为重试是显式指定 pooluuid），但需要确认 `handleStreamRequest` 在 provider 已 unhealthy 时不会在入口处拒绝请求。

### 4. [建议] `rateLimitHits` 滑动窗口清理 (1b, 1c, 1d)

`rateLimitHits` 数组只在 `_calculateNodeScore` 中通过 `filter(t > now - 60000)` 过滤，但数组本身永远不会被清理（只 push 不 splice）。

**风险**：长时间运行后，频繁 429 的账号会积累大量过期时间戳。虽然 `filter` 保证评分正确，但内存会持续增长。

**建议**：在 `record429Hit` 中顺便清理过期条目：
```javascript
provider.state.rateLimitHits = provider.state.rateLimitHits.filter(t => t > Date.now() - 60000);
provider.state.rateLimitHits.push(Date.now());
```

### 5. [建议] 评分权重 20000 的合理性 (1d)

每次 429 增加 20000ms 权重。对比其他惩罚项：
- 使用次数：每次 10000ms
- 负载：每活跃请求 5000ms
- 序列号：每单位 1000ms

一次 429 的惩罚 = 2 次使用 = 4 个活跃请求。如果 60 秒内有 3 次 429，惩罚 60000ms。

这个权重看起来合理，但建议在注释中说明设计意图：为什么是 20000 而不是其他值。

### 6. [问题] 429 重试耗尽后的凭证切换路径 (2b)

计划中 2b 部分的条件判断：
```javascript
if (!is429) {
    // 其他错误：随机等待
}
```

但 `is429` 变量的作用域需要确认。在当前代码结构中，`is429` 在 429 处理块内定义（line 830）。如果 429 重试耗尽后 fall through 到凭证切换逻辑，`is429` 是否仍在作用域内？

从代码看 `is429` 定义在 `const is429 = Number(status) === 429;` (line 830)，与 `rateLimitRecoveryTime` 同级，应该在整个错误处理函数作用域内可见。**确认无问题**。

### 7. [缺失] Unary handler 的具体代码 (2c)

计划只说"逻辑与 Stream 完全一致，仅日志前缀改为 `[Unary Retry]`"，但没有给出具体代码。实现时需要确认 unary handler 的上下文变量名是否与 stream handler 完全一致（如 `anyDataSent` 在 unary 中可能不存在）。

### 8. [建议] `scheduledRecoveryTime` 持久化

`markProviderUnhealthyWithRecoveryTime` 设置 `scheduledRecoveryTime` 后会调用 `_debouncedSave`。如果进程重启，恢复逻辑是否能正确读取并处理这个字段？这不是本次修改引入的问题，但值得确认。

---

## 总结

| 项目 | 评价 |
|------|------|
| 问题诊断 | ✓ 准确 |
| 方案方向 | ✓ 正确 |
| 与 api-manager 一致性 | ✓ 对齐 |
| 重试成功后恢复路径 | ⚠️ 需确认 |
| 内存泄漏风险 | ⚠️ 需处理 |
| Unary 具体实现 | ⚠️ 需补充 |
| 评分权重 | ○ 合理，建议注释 |

**建议优先级**：
1. 确认重试成功后的 `markProviderHealthy` 调用路径（阻塞性问题）
2. 添加 `rateLimitHits` 数组清理逻辑
3. 补充 unary handler 的具体代码差异说明
