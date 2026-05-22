# Fix: 429 Handling - Mark Unhealthy During Retry & Add 429 Rate Scoring

## Context

在 stream/unary 请求处理路径中（`common.js`），当 kiro 账号收到 429 时，`rateLimitRecoveryTime` 被计算出来但从未用于标记账号为 unhealthy。这导致：
1. 重试期间其他请求仍会选中同一个被限流的账号
2. 3 次重试全部失败后，因为 `skipErrorCount=true`，账号也不会被标记 unhealthy，也不会触发凭证切换
3. 与 `api-manager.js`（图片生成）的行为不一致——后者正确调用了 `markProviderUnhealthyWithRecoveryTime`

## 设计决策

- **`RATE_LIMIT_COOLDOWN_ENABLED=false` 时**：尊重配置，保持当前行为（不标记 unhealthy，只重试）
- **`RATE_LIMIT_COOLDOWN_ENABLED=true` 时**：执行新逻辑（标记 unhealthy + cooldown + 评分降权 + 凭证切换）
- 判断依据：`rateLimitRecoveryTime` 是否有值（该函数内部已检查 `RATE_LIMIT_COOLDOWN_ENABLED`）

## 评审确认项

- 重试成功恢复路径：`common.js:786`(stream) / `:1042`(unary) 已有 `markProviderHealthy` 调用 ✓
- 重试 unhealthy 账号安全性：重试传递 `service` 对象，不经过 pool selector ✓
- 内存泄漏：`record429Hit` 中先清理过期条目再 push ✓
- Unary 差异：retryContext 不含 `clientDisconnected`/`anyDataSent` ✓

---

## 修改方案

### 文件 1: `src/providers/provider-pool-manager.js`

#### 1a. `markProviderHealthy` 清除 `scheduledRecoveryTime`

位置：第 1745 行（`provider.config.needsRefresh = false;`）之后插入

```javascript
provider.config.scheduledRecoveryTime = null;
```

#### 1b. 添加 429 计数器字段

位置：第 863 行，state 初始化，在 `queue: []` 后添加 `rateLimitHits: []`

```javascript
state: existing ? existing.state : {
    activeCount: 0,
    waitingCount: 0,
    queue: [],
    rateLimitHits: []
}
```

第 868 行（`}`）之后，兼容已有节点：
```javascript
if (existing && !existing.state.rateLimitHits) {
    existing.state.rateLimitHits = [];
}
```

#### 1c. 添加 `record429Hit` 方法

位置：`markProviderHealthy` 方法之后（约第 1774 行后）

```javascript
record429Hit(providerType, uuid) {
    const provider = this._findProvider(providerType, uuid);
    if (!provider) return;
    if (!provider.state.rateLimitHits) provider.state.rateLimitHits = [];
    const now = Date.now();
    provider.state.rateLimitHits = provider.state.rateLimitHits.filter(t => t > now - 60000);
    provider.state.rateLimitHits.push(now);
}
```

#### 1d. `_calculateNodeScore` 增加 429 频率惩罚

位置：第 620 行（`const loadScore = ...`）之后，第 622 行（`// 新鲜节点的微调`）之前

```javascript
// 惩罚项 D: 429 频率 (每次近1分钟内的429增加20秒权重)
// 1次429 ≈ 2次正常使用的惩罚，使被限流节点恢复后仍被适度降低优先级
const rateLimitHits = (state.rateLimitHits || []).filter(t => t > now - 60000).length;
const rateLimitScore = rateLimitHits * 20000;
```

返回值（第 625 行）更新为：
```javascript
return baseScore + usageScore + sequenceScore + loadScore + rateLimitScore + freshBonus;
```

---

### 文件 2: `src/utils/common.js`

#### 2a. 重写 429 处理块 — Stream handler（替换第 829-855 行）

条件拆分：`rateLimitRecoveryTime` 有值时走新逻辑，否则（cooldown 禁用）保持原行为。

