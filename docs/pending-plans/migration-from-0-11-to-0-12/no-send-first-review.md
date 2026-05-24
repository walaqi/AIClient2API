## 总评

**结论: 可以执行。** 根因定位准确, 三处改动最小且互锁, 风险分析覆盖了主要边界。但有几处细节建议确认。

## 已核验的论断

| 论断 | 核对结果 |
| --- | --- |
| `anyDataSent` 仅在 [common.js:756] / [common.js:771] 由 `res.write` 置位 | ✅ grep 全文仅这两处赋值, [common.js:609] 初始化, [common.js:802] 闸门, [common.js:854] / [common.js:922] 透传 |
| Kiro `generateContentStream` 在 axios.request 之前 yield message\_start | ✅ [claude-kiro.js:3523-3539] 在 `for await (const event of streamApiReal)` 之前 |
| `streamApiReal` axios 抛错时不会先 yield | ✅ 首个 yield 在 [claude-kiro.js:3231] 的 `for await (const chunk of stream)` 内, 只有 axios 200 OK 后进入。catch 路径 [3277-3359] 全部 `throw`, 仅 502 代理回退 ([3340]) 和网络错误重试 ([3354]) 用 `yield*` 复用同一不变量 |
| commit `e612a66` 主动改成立即发送 message\_start | ✅ 2026-01-09 leonai 提交, 移除原本的 `bufferedEvents` 缓冲机制和 `messageStartSent` 状态。**这正是本次要回退的部分** |

## 需要补强的点

### 1\. Change 2 的插入位置应该再确认一次

计划说"首个非 `__kiroStreamEnd` 事件触发 yield"。但 streamApiReal 在 axios 200 OK 后, 第一个事件类型是不确定的, 包括 `contextUsage` / `metering` 这种**自身不产生下游输出**的事件 ([claude-kiro.js:3549-3553])。

按计划的位置 (在 `__kiroStreamEnd continue` 之后, `contextUsage` 检查之前), 这些事件也会触发 `messageStartEmitted = true`。这没问题, 因为:

*   axios 既已 200 OK, 凭证级问题已经过关, 再切凭证没意义
*   message\_start 必须先于 message\_delta 出现, 提前发送不违规

但**计划文档应明确说明这个设计选择**, 否则未来读到的人会困惑"为什么 contextUsage 这种不输出的事件也算首发触发器"。

### 2\. Change 3 兜底的位置我倾向再往后挪

计划放在 [3845-3846] (for-await 闭合之后, currentToolCall 处理之前)。但更稳妥的位置是**紧邻 message\_delta 之前**, 即 [claude-kiro.js:3998] 的 `yield {type: "message_delta", ...}` 之前。

理由: 在 currentToolCall / streamState 残余处理中, 任何分支可能 `yield content_block_stop` 等事件, 而那些事件**没有**包在 `messageStartEmitted` 检查里。如果 axios 200 OK 但事件解析全是控制帧 (理论上 currentToolCall 处理也可能 yield), 第一个真实下游 yield 可能不是 message\_start。

虽然 streamApiReal 的事件流经过 [claude-kiro.js:3543] 的 `__kiroStreamEnd` 后才退出 for-await, 而 yield content\_block\_stop 这种通常只在 currentToolCall 已建立后才出现 (那必然 messageStartEmitted=true 已置), 所以**实际上不会触发**。但放到 message\_delta 之前是更安全的兜底, 把"协议序章必须有 message\_start"这个不变量收紧到一个点。

### 3\. 风险分析里漏了一种 case

**axios 200 OK + 上游首事件就抛 (例如 frame 解析异常)**: streamApiReal 的 for-await 里某个 yield 之前出错很难, 但 [parseAwsEventStreamFrames] 抛错会冒到 [3277] catch, 此时 `firstByteSeen=true` 但还没 yield 任何东西。catch 里走默认 `throw error`。

修复后行为: messageStartEmitted=false → 错误冒到 common.js, anyDataSent=false → 切凭证重试。

但**切凭证不会修这种错** (上游字节解析失败, 凭证没问题)。修复后不会更糟, 只是浪费一次重试。建议在风险点列出, 标记为可接受。

### 4\. 验证方案应增加一项自动化单测

计划目前依赖手动 curl 触发 403/429。建议补一个 vitest/mocha 用例:

```js
// 伪代码
it('axios 403 before any yield → no message_start, error propagates for credential switch', async () => {
    const svc = new ClaudeKiroApi(...);
    svc.axiosInstance = mockAxios403();
    const gen = svc.generateContentStream(model, body);
    await expect(gen.next()).rejects.toMatchObject({ shouldSwitchCredential: true });
    // 关键断言: 在 throw 之前, gen 没 yield 任何事件
});
```

这样回归保护比 curl 强得多, 不依赖号池状态。

## 计划里可以删的

*   "改动 3 — L3845/3846 兜底" 这一节里的注释 `// 上游 axios 200 OK 但只发 __kiroStreamEnd / 完全空流时,` —— 其实用户不需要这层解释, 看代码就够。落地代码里那一行注释建议精简或删除 (CLAUDE.md 风格上也是默认不写注释)。

* * *

要不要我把以上反馈直接合并进 plan 文件 (Phase 4 写入), 然后调用 ExitPlanMode?