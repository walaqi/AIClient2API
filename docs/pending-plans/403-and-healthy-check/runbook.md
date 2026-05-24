# Health-Check 403/502/429 Runbook（运维侧）

本文是诊断
[`docs/pending-plans/403-and-healthy-check/analysis-result.txt`](analysis-result.txt)
里 P1-2 条目的运维落地说明，**不属于代码修复**。代码侧已完成的改动（refresh-502 自动旋转 +
dedup 等待 in-flight refresh + 429 cooldown）见同目录下的修复 plan。

## 背景

诊断 log 表明：访问 Cognito refreshToken 端点（`prod.us-east-1.auth.desktop.kiro.dev/refreshToken`）
时，Decodo sticky-session 命名规则与时长共同决定 502 命中率。

实测形态：

| ACCOUNT_PROXY_URL                                   | refresh / probe 结果 |
|-----------------------------------------------------|----------------------|
| `session-{随机}-sessionduration-1440`               | 高概率 502 + 后续 403 |
| `session-kiroXX-sessionduration-1440`（kiro66/77）  | 全部 200             |
| `session-{随机}-sessionduration-60`（kiro8 形态）   | 全部 200             |

代码修复后，`_rotateProxySession` 会在 502 时把 session 名替换为 6 字符随机串，但**旋转出
的仍是随机命名**。要真正避开"命名规则触发上游 502"这一类系统性问题，需要从运维侧把
"种子" session 名换成稳定 / 业务可读的命名。

## 操作步骤

### 方式 A：通过 UI 修改

1. 打开 UI → 提供商管理 → 找到目标 Kiro 账号（kiro-1 ~ kiro-N）。
2. 进入"编辑"面板，定位到 `ACCOUNT_PROXY_URL` 字段。
3. 把 `session-{xxxxx}-sessionduration-1440` 改成
   `session-kiro{N}-sessionduration-60`（推荐）或
   `session-kiro{N}-sessionduration-1440`。
4. 保存；下一次健康检查会用新 URL。

### 方式 B：直接改 `provider_pools.json`

```bash
# 备份
cp configs/provider_pools.json configs/provider_pools.json.bak

# 用 jq 把所有 kiro 账号的 ACCOUNT_PROXY_URL 改名为 kiro{index}-60
jq '.kiro_api |= (
  to_entries |
  map(.value.ACCOUNT_PROXY_URL |=
    (sub("session-[^-]+-sessionduration-[0-9]+";
         "session-kiro\(.key|tonumber + 1)-sessionduration-60"))) |
  from_entries
)' configs/provider_pools.json > /tmp/pp.json && \
mv /tmp/pp.json configs/provider_pools.json

# 重启服务以重新加载 axios 实例上的代理 agent
```

> 注意：jq 表达式按字段对应的 provider 类型与文件 schema 调整；本仓库的 provider_pools
> 实际结构请用 `jq 'keys'` 先看一眼再套用。

## 验证

修改完成后跑一轮调度健康检查（默认 60s 周期）或在 UI 触发"手动检查"，对照
`logs/log-grepped-{date}.log`：

- refresh 200（无 502）。
- probe 200（无 403）。
- `ACCOUNT_PROXY_URL`（持久化）/ `axiosInstance.defaults` /
  `axiosSocialRefreshInstance.defaults` 三处的 proxy URL 一致；如果代码侧
  `_applyProxyToInstances` 的修复已合入，旋转后也会保持一致。

## 提醒

- 代码修复让 refresh-502 也会自动旋转 session，但旋转**仍然是随机 6 字符名**。运维侧
  先把"种子"改成稳定命名才是根除路径，否则在不利的随机命名下还是会再次踩坑。
- 如果团队偏好按账号绑定固定 session，建议把命名规则写进 onboarding 文档：
  `session-{accountTag}-sessionduration-{60|1440}`，避免后续运维同事再随机生成。
