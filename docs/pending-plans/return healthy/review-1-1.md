# Review-1 — 第 1 轮

**审阅对象**：`/home/chris/.claude/plans/unhealthy-refreshtoken-playful-octopus.md`
**主题**：修复 unhealthy 节点不会使用 refresh_token 自动恢复的问题

我已通读该计划，并对照当前源码（`src/providers/provider-pool-manager.js`、`src/providers/adapter.js`）逐项验证。

---

## 1. 诊断核对（对照当前源码）

| 计划论断 | 源码核对 | 结论 |
|---|---|---|
| `warmupNodes` 在 L212 的过滤排除了 unhealthy 节点 | `provider-pool-manager.js:212` —— `p.config.isHealthy && !p.config.isDisabled && …` | ✅ |
| `checkAndRefreshExpiringNodes` 仅在 L164 过滤 `isDisabled` | L164 确认；注释为 "不健康节点也应允许尝试刷新以恢复健康" | ✅ |
| `_checkProviderHealth` 在 L2314 直接调用 `generateContent`，未先刷新 token | 确认 | ✅ |
| `_checkAndRecoverScheduledProviders` 在 L1971-1985 直接将 `isHealthy` 翻为 `true`，未验证 token | 确认 | ✅ |
| 各 OAuth 适配器都实现了 `forceRefreshToken` | adapter.js: 145、214、270、308、345、404、482、539、593、642 | ✅ |
| `_awaitRefreshWithTimeout` 位于 L548；`_debouncedSave` 存在 | 确认 | ✅ |
| `_refreshNodeToken` 在成功路径的 L507 重置 `refreshCount=0` | 确认 | ✅ |
| 插入位置在 L2292（`getServiceAdapter`）与 L2295（`_buildHealthCheckRequests`）之间 | 确认 | ✅ |

诊断准确。问题复现路径（access_token 已失效但 refresh_token 仍有效，且 `expiry_date` 时间戳尚未到期）确实是当前的真实漏洞。

---

## 2. 优点

- **方法选对了**：使用 `forceRefreshToken` 而非 `refreshToken`。对一个 unhealthy 节点而言，必须绕过 gated 路径中基于过期时间戳的拦截。
- **位置选对了**：`_checkProviderHealth` 是 `performHealthChecks`（L2147）和 `performInitialHealthChecks`（L2043）的共用入口，一次插入同时修复两个调用方。
- **`refreshingUuids` 作为竞态保护是正确的**。`_enqueueRefresh`（L254）和 `_enqueueRefreshImmediate`（L339）都会查询同一集合，多路径之间能自动协调，避免重复刷新。
- **`refreshCount` 不自增的理由站得住脚**。如果在此处自增，达到 5 次时会调用 L527 的 `markProviderUnhealthyImmediately`，与探测失败路径重复触发同一标记动作。
- **刷新失败 fallthrough 到原有探测路径**：避免重复实现 `markProviderUnhealthy(Immediately)` 的状态机，保持一份真相。

---

## 3. 问题

### 3.1 BLOCKING — 静态密钥适配器：`typeof === 'function'` 判断不充分

计划原文："对于静态密钥适配器（OpenAI、Claude、Forward），`forceRefreshToken()` 会便宜地返回 `false`，整段代码对它们是 no-op。"

