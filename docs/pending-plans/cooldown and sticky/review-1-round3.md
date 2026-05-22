# 评审意见 第三轮：429 Handling - 实现状态核查与残留问题

## 重要发现：计划已大部分实现

commit `8ea3e08`（"修复提供商池管理三项问题: CONFIG同步、凭据删除清理、429重试逻辑"）已经实现了计划中的绝大部分内容。

### 已实现清单

| 计划项 | 状态 | 当前代码位置 |
|--------|------|-------------|
| 1a. `markProviderHealthy` 清除 `scheduledRecoveryTime` | ✅ 已实现 | provider-pool-manager.js:1755 |
| 1b. `rateLimitHits` 字段初始化 | ✅ 已实现 | provider-pool-manager.js:872 |
| 1b. 兼容已有 state | ✅ 已实现 | provider-pool-manager.js:875-876 |
| 1c. `record429Hit` 方法 | ✅ 已实现（含清理） | provider-pool-manager.js:1789-1795 |
| 1d. `_calculateNodeScore` 429 惩罚 | ✅ 已实现 | provider-pool-manager.js:622-625 |
| 2a. Stream 429 标记 unhealthy | ✅ 部分实现 | common.js:832-840 |
| 2b. 凭证切换跳过延迟 | ✅ 已实现 | common.js:893-899 |
| 2c. Unary handler | ✅ 已实现 | common.js:1079-1087 |

### 第一轮建议的采纳情况

- ✅ `rateLimitHits` 数组清理：`record429Hit` 中已包含 `filter(t > now - 60000)`（line 1794）
- ✅ 评分权重注释：line 622-623 已有说明
- ✅ Unary 实现：已正确排除 stream 特有变量

---

## 残留 Bug：`RATE_LIMIT_COOLDOWN_ENABLED=false` 时 429 重试耗尽仍静默失败

### 问题描述

当前实现将 unhealthy 标记门控在 `if (rateLimitRecoveryTime)` 内（common.js:832）。`rateLimitRecoveryTime` 仅在 `RATE_LIMIT_COOLDOWN_ENABLED=true` 时有值。

当 `RATE_LIMIT_COOLDOWN_ENABLED=false` 时的执行路径：

```
429 发生
  → rateLimitRecoveryTime = null (因为 cooldown 未启用)
  → is429 = true
  → 进入外层 if (rateLimitRecoveryTime || is429)  ← YES
  → if (rateLimitRecoveryTime) ← NO，跳过 unhealthy 标记
  → if (rateLimitRetry < 3) ← 重试 3 次
  → 3 次耗尽后 fall through...
  → line 864: if (rateLimitRecoveryTime) ← NO，无日志
  → line 870: !skipErrorCount ← skipErrorCount=true，跳过
  → line 885: shouldSwitchCredential ← false，跳过
  → line 891: credentialMarkedUnhealthy ← false，跳过
  → 请求静默失败，无凭证切换
```

**这正是计划最初要修复的 bug，但在 cooldown 未启用时仍然存在。**

### 建议修复

在 3 次重试耗尽后，无论 `RATE_LIMIT_COOLDOWN_ENABLED` 是否开启，都应触发凭证切换：

```javascript
// 3 次重试耗尽 — 无论 cooldown 是否启用，都标记并切换
if (!credentialMarkedUnhealthy) {
    providerPoolManager.markProviderUnhealthy(toProvider, { uuid: pooluuid },
        '429 Too Many Requests - retries exhausted');
    credentialMarkedUnhealthy = true;
}
logger.info(`[Stream Retry] 429 retries exhausted for ${toProvider} (${pooluuid}). Switching credential immediately.`);
```

这段代码应放在 `rateLimitRetry >= 3` 的 fall-through 路径上（line 863-866 之间），替换当前的条件日志。

---

## 实现质量评价

对已实现部分的代码质量评价：

1. **设计选择合理**：将 unhealthy 标记门控在 `rateLimitRecoveryTime` 上，尊重了 `RATE_LIMIT_COOLDOWN_ENABLED` 的配置语义（第二轮建议的方案 A）
2. **`record429Hit` 实现优于计划**：在 push 前先 filter，避免了内存泄漏
3. **评分注释清晰**：`1次429 ≈ 2次正常使用的惩罚` 解释了 20000 的设计意图
4. **Unary 实现正确**：没有引入 stream 特有变量

---

## 最终结论

计划本身质量良好，且已基本实现。唯一残留的问题是 `RATE_LIMIT_COOLDOWN_ENABLED=false` 场景下的静默失败。建议：

1. **修复残留 bug**：在重试耗尽的 fall-through 路径上无条件标记 unhealthy 并触发凭证切换
2. **计划可以关闭**：除上述残留 bug 外，所有计划项已完成
