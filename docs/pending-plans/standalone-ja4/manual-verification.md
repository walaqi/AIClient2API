# 每账号独立浏览器指纹 — 手动验证指引

## 前置条件

```bash
# 1. 编译 sidecar
cd tls-sidecar
GOPROXY=https://goproxy.cn,direct GONOSUMCHECK=* GONOSUMDB=* go build -o tls-sidecar .

# 2. 启动 sidecar（测试端口）
TLS_SIDECAR_PORT=9090 ./tls-sidecar
```

## 验证 1：Health Endpoint

```bash
curl http://127.0.0.1:9090/health | jq .
```

期望输出：
```json
{"status":"ok","tls":"utls-multi-profile","protocols":"h2,http/1.1","profiles":"..."}
```

## 验证 2：不同 Profile 的 JA3/JA4 差异

使用 https://tls.peet.ws/api/all（返回 JSON 格式的 TLS 指纹信息）：

```bash
# Chrome 120
curl -s http://127.0.0.1:9090 \
  -H "X-Target-Url: https://tls.peet.ws/api/all" \
  -H "X-Tls-Profile: HelloChrome_120" | jq '{ja3_hash: .tls.ja3_hash, ja4: .tls.ja4, peetprint: .tls.peetprint_hash}'

# Chrome 133
curl -s http://127.0.0.1:9090 \
  -H "X-Target-Url: https://tls.peet.ws/api/all" \
  -H "X-Tls-Profile: HelloChrome_133" | jq '{ja3_hash: .tls.ja3_hash, ja4: .tls.ja4, peetprint: .tls.peetprint_hash}'

# Firefox 120
curl -s http://127.0.0.1:9090 \
  -H "X-Target-Url: https://tls.peet.ws/api/all" \
  -H "X-Tls-Profile: HelloFirefox_120" | jq '{ja3_hash: .tls.ja3_hash, ja4: .tls.ja4, peetprint: .tls.peetprint_hash}'
```

**期望**：Chrome 和 Firefox 的 ja3_hash/ja4 明显不同。Chrome 120 和 133 的 ja4 也应不同（cipher suite 集合不同）。

## 验证 3：无效 Profile 返回 400

```bash
curl -v http://127.0.0.1:9090 \
  -H "X-Target-Url: https://httpbin.org/get" \
  -H "X-Tls-Profile: InvalidProfile"
```

期望：HTTP 400 + 错误信息包含 "invalid X-Tls-Profile"。

## 验证 4：指纹生成确定性

```bash
node -e "
import { generateFingerprint } from './src/utils/fingerprint-generator.js';
const uuid = 'test-account-uuid-12345';
const fp1 = generateFingerprint(uuid, 'grok-web', 0);
const fp2 = generateFingerprint(uuid, 'grok-web', 0);
console.log('Deterministic:', JSON.stringify(fp1) === JSON.stringify(fp2));
console.log('Profile:', fp1.ACCOUNT_TLS_PROFILE);
console.log('UA:', fp1.ACCOUNT_USER_AGENT);
console.log('sec-ch-ua:', fp1.ACCOUNT_SEC_CH_UA);
console.log('Platform:', fp1.ACCOUNT_PLATFORM, fp1.ACCOUNT_PLATFORM_VERSION);
"
```

## 验证 5：指纹轮换

```bash
node -e "
import { generateFingerprint } from './src/utils/fingerprint-generator.js';
const uuid = 'test-account-uuid-12345';
const fp0 = generateFingerprint(uuid, 'grok-web', 0);
const fp1 = generateFingerprint(uuid, 'grok-web', 1);
console.log('Gen 0:', fp0.ACCOUNT_TLS_PROFILE, fp0.ACCOUNT_PLATFORM);
console.log('Gen 1:', fp1.ACCOUNT_TLS_PROFILE, fp1.ACCOUNT_PLATFORM);
console.log('Different:', fp0.ACCOUNT_TLS_PROFILE !== fp1.ACCOUNT_TLS_PROFILE || fp0.ACCOUNT_PLATFORM !== fp1.ACCOUNT_PLATFORM);
"
```

## 验证 6：端到端（启动服务后）

1. 启动服务，确保 `TLS_SIDECAR_ENABLED=true` 且 `TLS_SIDECAR_ENABLED_PROVIDERS` 包含 `grok-web`
2. 查看 `configs/provider_pools.json`，确认 Grok 账号已自动填充 `ACCOUNT_TLS_PROFILE` 等字段
3. 发送一个 Grok 请求，观察 sidecar 日志中的 profile 名称是否与账号配置一致
4. 对比两个不同 Grok 账号的请求日志，确认使用了不同的 profile

## 验证 7：向后兼容

1. 删除某个账号的 `ACCOUNT_TLS_PROFILE` 字段，重启服务
2. 确认该账号自动重新生成了相同的指纹（确定性派生）
3. 确认无 `X-Tls-Profile` 头时 sidecar 默认使用 Chrome_Auto

## 指纹轮换操作

当某个账号被封禁需要更换指纹时：

```bash
# 在 configs/provider_pools.json 中找到对应账号，递增 ACCOUNT_FINGERPRINT_GENERATION
# 例如从 0 改为 1，然后清空 ACCOUNT_TLS_PROFILE 字段
# 重启服务后会自动生成新指纹
```

或者直接清空所有 ACCOUNT_* 指纹字段并修改 generation，服务启动时会自动重新生成。