```javascript
const rateLimitRecoveryTime = getRateLimitCooldownRecoveryTime(error, CONFIG);
const is429 = Number(status) === 429;
if ((rateLimitRecoveryTime || is429) && providerPoolManager && pooluuid) {
    if (rateLimitRecoveryTime) {
        // Cooldown 启用：标记 unhealthy，从调度池移除
        providerPoolManager.markProviderUnhealthyWithRecoveryTime(
            toProvider, { uuid: pooluuid },
            '429 Too Many Requests - rate limit cooldown', rateLimitRecoveryTime
        );
        credentialMarkedUnhealthy = true;
        providerPoolManager.record429Hit(toProvider, pooluuid);
    }

    // 在同一账号上重试（最多 3 次）
    if (rateLimitRetry < 3) {
        const retryAfterDelay = error.retryAfterMs || 0;
        const randomDelay = retryAfterDelay > 0
            ? retryAfterDelay
            : Math.floor(Math.random() * 10000);
        logger.info(`[Stream Retry] 429 for ${toProvider} (${pooluuid}).${rateLimitRecoveryTime ? ` Marked unhealthy, recovery at ${rateLimitRecoveryTime.toISOString()}.` : ''} Waiting ${randomDelay}ms (retry ${rateLimitRetry + 1}/3)...`);
        await new Promise(resolve => setTimeout(resolve, randomDelay));

        const newRetryContext = {
            ...retryContext, CONFIG, currentRetry, maxRetries,
            rateLimitRetry: rateLimitRetry + 1,
            clientDisconnected, anyDataSent
        };
        return await handleStreamRequest(
            res, service, model, requestBody, fromProvider, toProvider,
            PROMPT_LOG_MODE, PROMPT_LOG_FILENAME,
            providerPoolManager, pooluuid, customName, newRetryContext
        );
    }

    // 3 次重试耗尽
    if (rateLimitRecoveryTime) {
        // Cooldown 启用：立即切换凭证（不再等待）
        logger.info(`[Stream Retry] 429 retries exhausted for ${toProvider} (${pooluuid}). Switching credential immediately.`);
    }
    // Cooldown 禁用：fall through，由下方 skipErrorCount 逻辑处理（保持原行为）
}
```

#### 2b. 凭证切换延迟改为条件判断 — Stream（修改第 879-883 行）

```javascript
if (credentialMarkedUnhealthy && currentRetry < maxRetries && providerPoolManager && CONFIG) {
    if (!is429) {
        const randomDelay = Math.floor(Math.random() * 10000);
        logger.info(`[Stream Retry] Waiting ${randomDelay}ms before retry ${currentRetry + 1}/${maxRetries} with different credential...`);
        await new Promise(resolve => setTimeout(resolve, randomDelay));
    } else {
        logger.info(`[Stream Retry] 429 exhausted, switching credential immediately (retry ${currentRetry + 1}/${maxRetries})...`);
    }
    // ... 后续 getApiServiceWithFallback 逻辑不变
```

#### 2c. 重写 429 处理块 — Unary handler（替换第 1060-1084 行）

```javascript
const rateLimitRecoveryTime = getRateLimitCooldownRecoveryTime(error, CONFIG);
const is429 = Number(status) === 429;
if ((rateLimitRecoveryTime || is429) && providerPoolManager && pooluuid) {
    if (rateLimitRecoveryTime) {
        providerPoolManager.markProviderUnhealthyWithRecoveryTime(
            toProvider, { uuid: pooluuid },
            '429 Too Many Requests - rate limit cooldown', rateLimitRecoveryTime
        );
        credentialMarkedUnhealthy = true;
        providerPoolManager.record429Hit(toProvider, pooluuid);
    }

    if (rateLimitRetry < 3) {
        const retryAfterDelay = error.retryAfterMs || 0;
        const randomDelay = retryAfterDelay > 0
            ? retryAfterDelay
            : Math.floor(Math.random() * 10000);
        logger.info(`[Unary Retry] 429 for ${toProvider} (${pooluuid}).${rateLimitRecoveryTime ? ` Marked unhealthy, recovery at ${rateLimitRecoveryTime.toISOString()}.` : ''} Waiting ${randomDelay}ms (retry ${rateLimitRetry + 1}/3)...`);
        await new Promise(resolve => setTimeout(resolve, randomDelay));

        const newRetryContext = {
            ...retryContext, CONFIG, currentRetry, maxRetries,
            rateLimitRetry: rateLimitRetry + 1
        };
        return await handleUnaryRequest(
            res, service, model, requestBody, fromProvider, toProvider,
            PROMPT_LOG_MODE, PROMPT_LOG_FILENAME,
            providerPoolManager, pooluuid, customName, newRetryContext
        );
    }

    if (rateLimitRecoveryTime) {
        logger.info(`[Unary Retry] 429 retries exhausted for ${toProvider} (${pooluuid}). Switching credential immediately.`);
    }
}
```