实际情况：`BaseAdapter.forceRefreshToken` 在 [adapter.js:85](src/providers/adapter.js#L85) **抛出** `Error("Method 'forceRefreshToken()' must be implemented.")`。任何继承基类但未重写该方法的适配器会：

1. 通过 `typeof === 'function'` 检查（继承的方法仍然存在）；
2. 在 try 块内抛错；
3. 进入 catch，对该节点的 **每一次** 健康检查都打印 `[HealthCheck] Force refresh failed … Proceeding to probe.` —— 永久性的误导日志。

grep 显示 `forceRefreshToken` 实现位于 adapter.js 的 145、214、270、308、345、404、482、539、593、642、683 行，但计划需要明确列出这些行属于哪些 class，并确认静态密钥类适配器要么返回 `false`，要么被显式排除。**此项必须在合并前解决。**

可选方案：

- (a) 确认每个具体适配器都重写为返回 `false`（首选）。
- (b) 不依赖方法存在性，改为 duck-type：以 `providerConfig` 上是否存在 OAuth 凭据路径字段（如 `KIRO_OAUTH_CREDS_FILE_PATH`、`GEMINI_OAUTH_CREDS_FILE_PATH` 等）作为 gate。
- (c) 在错误信息匹配 "must be implemented" 时把日志降级为 `debug`。能屏蔽噪声但不优雅。

### 3.2 范围 —— `_checkAndRecoverScheduledProviders` 未被覆盖

计划在诊断第 4 项正确指出 L1961 的 `_checkAndRecoverScheduledProviders` 会在 429 冷却到期后直接将 `isHealthy` 翻为 `true`，不验证 token。但本次修复并未触及该函数。

后果：429 冷却自动恢复后，节点带着可能已死的 access_token 重回轮询池；只能等下一次定时健康检查或 5 次用户请求失败后才会再次被标记 unhealthy。

建议：在计划中加一条明确的"out-of-scope"说明，告知 reviewer 本 PR 仅修复健康检查路径，cooldown 自动恢复路径作为单独 issue 处理。或者扩展修复 —— 但我倾向于保持本 PR 聚焦。

### 3.3 最坏情况延迟 —— pre-probe 串行化会拖慢 `performHealthChecks`

`_awaitRefreshWithTimeout` 使用 `this.refreshTaskTimeoutMs`。当刷新挂起（IDP 故障、网络阻塞）时，每个 unhealthy 节点在探测前都会额外消耗最多 `refreshTaskTimeoutMs`，加上探测本身 15s 超时。`performHealthChecks` 在 L2136 用 `for…of` 串行迭代，因此 N 个挂起的 unhealthy 节点会串行化为 `N × (refreshTaskTimeoutMs + 15s)`。

虽然原本就是串行的，不算回归，但最坏情况时长会显著增长。建议在计划中加一句，提醒运维方调度间隔可能需要相应调大。

### 3.4 可能冗余 —— 显式重置 `refreshCount=0` 与 `lastRefreshTime`

如果探测随后成功，会调用 L2159 的 `markProviderHealthy`，该函数很可能已经重置了相关计数器。如果是这样，pre-probe 块里再做一次显式重置 + `_debouncedSave` 就是多余的写盘抖动。

如果 `markProviderHealthy` **不**重置 `refreshCount`，那么显式重置就是必需的。建议用 30 秒确认 L1742 的 `markProviderHealthy` 行为后再决定是否保留。

### 3.5 状态：刷新成功但探测失败的边界情形

如果 pre-probe 刷新成功（保存的状态：`lastRefreshTime=now`、`refreshCount=0`），但随后的探测失败，会调用 `markProviderUnhealthy(Immediately)`。节点最终状态为：`isHealthy=false, refreshCount=0, lastRefreshTime=now`。

`refreshCount=0` 对一个刚刚失败的节点而言略显反直觉 —— 下一次刷新不再受 5 次上限保护。逻辑上其实是对的（刷新本身是成功的，失败发生在更上层），但建议在插入的代码块里加一行注释解释这个 bookkeeping 选择，避免后人误改。

---

## 4. 验证计划完整度

原计划 7 步覆盖了：happy path、与 `checkAndRefreshExpiringNodes` 的并发竞态、刷新失败 fallthrough、静态密钥 sanity。

缺口：

- 未覆盖"刷新成功 + 探测失败"后的计数器状态（对应 §3.5）。
- 未覆盖静态密钥适配器抛出 `must be implemented` 时是否会日志爆炸（对应 §3.1）。
- 未明确声明 cooldown 自动恢复路径仍未被覆盖（对应 §3.2）。

---

## 5. 合并前必做项

1. **解决 §3.1** —— 列出所有静态密钥适配器对 `forceRefreshToken` 的实际行为，或将 gating 改为基于凭据形状的 duck-typing。
2. **解决 §3.2** —— 在计划中显式声明 `_checkAndRecoverScheduledProviders` 为本 PR 范围之外。
3. **建议** —— 注明最坏延迟增长（§3.3）；确认并裁剪冗余计数器重置（§3.4）；为 save-on-success-only 的 bookkeeping 加一行注释（§3.5）。

---

## 6. 结论

核心修复方向正确、定位精准、改动量最小。**§3.1 是阻塞项** —— 不解决会导致静态密钥节点的健康检查日志被 "Force refresh failed" 持续刷屏。**§3.2 是范围声明的清晰度问题**，必须明示。其余为打磨建议。

完成上述事项后，这是一个干净的单文件 PR。
