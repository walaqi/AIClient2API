# memo
但出了一个新 finding (要记到 Phase 1 report)
三次请求 (启动 HealthCheck + 用户两发) 全部被服务端 400 拒了。客户端没问题,是 SOCIAL 账号打 AmazonQCLI 端点 这个组合本身被服务端拒。这印证了原计划 §1.5 末尾那个未决项:

claude-kiro.js:1401 按 isIdc 而非 endpoint.origin 选 user-agent。SOCIAL+AmazonQCLI 走的是 IDE user-agent,服务端可能就是靠 user-agent 或 OAuth token 类型来检查端点合法性,因此 400。

→ 不算 §1.5 失败 (我们只验证 payload 形态正确剥字段),但作为 finding 记下:AmazonQCLI 端点在 SOCIAL 账号上 server-side 不可用。要让计划里"AmazonQCLI 模式"对 SOCIAL 真正生效,可能还需要同步把 user-agent 也按 endpoint.origin === 'CLI' 切到 CLI 形态 (即 claude-kiro.js:1401 当前的逻辑可能要改)。这是 Phase 3.x 的事,Phase 1 只是观察到了。

---
§2.2C: line 372-384 removeEmptyUserMessages preserves first-user-message-even-if-empty by design (STARTS_WITH_USER invariant). PASS.
§2.2D: line 311-369 ensureValidToolUsesAndResults for orphan tool_use injects synthetic failed tool_result (not XML flatten). The XML flatten is normalizeKiroToolHistory and only fires for tools no longer registered — that's §2.3's path. Plan's "XML flatten" assignment to §2.2D was wrong; actual behavior is correct. PASS.

----

