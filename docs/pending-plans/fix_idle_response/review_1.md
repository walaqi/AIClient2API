# Review Round 1 — fix-idle_response 计划评审

被评审计划：[`/home/chris/.claude/plans/claude-kiro-js-stop-reason-tool-use-410-majestic-blum.md`](../../../../../.claude/plans/claude-kiro-js-stop-reason-tool-use-410-majestic-blum.md)

被改动文件：[src/providers/claude/claude-kiro.js](../../../src/providers/claude/claude-kiro.js)

评审时间：2026-05-28

---

## 总体结论

**方向正确，可以实施。** 根因诊断扎实（chunkCount=0 + bufferRemain=0 + socketAborted=false + 0 byte → 上游 200 + 空流），方案小巧、复用现有重试通道、不伪造内容，与上一轮 `messageStartEmitted` 延迟 yield 的兼容性论证站得住脚。下面列出 4 条建议增强项与 2 条值得再确认的细节，用于第二轮收紧。

---

## 已逐条核对、确认无误的关键论断

| 论断 | 验证位置 | 结论 |
|---|---|---|
| 抛错会进入 streamApiReal 自身 catch（[L3277](../../../src/providers/claude/claude-kiro.js#L3277)） | 抛错点在 [L3263-3276](../../../src/providers/claude/claude-kiro.js#L3263-L3276) 同一 try-block 末尾 | ✅ 同 try 内 throw，自然进入 catch |
| KIRO_EMPTY_STREAM 不会被前置 status 分支拦截 | [L3290-L3346](../../../src/providers/claude/claude-kiro.js#L3290-L3346) 全部要 `error.response.status` | ✅ 普通 Error 无 response，status=undefined，全部跳过 |
| `isNetworkError` 默认 false | [src/utils/common.js:49-58](../../../src/utils/common.js#L49-L58) 仅匹配 `RETRYABLE_NETWORK_ERRORS` 字符串 | ✅ 必须扩展条件，计划改动 2 正确 |
| 重试递归调用 [L3354](../../../src/providers/claude/claude-kiro.js#L3354) `yield* this.streamApiReal(...)` 不会触发 "Cannot retry" | streamApiReal 抛错前未 yield 任何事件 → generateContentStream 的 `messageStartEmitted` 仍 false（[L3582](../../../src/providers/claude/claude-kiro.js#L3582)、[L3592](../../../src/providers/claude/claude-kiro.js#L3592)）→ common.js 的 `anyDataSent` 也仍 false | ✅ 与上一轮 `b55db7a` 的延迟机制天然契合 |
| `releaseThrottle()` 不会泄漏 | [L3360-L3366](../../../src/providers/claude/claude-kiro.js#L3360-L3366) finally 内执行 | ✅ throw 走 finally，资源释放正常 |
| `chunkCount === 0` 时 `bufferRemain` 必然 0 | [L3204-L3216](../../../src/providers/claude/claude-kiro.js#L3204-L3216) buffer 只在 chunk 累积时增长 | ✅ 因此 `truncated` 只可能因 `socketAborted` 为真，`!socketAborted` 守卫足够 |

---

## 建议增强（按优先级）

### 1. 抛错前补一行独立 warn 日志（Should）

计划当前依赖改动 2 在 catch 中打 `Network error (EMPTY_STREAM)`，但日志反推链略长。建议在 throw 前加：

```js
logger.warn(`[Kiro Stream] Empty stream detected (chunkCount=0, totalRawBytes=0, durMs=${Date.now() - streamStartMs}), throwing as KIRO_EMPTY_STREAM for retry`);
```

**理由**：未来 grep `Empty stream detected` 可直接得到所有空流事件、各次 durMs 分布；若再次出现"重试也救不回来"的极端情形，定位时间从分钟级降到秒级。零额外成本。

### 2. 测试中模拟空流的写法明确化（Should）

计划写 `Readable.from(Buffer.alloc(0))`。`Readable.from` 对 0 长度 Buffer 在不同 Node 版本的行为不完全一致（部分版本会推一个空 chunk，部分版本直接 end）。即使推了空 chunk，[L3204](../../../src/providers/claude/claude-kiro.js#L3204) 的 `chunkBuf.length > 0` 守卫会过滤掉，最终 chunkCount 仍 0 — 所以**测试结果应该没问题**，但行为依赖隐式过滤，不够直观。

建议改用：

```js
const { Readable } = require('stream');
const emptyStream = Readable.from([]); // 显式空数组,for-await 直接结束
```

并在测试断言里**补一条**：mock `chunkBuf.length === 0` 的"上游推空 chunk"场景也能识别为空流（覆盖 [L3204](../../../src/providers/claude/claude-kiro.js#L3204) 守卫真实生效）。

### 3. 补一个 socketAborted=true 的反向测试（Nice-to-have）

计划列了两个用例（一次空流后重试成功、连续 3 次空流）。建议加第三个：

> 模拟"上游推 0 chunk 但中途 socket abort"场景：mock 流 emit `aborted` 事件后立即 end，断言**不会**抛 `KIRO_EMPTY_STREAM`，而是走 truncated 路径正常 yield `__kiroStreamEnd`（与样本 truncated=true 兼容）。

**理由**：`!socketAborted` 守卫是关键边界，没有测试就靠人工脑补。日后若有人误把 `&& !socketAborted` 写成 `|| !socketAborted`，CI 必须能挡住。

### 4. 改动 3 的表述收紧（Nit）

计划当前写"改动 3：无需新代码"但又写"(3 视 read 结果)"。建议直接删掉"改动 3"小节并入"复用的现有机制"段落，避免读者误以为有什么悬而未决。当前 [generateContentStream catch 在 L4058-4061](../../../src/providers/claude/claude-kiro.js#L4058-L4061) 已确认是 `logger.error + throw`，确实无新代码。

---

## 值得再确认的两点

### A. 是否需要"连续空流切凭证"

样本 2 出现空流时正好伴随 token near-expiry + 拒绝刷新。计划明确说"触发因素不进入修复条件"，我同意——因为重试一次 + ProviderPoolManager 自然刷新流程已能 cover。但**长尾担忧**：如果未来发现某个 credential 持续返回空流（不只是边缘 token，而是账号问题），3 次重试全打在同一 credential 上无效。

**建议**：本轮**不做**这个增强，但在计划末尾"未来观察项"里挂一条 TODO：
> 若部署后日志显示 `EMPTY_STREAM` 重试 ≥2 次仍失败的事件 > 1%/天，再加 `error.shouldSwitchCredential = true` 切凭证逻辑。

### B. 重试时序是否会让用户感知延迟

样本 1 的空流持续 9.1s。叠加 baseDelay=1000ms、maxRetries=3 的指数退避（1+2+4=7s），最差情形：第一次 9s 空流 + 7s 退避 + 第二次正常响应 ≈ 16s。当前样本 2 第一次 1.6s，问题不大。

**建议**：本轮**不调整**重试参数，但在验证步骤里加一条主观 SLA 观察：
> 部署后用户报告"工具后等待时间"主观感受是否明显恶化（多于偶发的 5-15 秒等待）。如果是，下轮考虑把 EMPTY_STREAM 的 baseDelay 单独压到 200-500ms。

---

## 评审结论

**通过，建议合入下述 2 项再实施：**

- 增强 1（抛错前 warn 日志）
- 增强 2（测试用 `Readable.from([])`）

增强 3（socketAborted 反向测试）和增强 4（改动 3 表述）作为可选项纳入即可。

下一步若用户认可上述意见，可让计划作者把改动 1 的 throw 块前补上 warn、测试方案文字微调，然后进入实施阶段。
