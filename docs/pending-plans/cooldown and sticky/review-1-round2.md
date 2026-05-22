# 评审意见 第二轮：429 Handling - Mark Unhealthy During Retry & Add 429 Rate Scoring

## 上轮遗留问题跟进

### [已解决] 重试成功后的 `markProviderHealthy` 恢复路径

经验证，`common.js:786-788` 在流式请求成功完成后会调用 `markProviderHealthy`：
```javascript
providerPoolManager.markProviderHealthy(toProvider, { uuid: pooluuid });
```

Unary 同理 (`common.js:1042-1044`)。

由于计划的重试代码递归调用 `handleStreamRequest`，成功的重试会命中此路径。结合 1a 修复（`markProviderHealthy` 清除 `scheduledRecoveryTime`），**恢复路径完整**。第一轮的阻塞性问题已消除。

---

## 第二轮新发现

### 1. [风险] `RATE_LIMIT_COOLDOWN_ENABLED` 配置门控与 fallback 值冲突

`getRateLimitCooldownRecoveryTime` (`common.js:182-196`) 有一个前置条件：
```javascript
if (!config?.RATE_LIMIT_COOLDOWN_ENABLED || Number(getErrorStatusCode(error)) !== 429) {
    return null;
}
```

当 `RATE_LIMIT_COOLDOWN_ENABLED=false` 或未设置时，`rateLimitRecoveryTime` 为 `null`。

计划的代码用 `rateLimitRecoveryTime || is429` 作为进入条件，并 fallback：
```javascript
const recoveryTime = rateLimitRecoveryTime || new Date(Date.now() + 30000);
```

**问题**：
- 硬编码的 30000ms fallback 绕过了用户的 `RATE_LIMIT_COOLDOWN_MS` / `RATE_LIMIT_COOLDOWN_MAX_MS` 配置意图
- 如果用户刻意关闭 `RATE_LIMIT_COOLDOWN_ENABLED`，意味着他们不希望有 cooldown 行为。但计划的代码仍然会对 429 执行 mark unhealthy + 30s cooldown，违背了配置语义

**建议**：
- 方案 A：尊重配置——当 `RATE_LIMIT_COOLDOWN_ENABLED=false` 时，保持现有行为（不标记 unhealthy，只重试）
- 方案 B：将 `is429` 单独处理为"轻量标记"模式（只 record429Hit 用于评分，不 mark unhealthy）
- 方案 C：重新定义配置语义——`RATE_LIMIT_COOLDOWN_ENABLED` 仅控制 cooldown 时长计算，429 始终触发 unhealthy 标记

需要明确选择哪种方案。

### 2. [确认] 并发安全性

多个并发请求同时对同一 provider 触发 429：
- `markProviderUnhealthyWithRecoveryTime`：多次调用只是重复写入相同状态，幂等，无问题
- `record429Hit`：每次 push 一个时间戳，正确反映实际 429 频率
- `_debouncedSave`：debounce 机制天然合并多次写入

**结论：无并发安全问题。**

### 3. [建议] Unary handler 的上下文差异

对比 Stream 和 Unary 的 retryContext 构建：

**Stream** (`common.js:839-847`):
```javascript
{ ...retryContext, CONFIG, currentRetry, maxRetries,
  rateLimitRetry: rateLimitRetry + 1,
  clientDisconnected, anyDataSent }
```

**Unary** (`common.js:1070-1076`):
```javascript
{ ...retryContext, CONFIG, currentRetry, maxRetries,
  rateLimitRetry: rateLimitRetry + 1 }
```

Unary 不传 `clientDisconnected` 和 `anyDataSent`（stream 特有概念）。计划的 2a 代码直接复用了 stream 版本并传了这两个参数，如果在 unary 中也这样写会引入未定义变量。

**建议**：2c 部分需要明确排除 `clientDisconnected` 和 `anyDataSent`。