#### 2d. 凭证切换延迟改为条件判断 — Unary（修改第 1108-1112 行）

```javascript
if (credentialMarkedUnhealthy && currentRetry < maxRetries && providerPoolManager && CONFIG) {
    if (!is429) {
        const randomDelay = Math.floor(Math.random() * 10000);
        logger.info(`[Unary Retry] Waiting ${randomDelay}ms before retry ${currentRetry + 1}/${maxRetries} with different credential...`);
        await new Promise(resolve => setTimeout(resolve, randomDelay));
    } else {
        logger.info(`[Unary Retry] 429 exhausted, switching credential immediately (retry ${currentRetry + 1}/${maxRetries})...`);
    }
    // ... 后续 getApiServiceWithFallback 逻辑不变
```

---

## 修改后的完整流程

### RATE_LIMIT_COOLDOWN_ENABLED=true 时：
```
请求收到 429
    ↓
markProviderUnhealthyWithRecoveryTime() → 账号从调度池移除
record429Hit() → 记录用于评分降权
    ↓
rateLimitRetry < 3?
    ├─ YES → 等待 0-10s → 在同一 service 对象上重试
    │         ↓
    │       成功? → markProviderHealthy() [common.js:786/1042]
    │               → 清除 scheduledRecoveryTime [1a] → 账号回到池中
    │       失败? → 下一轮重试（递归）
    │
    └─ NO (3次耗尽) → credentialMarkedUnhealthy=true
                       → 跳过随机延迟 [2b/2d]
                       → getApiServiceWithFallback() 选新健康账号
```

### RATE_LIMIT_COOLDOWN_ENABLED=false 时：
```
请求收到 429
    ↓
不标记 unhealthy，不记录 429 命中
    ↓
rateLimitRetry < 3?
    ├─ YES → 等待 0-10s → 重试同一账号（与当前行为一致）
    │
    └─ NO → fall through，由 skipErrorCount 逻辑处理（与当前行为一致：请求失败）
```

## 关键文件

- `src/utils/common.js` — 429 重试逻辑 + 凭证切换延迟
- `src/providers/provider-pool-manager.js` — 标记/恢复 + 429 计数 + 评分

## 验证方式

1. 单元验证：模拟 429 错误 + cooldown 启用，确认 `markProviderUnhealthyWithRecoveryTime` 被调用
2. 集成验证：多个并发请求，触发 429 后确认新请求不再选中同一账号
3. 恢复验证：429 重试成功后确认 `scheduledRecoveryTime` 被清除，账号回到池中
4. 评分验证：频繁 429 的账号在恢复后评分应偏高（被降低优先级）
5. 配置验证：`RATE_LIMIT_COOLDOWN_ENABLED=false` 时行为不变
6. 内存验证：长时间运行后 `rateLimitHits` 数组长度不超过合理范围

## 补充内容
当 RATE_LIMIT_COOLDOWN_ENABLED=false 时，429 重试 3 次耗尽后仍然静默失败——credentialMarkedUnhealthy 始终为 false，不会触发凭证切换。这正是计划最初要修复的问题，但当前实现只修复了 cooldown 启用的场景。
(**已修复**)