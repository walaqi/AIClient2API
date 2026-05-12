# 当前不支持每账号独立 proxy

探索后结论明确：**当前系统只支持按 provider 类型配置全局代理，不支持每个账号单独配置 proxy。**

## 现状

**全局代理配置** — [configs/config.json:70-75](vscode-webview://02o6oaihn1evl1rnsgsvd6sggap7dcl2ecrpvbkpb2m8s8vmtt5k/configs/config.json#L70-L75)

```json
"PROXY_URL": "socks5://172.29.144.1:10808",
"PROXY_ENABLED_PROVIDERS": [
  "gemini-cli-oauth",
  "claude-kiro-oauth",
  "openai-codex-oauth"
]
```

**账号池条目没有 proxy 字段** — [configs/provider\_pools.json](vscode-webview://02o6oaihn1evl1rnsgsvd6sggap7dcl2ecrpvbkpb2m8s8vmtt5k/configs/provider_pools.json) 每个账号只有 `uuid`、`KIRO_OAUTH_CREDS_FILE_PATH`、`isHealthy`、`usageCount` 等字段，**完全没有 proxy 相关字段**。

**代理应用逻辑** — [src/utils/proxy-utils.js](vscode-webview://02o6oaihn1evl1rnsgsvd6sggap7dcl2ecrpvbkpb2m8s8vmtt5k/src/utils/proxy-utils.js) `getProxyConfigForProvider(config, providerType)` 只按 provider type 决定是否启用全局 PROXY\_URL，同一 provider type 下的所有账号共享同一个代理出口。

调用点如 [src/providers/claude/claude-kiro.js:633](vscode-webview://02o6oaihn1evl1rnsgsvd6sggap7dcl2ecrpvbkpb2m8s8vmtt5k/src/providers/claude/claude-kiro.js#L633)、[src/providers/gemini/gemini-core.js:266](vscode-webview://02o6oaihn1evl1rnsgsvd6sggap7dcl2ecrpvbkpb2m8s8vmtt5k/src/providers/gemini/gemini-core.js#L266) 都是 provider 级别传参，看不到账号的身影。

## 若要支持，需要改动

1.  **账号池 schema**：给每个账号加可选 `proxyUrl` 字段
2.  **proxy-utils.js**：新增 `getProxyConfigForAccount(accountConfig)`，优先账号级 proxy，回退到全局
3.  **Provider adapters**：claude-kiro、gemini-core、openai-codex 等的代理获取逻辑改为传入选中账号的 config
4.  **前端配置管理 UI**：账号编辑界面支持填写 proxyUrl

* * *

需要我进入规划，设计一下"每账号独立 proxy"的实现方案吗？如果需要，请确认一下几个关键点：

*   账号 proxy 应该**覆盖**全局 proxy，还是**在全局启用**的前提下才生效？
    - 账号 proxy应该**覆盖**全局proxy
*   是否需要支持账号级别的"禁用代理"（显式不走代理，即使全局开启）？
    - 需要支持账号级别的"禁用代理"
*   UI 是否也要同步支持，还是暂时只改配置文件层？
    - UI端同步支持