# Fix: Unhealthy nodes don't use refresh_token to recover

## Context

User reported: "当被标记为unhealthy的时候, 好像不会去使用refreshtoken进行刷新" — when a credential is marked unhealthy, the system does not use its refresh_token to refresh.

This is real. There's a gap in the recovery path:

- **`warmupNodes`** at [src/providers/provider-pool-manager.js:212](src/providers/provider-pool-manager.js#L212) is the main proactive refresh driver, but its filter `p.config.isHealthy && !p.config.isDisabled && ...` **excludes unhealthy nodes**. So warmup never refreshes them.
- **`checkAndRefreshExpiringNodes`** at [src/providers/provider-pool-manager.js:138](src/providers/provider-pool-manager.js#L138) does include unhealthy nodes (only `isDisabled` is excluded at line 164), but it only triggers a refresh when the credential file's `expiry_date` is within `CRON_NEAR_MINUTES`. A node whose access_token has been revoked or invalidated mid-life — but whose timestamp still says "valid" — never enters this path.
- **`_checkProviderHealth`** at [src/providers/provider-pool-manager.js:2269](src/providers/provider-pool-manager.js#L2269) calls `serviceAdapter.generateContent(...)` directly (line 2314) without first refreshing the token. If an unhealthy node's access_token is dead, the probe fails with an auth error and `performHealthChecks` re-marks it unhealthy. The node stays stuck.
- **`_checkAndRecoverScheduledProviders`** at [src/providers/provider-pool-manager.js:1961](src/providers/provider-pool-manager.js#L1961) flips `isHealthy = true` when the 429 cooldown elapses, without verifying the token still works.

Net effect: an unhealthy OAuth node with a valid refresh_token but a dead access_token cannot recover on its own — except by waiting for its credential expiry timestamp to approach. That's the bug.

Intended outcome: unhealthy OAuth nodes attempt a token refresh as part of their health-check recovery path, so a still-valid refresh_token brings them back into rotation promptly.

## Approach

Insert a pre-probe **force refresh** in `_checkProviderHealth` that fires when the provider is currently unhealthy AND is an OAuth provider. Use `forceRefreshToken()` (not the gated `refreshToken()`) since the access_token is suspect regardless of its expiry timestamp. Guard with `refreshingUuids` to avoid double-firing alongside `checkAndRefreshExpiringNodes`. On refresh failure, fall through to the probe so the existing fail-and-mark-unhealthy machinery still handles the outcome.

This is the cleanest place because:
- `_checkProviderHealth` already has the constructed `serviceAdapter`.
- Both callers (`performHealthChecks`, `performInitialHealthChecks`) get the fix without duplicate guard logic.
- It keeps the gating decision ("only if currently unhealthy") next to the probe that depends on it.

### Gating: duck-type on OAuth credential path fields

`BaseAdapter.forceRefreshToken` at [src/providers/adapter.js:85](src/providers/adapter.js#L85) **throws** `Error("Method 'forceRefreshToken()' must be implemented.")` rather than returning `false`. A naive `typeof serviceAdapter.forceRefreshToken === 'function'` check would pass for any subclass — including hypothetical future static-key adapters that don't override the method — and the throw would fall into the catch and spam `[HealthCheck] Force refresh failed …` logs on every probe forever.

So the gate uses **OAuth credential-path field presence** on `providerConfig`, mirroring the pattern at [provider-pool-manager.js:149-159](src/providers/provider-pool-manager.js#L149-L159). Static-key and non-standard-OAuth adapters (OpenAI / OpenAIResponses / Claude / Forward / Grok) carry `OPENAI_*` / `CLAUDE_*` / `FORWARD_*` / `XAI_*` fields, not `*_OAUTH_CREDS_FILE_PATH`, so the block is skipped synchronously without ever calling `forceRefreshToken`.

(Footnote on Grok: `GrokApiServiceAdapter.forceRefreshToken` at [adapter.js:683](src/providers/adapter.js#L683) does perform a real refresh via `grokApiService.refreshToken()`, but Grok's credential model — cookie/session-based rather than standard OAuth refresh-token exchange — is intentionally outside this PR's scope. The duck-type gate excludes it correctly via the absence of `*_OAUTH_CREDS_FILE_PATH`. Generalizing the recovery path to Grok would require its own design pass.)

(Note: at present every adapter at [adapter.js](src/providers/adapter.js) — including all static-key ones — does override `forceRefreshToken` to return `false`. The duck-type gate is defensive against future adapters that inherit the throwing base.)

## Change

File: [src/providers/provider-pool-manager.js](src/providers/provider-pool-manager.js)

Insert the following block in `_checkProviderHealth` immediately after `const serviceAdapter = getServiceAdapter(tempConfig);` ([line 2292](src/providers/provider-pool-manager.js#L2292)) and before the `_buildHealthCheckRequests` call ([line 2295](src/providers/provider-pool-manager.js#L2295)):

```js
// Pre-probe force-refresh for unhealthy OAuth nodes: if the access_token is dead
// but the refresh_token is still valid, exchange it before the probe so the node
// can recover. Static-key providers are excluded by absence of an OAuth creds path.
const oauthCredsPath =
    providerConfig.KIRO_OAUTH_CREDS_FILE_PATH ||
    providerConfig.GEMINI_OAUTH_CREDS_FILE_PATH ||
    providerConfig.ANTIGRAVITY_OAUTH_CREDS_FILE_PATH ||
    providerConfig.QWEN_OAUTH_CREDS_FILE_PATH ||
    providerConfig.IFLOW_OAUTH_CREDS_FILE_PATH ||
    providerConfig.CODEX_OAUTH_CREDS_FILE_PATH;

if (!providerConfig.isHealthy && oauthCredsPath) {
    const uuid = providerConfig.uuid;
    if (this.refreshingUuids.has(uuid)) {
        this._log('debug', `[HealthCheck] ${this._getDisplayName(providerConfig)} (${providerType}) already refreshing; skipping pre-probe refresh.`);
    } else {
        this.refreshingUuids.add(uuid);
        try {
            this._log('info', `[HealthCheck] Force-refreshing token for unhealthy node ${this._getDisplayName(providerConfig)} (${providerType}) before probe.`);
            await this._awaitRefreshWithTimeout(
                serviceAdapter.forceRefreshToken(),
                providerType,
                this._getDisplayName(providerConfig)
            );
            // Bookkeeping intentionally deferred: if the probe below succeeds,
            // markProviderHealthy() resets refreshCount/lastRefreshTime/etc.
            // (provider-pool-manager.js:1753-1756). If the probe fails, the
            // refresh outcome doesn't earn the node a clean bill of health, so
            // leaving counters untouched matches the "probe is the source of
            // truth" model used by performHealthChecks.
        } catch (err) {
            this._log('warn', `[HealthCheck] Force refresh failed for ${this._getDisplayName(providerConfig)} (${providerType}): ${err.message}. Proceeding to probe.`);
        } finally {
            this.refreshingUuids.delete(uuid);
        }
    }
}
```

### Existing utilities reused

- `serviceAdapter.forceRefreshToken()` — implemented on every OAuth adapter at [src/providers/adapter.js](src/providers/adapter.js) (Gemini :145, Antigravity :214, Kiro :404, Qwen :482, iFlow :539, Codex :593). Static-key adapters either return `false` or are skipped by the credential-path gate.
- `_awaitRefreshWithTimeout` — [src/providers/provider-pool-manager.js:548](src/providers/provider-pool-manager.js#L548). Same timeout protection used by `_refreshNodeToken`.
- `refreshingUuids` set — already used by `_enqueueRefresh` and `_refreshNodeToken` to serialize refreshes across paths.
- OAuth credential-path field detection — mirrors [provider-pool-manager.js:149-159](src/providers/provider-pool-manager.js#L149-L159).
- `_awaitRefreshWithTimeout` ([line 561](src/providers/provider-pool-manager.js#L561)) wraps its argument with `Promise.race([Promise.resolve(refreshOperation), timeoutPromise])`, so a non-Promise return (e.g., a static-key adapter returning `false` synchronously) resolves cleanly without throwing.

### Why no explicit `refreshCount` / `lastRefreshTime` reset on success

`markProviderHealthy` ([line 1742](src/providers/provider-pool-manager.js#L1742)) already resets `refreshCount = 0` (L1753) and `lastRefreshTime = Date.now()` (L1756) when the probe passes. Doing it here too would just be a redundant `_debouncedSave` flush.

For the refresh-success-but-probe-fails edge case, leaving counters untouched is also correct: a successful refresh whose subsequent probe fails has not earned the node a clean bookkeeping reset. `markProviderUnhealthy(Immediately)` will then run on the failed probe path with the original `refreshCount`/`lastRefreshTime` intact, which is the same state model the existing health-check loop assumes.

### Why this does not increment `refreshCount`

`refreshCount` tracks consecutive failures of the queue-driven `_refreshNodeToken` path; reaching 5 there triggers `markProviderUnhealthyImmediately` ([line 527](src/providers/provider-pool-manager.js#L527)). The pre-probe refresh is a recovery attempt, not a queued refresh — counting it would cause a long-broken node's health checks to redundantly trigger the same unhealthy-marking that the probe-failure path already handles.

## Out of scope

`_checkAndRecoverScheduledProviders` at [provider-pool-manager.js:1961](src/providers/provider-pool-manager.js#L1961) has the same class of bug: when a 429 cooldown elapses, it flips `isHealthy = true` at L1977 without verifying the access_token still works. A node whose token died during the cooldown returns to rotation and fails on the next user request.

This PR is **deliberately scoped to the periodic health-check path** to keep the change small and reviewable. Fixing the cooldown-recovery path is a separate concern (it lacks an existing probe and is driven by user-traffic timing rather than cron) and is left for a follow-up issue.

## Operational note: worst-case health-check duration

`performHealthChecks` ([line 2089](src/providers/provider-pool-manager.js#L2089)) iterates providers serially with `for...of`. With this change, each unhealthy OAuth node incurs up to `refreshTaskTimeoutMs` (the `_awaitRefreshWithTimeout` budget) before its probe runs, plus the existing 15s probe timeout. Worst case: `N × (refreshTaskTimeoutMs + 15s)` for N unhealthy OAuth nodes when the IDP is unreachable.

This is a degradation of the worst-case window only — the happy path (fast refresh + fast probe) is essentially unchanged. Operators with large pools may want to verify their `healthCheckInterval` is comfortably greater than this worst case.

## Critical files

- [src/providers/provider-pool-manager.js](src/providers/provider-pool-manager.js) — the only file modified. Insertion at ~line 2293.
- [src/providers/adapter.js](src/providers/adapter.js) — read-only reference; confirms `forceRefreshToken()` is implemented across all adapters.
- [configs/provider_pools.json](configs/provider_pools.json) — read-only; used to set up verification scenarios.

## Verification

Manual test against a real OAuth node (Kiro / Gemini / Qwen):

1. **Setup**: In `configs/provider_pools.json`, pick one node and set `isHealthy: false`, `lastErrorTime` to a timestamp older than `healthCheckInterval`, clear `scheduledRecoveryTime`.

2. **Invalidate the access token but keep refresh_token valid**: In the credentials file (`KIRO_OAUTH_CREDS_FILE_PATH` / `GEMINI_OAUTH_CREDS_FILE_PATH` / etc.), replace `access_token` with garbage. Leave `refresh_token` intact. Set `expiry_date` to far future so `checkAndRefreshExpiringNodes` doesn't preempt the new path.

3. **Confirm bug repro before fix** (optional): Trigger `performHealthChecks()` via the schedule. Logs show probe failure, node stays unhealthy.

4. **Happy path — apply fix, trigger again**: Look for, in order:
   - `[HealthCheck] Force-refreshing token for unhealthy node <name> ... before probe.`
   - Adapter-side line, e.g. `[Kiro] Force refreshing token...`
   - `[ScheduledHealthCheck] <name> PASSED ...`
   - `configs/provider_pools.json` shows `isHealthy: true`, `errorCount: 0`, `refreshCount: 0`, fresh `lastRefreshTime` (all set by `markProviderHealthy`, not the inserted block).
   - Credentials file shows a new `access_token` and updated `expiry_date`.

5. **Race guard**: While `checkAndRefreshExpiringNodes` is refreshing the same UUID, trigger a health check. Expect log `[HealthCheck] ... already refreshing; skipping pre-probe refresh.` followed by the probe.

6. **Refresh-fail fallthrough**: Corrupt the `refresh_token` too. Expect `[HealthCheck] Force refresh failed ... Proceeding to probe.`, the probe to fail, and the node to be re-marked unhealthy via the existing `markProviderUnhealthy(Immediately)` path. No infinite loop.

7. **Refresh-success-but-probe-fails edge case**: After the refresh succeeds, immediately invalidate the *new* access_token (e.g., revoke it server-side or replace it before the probe runs — easiest is to mock the adapter's `generateContent` to throw). Expect:
   - The Force-refreshing log line.
   - The probe failure path running normally and calling `markProviderUnhealthy(Immediately)`.
   - `refreshCount` and `lastRefreshTime` left at their pre-call values (not artificially reset by the inserted block).

8. **Static-key sanity (current adapters)**: Mark an OpenAI / Claude / Forward / Grok node unhealthy. Expect no `Force-refreshing token` log line — the OAuth credential-path gate skips the block synchronously — and the probe runs unchanged.

9. **Static-key sanity (defensive, optional)**: To exercise the duck-type gate's defensive purpose, hand-edit a static-key provider's config to add a stray `KIRO_OAUTH_CREDS_FILE_PATH` field pointing at a nonexistent file, mark unhealthy, and trigger a health check. Expect the block to enter, the adapter's `forceRefreshToken` to return `false` (current behavior) and *not* throw, and the probe to run. This confirms a future inheriting adapter would not produce a "Force refresh failed" log spam loop. (Revert the config edit afterwards.) — Optional regression-shape test; primarily of value if someone later considers reverting the duck-type gate to a `typeof === 'function'` check.
