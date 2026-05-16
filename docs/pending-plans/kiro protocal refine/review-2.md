# 评审意见 Round 2 — Kiro AWS event-stream 解析器重写 (v2)

评审对象：`/home/chris/.claude/plans/claude-code-generic-piglet.md` (v2，已并入 review-1)

## 总评

v2 **质量显著提升**。Round 1 的 3 个阻塞项（B1/B2/B3）和 5 个重要细节（D1-D5）均已明确回应并纳入计划。代码示例完整度高，可直接作为实施蓝图。**建议状态：可实施**，附带以下需注意的细节。

---

## Round 1 阻塞项回溯

| 编号 | 状态 | 评价 |
|------|------|------|
| B1 | ✅ 已解决 | 明确「不保留 wrapper」+ 测试整体重写 + 验证步骤 2 改写为「旧用例已删，新用例覆盖」 |
| B2 | ✅ 已解决 | 补全了调用点全集（5 处），逐一给出迁移方式（import 重命名 / class method 重命名 / 调用点切换） |
| B3 | ✅ 已解决 | `writeStringHeader` helper 按合法 AWS header 格式编码，核心回归用例显式注入 `0x22 0x5c 0x7b 0x7d` 字节 |

---

## 新发现 / 残余问题

### C1. `KIRO_CAPTURE_RAW` 的 `await import('fs')` 在热路径

```js
if (captureRawPath) {
    try {
        (await import('fs')).appendFileSync(captureRawPath, chunkBuf);
    } catch (e) { ... }
}
```

每个 chunk 都 `await import('fs')` 是不必要的开销（虽然 Node 有模块缓存，但 dynamic import 仍走 promise 微任务）。建议：

- 在 for 循环外 `const fs = captureRawPath ? require('fs') : null;`（或顶层 import）
- 循环内直接 `fs.appendFileSync(captureRawPath, chunkBuf)`

严格来说不阻塞功能（只在 debug 时启用），但作为代码质量问题值得修正。

### C2. `bytesSkipped` 在找回帧后重置为 0 的时机

```js
if (bytesSkipped >= SYNC_LOSS_WARN_BYTES) {
    logger.warn(`[Kiro Parse] Recovered frame after skipping ${bytesSkipped} bytes`);
    bytesSkipped = 0;
}
```

这段在 sanity check 通过后执行。但如果 `bytesSkipped < SYNC_LOSS_WARN_BYTES`（比如跳了 100 字节就找回帧），`bytesSkipped` **不会被重置**，后续如果再次丢同步，累计值会叠加到上一次的残余上。

两种选择：
- (a) 找回帧后**无条件重置** `bytesSkipped = 0`（推荐，每次丢同步独立计量）
- (b) 保持累计但把上界判断改为「连续跳字节」而非「总跳字节」

当前写法是 (b) 的语义但 (a) 的部分实现，存在不一致。建议统一为 (a)：在 `if (pos + totalLen > buf.length) break;` 之前、sanity 通过之后，无条件 `bytesSkipped = 0`。

### C3. `emitEventFromParsed` 未 export

计划代码里 `emitEventFromParsed` 是 `function`（非 export）。如果测试用例 `describe('parseAwsEventStreamFrames + emitEventFromParsed')` 需要单独测试它（如 mock logger 断言非 JSON payload 的 WARN），需要：

- 要么通过 `parseAwsEventStreamFrames` 间接测试（构造非 JSON payload 帧 → 断言 logger.warn 被调用）
- 要么 export 它

从计划 3.2 用例集看，「非 JSON payload 触发 WARN 日志 (mock logger 断言)」是通过构造帧间接测试的，这没问题。但 describe 名字里写了 `emitEventFromParsed` 可能让人误以为要直接 import 它。建议 describe 改名为 `'parseAwsEventStreamFrames event dispatch'` 或类似。

### C4. 类方法 `parseAwsEventStreamFrames` 保留的必要性

v2 保留了 class method 作为 thin delegator：

```js
parseAwsEventStreamFrames(buf) {
    return awsParseEventStreamFrames(buf);
}
```

这个 method 的唯一调用点是 `this.parseAwsEventStreamFrames(buffer)`（L2267）。如果没有子类 override 或 mock 需求，可以直接在流式循环里调用 imported 函数 `awsParseEventStreamFrames(buffer)`，删掉 class method。

但如果测试里有 spy/mock `this.parseAwsEventStreamFrames` 的场景（如集成测试注入假帧），保留 thin delegator 是合理的。

**建议**：在计划里加一句说明保留理由（「便于集成测试 mock」或「保持与其他 parse 方法的一致风格」），避免后续 reviewer 质疑。

### C5. 验证步骤 4 的顺序依赖

```
3. 运行项目：npm start
4. 抓 fixture：KIRO_CAPTURE_RAW=/tmp/kiro-capture.bin npm start
```

步骤 3 和 4 都是 `npm start`，但 4 需要在 3 之后（确认基本功能正常后再抓 fixture）。当前顺序正确，但建议在步骤 4 加一句「确认步骤 3 无报错后再执行」，避免在有 bug 的状态下抓到坏 fixture。

---

## 文字性 / 微调

- N5. 改动 2.2 注释写「payload UTF-8 解码在帧内做……不会切到 UTF-8 字符中间」——这个论断的前提是 AWS event-stream 帧 boundary 对齐。严格来说 TCP chunk boundary 可以切在帧中间（这正是 `remaining` 存在的原因），但 payload 解码只在完整帧提取后才做，所以结论正确。建议把注释改为「payload 解码仅在完整帧提取后执行，不存在跨帧的 UTF-8 多字节切割问题」，更精确。
- N6. 「不在本次范围」里 `isQuotaExhausted` 那条可以删掉——它与本次改动完全无关，放在这里反而让人困惑这个 plan 的 scope。

---

## 结论

**建议状态：可实施。**

Round 1 的阻塞项全部解决。Round 2 发现的 C1-C5 均为**非阻塞**的代码质量 / 一致性问题，可在实施过程中顺手修正，不需要再修订计划。

实施优先级建议：
1. 先写 parser 模块（改动 1）+ 单元测试（改动 3 的 3.1/3.2）→ 跑测试确认
2. 再改 claude-kiro.js（改动 2）→ `npm start` 验证
3. 最后抓 fixture + 写 fixture 测试（改动 3 的 3.3）

