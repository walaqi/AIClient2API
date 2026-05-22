# Plan: Add Account Proxy Validation to Health Check

## Context

The health check currently only validates API connectivity (sends a test request to the provider). We need to add proxy geo-validation: verify that the configured `ACCOUNT_PROXY_URL` exits through an expected location. If the proxy exits elsewhere, rotate the session ID in the proxy URL and retry up to 5 times. This ensures requests always route through the correct geographic endpoint.

The proxy URL format is like: `https://city-los_angeles-session-kiro9-sessionduration-60.gate.decodo.com:7000`

The session segment (`session-XXXXX-sessionduration`) needs its identifier rotated — replace the part between `session-` and `-sessionduration` with 6 random lowercase letters to force a new exit IP.

Validation rules are configured in `config.json` under `PROXY_GEO_VALIDATE_RULES` (array). Each rule has `country` + `city`. A proxy is valid if it matches **any** rule (OR logic).

## Implementation

### 1. Add config field `PROXY_GEO_VALIDATE_RULES` to `config.json`

**File:** `configs/config.json`

```json
"PROXY_GEO_VALIDATE_RULES": [
  {"country": "美国", "city": "洛杉矶"}
]
```

### 2. Add `_checkAccountProxy` method to `ProviderPoolManager`

**File:** `src/providers/provider-pool-manager.js`

Add a new private method `_checkAccountProxy(providerType, providerConfig)` that:

1. Checks if `ACCOUNT_PROXY_URL` is set (non-empty string). If not, returns `{ success: true, skipped: true }`.
   - If `ACCOUNT_PROXY_DISABLED === true`, skip validation (proxy won't be used for API calls, no point validating).
2. Reads `PROXY_GEO_VALIDATE_RULES` from `this.globalConfig`. If not configured or empty array, skip validation (return success).
3. Calls `parseProxyUrl` on the URL. If it returns `null`, return `{ success: false, errorMessage: "Invalid ACCOUNT_PROXY_URL format" }`.
4. Creates an axios instance with the proxy agents:
   - Timeout: 5 seconds (geo API responds fast; shorter timeout reduces health check duration)
   - TLS verification: enabled (default axios behavior)
   - Note: timeout and retry count (5) are hardcoded by design — not configurable.
   - Use dynamic `import('axios')` (matching existing pattern at line 735).
5. Makes a GET request to `http://ip-api.com/json/?lang=zh-CN`.
6. Parses the JSON response: checks `status === "success"`, then extracts `country` and `city`.
7. Checks if any rule in `PROXY_GEO_VALIDATE_RULES` matches: `rule.country === response.country && rule.city === response.city`.
8. If matched → return `{ success: true, proxyUrl: currentUrl }`.
9. If not matched, call `_rotateProxySession`. If it returns `null` (no session pattern in URL), immediately return failure — no point retrying.
10. Retry up to 5 times with rotated session (initial check + 5 retries = 6 total requests max).
11. If a retry succeeds → update `providerConfig.ACCOUNT_PROXY_URL` in memory and trigger save. Return success with new URL.
12. If all 5 retries fail → return `{ success: false, errorMessage: "Proxy geo-validation failed: got {country} - {city}" }`.

Log prefix: `[ProxyGeoCheck]` for all log messages in this feature.

### 3. Add `_rotateProxySession` helper

**File:** `src/providers/provider-pool-manager.js`

A small helper that takes a proxy URL string and replaces the session identifier:
- Regex: `/session-([a-zA-Z0-9]+)-sessionduration/`
- Replace the captured group with 6 new random lowercase letters.
- Example: `session-kiro9-sessionduration` → `session-abcxyz-sessionduration`
- If regex doesn't match, log a warning `[ProxyGeoCheck] Proxy URL does not contain session pattern, cannot rotate` and return `null`.

### 4. Integrate into `performHealthChecks` and `performInitialHealthChecks`

**File:** `src/providers/provider-pool-manager.js`

In both methods, **before** calling `_checkProviderHealth`:

**In `performHealthChecks()`** (~line 2147):
```javascript
const proxyResult = await this._checkAccountProxy(providerType, provider.config);
if (!proxyResult.success) {
    failCount++;
    this.markProviderUnhealthyImmediately(providerType, provider.config, proxyResult.errorMessage);
    continue;
}
```

**In `performInitialHealthChecks()`** (~line 2041):
```javascript
const proxyResult = await this._checkAccountProxy(providerType, providerConfig);
if (!proxyResult.success) {
    this.markProviderUnhealthy(providerType, providerConfig, proxyResult.errorMessage);
    continue;
}
```

Note: `performInitialHealthChecks` uses `markProviderUnhealthy` (gradual) while `performHealthChecks` uses `markProviderUnhealthyImmediately` — matching each method's existing error handling pattern.

### 5. Update proxy URL in memory and persist

When `_checkAccountProxy` finds a working session after rotation:
- Update `providerConfig.ACCOUNT_PROXY_URL` directly (this is the in-memory object referenced by `provider.config`).
- Call `this._debouncedSave(providerType)` to persist to `provider_pools.json`.

## Files to Modify

- `configs/config.json` — add `PROXY_GEO_VALIDATE_RULES` field
- `src/providers/provider-pool-manager.js` — add `_checkAccountProxy`, `_rotateProxySession`, integrate into both health check methods

## Key Reusable Code

- `parseProxyUrl()` from `src/utils/proxy-utils.js` (line 38) — creates proxy agents from URL
- `_debouncedSave(providerType)` (line 2374) — persists config changes
- `markProviderUnhealthyImmediately()` (line 1664) — marks provider unhealthy
- `markProviderUnhealthy()` — gradual unhealthy marking (for initial checks)

## Verification

1. Add `PROXY_GEO_VALIDATE_RULES` to `config.json` with `[{"country": "美国", "city": "洛杉矶"}]`
2. Set an `ACCOUNT_PROXY_URL` with a session pattern in `provider_pools.json`
3. Start the server and trigger a health check
4. Check logs for `[ProxyGeoCheck]` messages
5. Verify that if the proxy returns wrong geo, it rotates and retries
6. Verify `provider_pools.json` is updated with the new proxy URL on success
