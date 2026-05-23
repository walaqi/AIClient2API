# Plan: Upgrade `claude-kiro.js` to Kiro 0.12.x protocol — 3-phase rollout

## Context

`src/providers/claude/claude-kiro.js` (in this repo, AIClient2API) implements the
Claude→Kiro bridge against an older Kiro IDE protocol (`KIRO_VERSION = '0.11.63'`,
header `x-amzn-kiro-agent-mode: vibe`, single endpoint chosen by model-name prefix,
fresh `uuidv4()` conversationId every request). The reference implementation in the
sibling `Kiro-account-manager` Electron project — split across
[kiroApi.ts](../../projects/Kiro-account-manager/Kiro-account-manager/src/main/proxy/kiroApi.ts),
[translator.ts](../../projects/Kiro-account-manager/Kiro-account-manager/src/main/proxy/translator.ts),
[types.ts](../../projects/Kiro-account-manager/Kiro-account-manager/src/main/proxy/types.ts),
and [toolNameRegistry.ts](../../projects/Kiro-account-manager/Kiro-account-manager/src/main/proxy/toolNameRegistry.ts) —
runs the newer protocol (`KIRO_VERSION = '0.12.155'`, agent mode `spec` for
SOCIAL/Builder-ID and `vibe` for IDC, three endpoints with 429 fallback,
fingerprint-stable `conversationId`, native `additionalModelRequestFields.thinking`,
explicit `cachePoint` blocks for prompt-cache, a 7-step sanitization pipeline, and
`normalizeToolHistory` to flatten orphan tool_use/tool_result pairs to XML).

Why upgrade:
- Reliability: newer protocol survives 429 by falling back to AmazonQ → AmazonQCLI;
  current code chooses one of two endpoints by model prefix and gives up on 429.
- Multi-turn cache hits: stable `conversationId` (and explicit `cachePoint`) let
  Kiro reuse server-side prompt cache; today every request loses cache because
  conversationId is regenerated.
- Correctness: 7-step sanitize + `normalizeToolHistory` prevents the 400
  "Improperly formed request" we currently mitigate with ad-hoc adjacent-role
  merging and a dummy `Continue` assistant message.
- Native thinking: routing through `additionalModelRequestFields` (Claude 4+ only)
  replaces inline `<thinking>...</thinking>` tag injection in history, which the
  new server rejects.
- IDE parity: full `KiroIDE-${VERSION}-${machineId}` User-Agent + `spec` agent mode
  match what the official IDE sends.

This is a single-file refactor of
[src/providers/claude/claude-kiro.js](src/providers/claude/claude-kiro.js); the AWS
event-stream parser is already factored out into
[src/providers/claude/aws-event-stream-parser.js](src/providers/claude/aws-event-stream-parser.js)
and is already wired up by `streamApiReal`, so the response-side migration is small.
The bulk of the work is on the request-build side (`buildCodewhispererRequest`).

To keep risk and review burden low, the work is split into 3 independently
shippable phases. Each phase compiles, runs, and is verifiable on its own; later
phases assume earlier ones are merged but do not require their semantics to roll
back.

---

## Critical files

- [src/providers/claude/claude-kiro.js](src/providers/claude/claude-kiro.js) — the only file modified across all 3 phases (3616 lines).
- [src/providers/claude/aws-event-stream-parser.js](src/providers/claude/aws-event-stream-parser.js) — already imported at line 23, reused by `streamApiReal`; will become the parser for non-stream too in Phase 1.

Reference (read-only) for protocol shape:
- [kiroApi.ts:111-159](../../projects/Kiro-account-manager/Kiro-account-manager/src/main/proxy/kiroApi.ts#L111-L159) — endpoints, version, User-Agent helpers, agent mode constants.
- [kiroApi.ts:1089-1235](../../projects/Kiro-account-manager/Kiro-account-manager/src/main/proxy/kiroApi.ts#L1089-L1235) — `getAuthHeaders`, `getSortedEndpoints`, `callKiroApiStream` 3-endpoint fallback.
- [translator.ts:447-778](../../projects/Kiro-account-manager/Kiro-account-manager/src/main/proxy/translator.ts#L447-L778) — sanitize helpers + 7-step `sanitizeConversation`.
- [translator.ts:730](../../projects/Kiro-account-manager/Kiro-account-manager/src/main/proxy/translator.ts#L730) — `normalizeToolHistory`.
- [translator.ts:713-942](../../projects/Kiro-account-manager/Kiro-account-manager/src/main/proxy/translator.ts#L713-L942) — `claudeToKiro` (system prompt as Human/AI pair, drops history `reasoningContent`).
- [translator.ts:825-1015](../../projects/Kiro-account-manager/Kiro-account-manager/src/main/proxy/translator.ts#L825-L1015) — `buildKiroPayload`.
- [translator.ts:1022](../../projects/Kiro-account-manager/Kiro-account-manager/src/main/proxy/translator.ts#L1022) — `resolveConversationId` (2h TTL, history fingerprint).
- [translator.ts:1084](../../projects/Kiro-account-manager/Kiro-account-manager/src/main/proxy/translator.ts#L1084) — `kiroToClaudeResponse` (thinking → text → tool_use ordering).
- [toolNameRegistry.ts](../../projects/Kiro-account-manager/Kiro-account-manager/src/main/proxy/toolNameRegistry.ts) — bidirectional name map with FNV-1a hash, ≤64 chars.

---

## Phase 1 — Network + Parser (lowest risk)

**Goal**: bring the transport layer up to 0.12.x without touching request-body
shape. After Phase 1, the bridge survives 429 by falling back to other endpoints,
looks like the real IDE on the wire, and parses non-stream responses through the
same robust binary parser the streaming path already uses.

### 1.1 Bump version + endpoint table

[claude-kiro.js:48](src/providers/claude/claude-kiro.js#L48): `KIRO_VERSION` 
`'0.11.63'` → `'0.12.155'`.

Add a module-level `KIRO_ENDPOINTS` constant mirroring
[kiroApi.ts:111-132](../../projects/Kiro-account-manager/Kiro-account-manager/src/main/proxy/kiroApi.ts#L111-L132):

```
[
  { url: 'https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse',
    origin: 'AI_EDITOR', name: 'CodeWhisperer' },
  { url: 'https://q.us-east-1.amazonaws.com/generateAssistantResponse',
    origin: 'AI_EDITOR', name: 'AmazonQ' },
  { url: 'https://q.us-east-1.amazonaws.com/SendMessageStreaming',
    origin: 'CLI',       name: 'AmazonQCLI' }
]
```

Add `getSortedEndpoints(preferredEndpoint)`. Default order excludes `AmazonQCLI`.
If `preferredEndpoint === 'amazonq-cli'`, ONLY `AmazonQCLI` is used and there is no
fallback. Map today's `model.startsWith('amazonq')` URL switch
([claude-kiro.js:1851](src/providers/claude/claude-kiro.js#L1851),
[claude-kiro.js:2345](src/providers/claude/claude-kiro.js#L2345)) onto this
preferred-endpoint setting (drop the model-prefix heuristic).

### 1.2 3-endpoint fallback in `callApi` and `streamApiReal`

[callApi (line 1822)](src/providers/claude/claude-kiro.js#L1822) and the request
portion of [streamApiReal (line 2316)](src/providers/claude/claude-kiro.js#L2316)
each issue exactly one HTTP request today. Wrap the request in a
`for (const endpoint of getSortedEndpoints(preferred))` loop modeled on
[kiroApi.ts:1150-1230](../../projects/Kiro-account-manager/Kiro-account-manager/src/main/proxy/kiroApi.ts#L1150-L1230):

- `429`: log, save `lastError`, `continue` to next endpoint. Only the LAST endpoint's
  429 escalates into the existing quota-exhausted path.
- `401`/`403`: do NOT fall through — surface immediately so the existing
  credential-refresh path in `callApi` still triggers.
- `5xx`: leave the existing credential-rotation path intact (independent of
  endpoint fallback).
- For `AmazonQCLI` only: clone the payload and
  `delete conversationState.agentContinuationId` /
  `delete conversationState.agentTaskType` before sending
  ([kiroApi.ts:1163-1166](../../projects/Kiro-account-manager/Kiro-account-manager/src/main/proxy/kiroApi.ts#L1163-L1166)).
- Set `conversationState.currentMessage.userInputMessage.origin` to `endpoint.origin`
  per attempt — `AI_EDITOR` for the first two, `CLI` for `AmazonQCLI`. Small helper:
  `applyPayloadOrigin(payload, origin)`.

### 1.3 Headers — full IDE-style User-Agent + agent mode

Today's headers at [claude-kiro.js:668-675](src/providers/claude/claude-kiro.js#L668-L675)
have the right shape but with the old version and a hard-coded
`x-amzn-kiro-agent-mode: vibe`. Replace with helpers ported from
[kiroApi.ts:143-159](../../projects/Kiro-account-manager/Kiro-account-manager/src/main/proxy/kiroApi.ts#L143-L159):

- `getKiroUserAgent(machineId)` →
  `aws-sdk-js/1.0.34 ua/2.1 os/${plat}#${rel} lang/js md/nodejs#${ver} api/codewhispererstreaming#1.0.34 m/E KiroIDE-${KIRO_VERSION}-${machineId}`
- `getKiroAmzUserAgent(machineId)` →
  `aws-sdk-js/1.0.34 KiroIDE ${KIRO_VERSION} ${machineId}`
- For IDC accounts, swap to the rust CLI variant
  (`KIRO_CLI_USER_AGENT`, `KIRO_CLI_AMZ_USER_AGENT`).

Agent mode: SOCIAL/Builder-ID → `spec`; IDC → `vibe`. Today's hard-coded `'vibe'`
flips to `'spec'` for the common case — biggest IDE-parity win.

Per-request: add `amz-sdk-invocation-id: uuidv4()` and
`amz-sdk-request: 'attempt=1; max=3'`
([kiroApi.ts:1099-1100](../../projects/Kiro-account-manager/Kiro-account-manager/src/main/proxy/kiroApi.ts#L1099-L1100)).

### 1.4 Non-stream parser — replace regex SSE with native AWS Event Stream

[parseEventStreamChunk (line 1699)](src/providers/claude/claude-kiro.js#L1699) uses
two ad-hoc regexes plus bracket-style fallback. Reuse
[awsParseEventStreamFrames](src/providers/claude/aws-event-stream-parser.js)
which is already imported at line 23 and already used by `streamApiReal`
([line 2428](src/providers/claude/claude-kiro.js#L2428)).

The non-stream path also needs to consume event types currently silently dropped:
`messageMetadataEvent`, `meteringEvent`, `supplementaryWebLinksEvent`,
`citationEvent`, `codeReferenceEvent`, `reasoningContentEvent`. The native parser
already emits these as typed events; just consume them.

Keep `parseBracketToolCalls` / `deduplicateToolCalls` as a fallback for the rare
case the parser produces nothing — but mark it as fallback with a debug log, not
the primary route.

### Phase 1 verification

1. **Smoke (single-turn)**: send a normal Claude `/v1/messages` request, confirm a
   text reply.
2. **Spec-mode header parity**: capture outgoing request, confirm
   `x-amzn-kiro-agent-mode: spec` (for SOCIAL/Builder-ID) and User-Agent contains
   `KiroIDE-0.12.155-${machineId}`.
3. **429 fallback**: temporarily lower the per-account quota so the first endpoint
   429s. Confirm logs show
   `Endpoint CodeWhisperer quota exhausted, trying next...` and the second
   endpoint succeeds.
4. **AmazonQCLI mode**: set `preferredEndpoint = 'amazonq-cli'`. Confirm payload
   has NO `agentContinuationId` and NO `agentTaskType`, and origin is `CLI`.
5. **Non-stream parse parity**: send a non-stream tool-call request. Confirm tool
   names + arguments come back identical to the regex-parser output for the same
   payload (golden-file diff over a few captured fixtures).

---

## Phase 2 — Request body cleanup (eliminates 400 "Improperly formed request")

**Goal**: rebuild `buildCodewhispererRequest` so the payload matches the new
protocol's invariants. After Phase 2, the dummy `Continue` assistant suffix and the
`web_search`/`no_tool_available` workarounds disappear.

Depends on Phase 1 only for the new endpoint fallback (so a body that works on
CodeWhisperer but not AmazonQ still has a fighting chance).

### 2.1 Drop `modelId` from history; keep only on `currentMessage`

[types.ts:270-279](../../projects/Kiro-account-manager/Kiro-account-manager/src/main/proxy/types.ts#L270-L279)
flags `modelId` as optional ("占位消息不需要"). Today claude-kiro.js sets `modelId`
on every history `userInputMessage`
([claude-kiro.js:1360, 1371, 1390](src/providers/claude/claude-kiro.js#L1360-L1390)).
Strip those — only `currentMessage.userInputMessage` carries `modelId`.

### 2.2 System prompt as Human/AI pair (drop the 3-branch heuristic)

Replace
[claude-kiro.js:1547-1577](src/providers/claude/claude-kiro.js#L1547-L1577) with
the new pattern from
[translator.ts:893-908](../../projects/Kiro-account-manager/Kiro-account-manager/src/main/proxy/translator.ts#L893-L908):
two synthetic history entries at the head:

```
{ userInputMessage:        { content: systemPrompt, origin, userInputMessageContext: {} } }
{ assistantResponseMessage: { content: 'I will follow these instructions.' } }
```

Port translator.ts's pre-injection mutation: prepend
`[Context: Current time is ${ISO timestamp}]\n\n` and append a short
`<execution_discipline>...</execution_discipline>` block to the system prompt
([translator.ts:713-810](../../projects/Kiro-account-manager/Kiro-account-manager/src/main/proxy/translator.ts#L713-L810)
shows the exact strings — copy verbatim so the cache key matches the IDE's output;
this is essential for the Phase 3 cachePoint work).

### 2.3 7-step `sanitizeConversation` pipeline

Replace today's ad-hoc adjacent-role merging + dummy `Continue` assistant suffix
([claude-kiro.js:1469-1478](src/providers/claude/claude-kiro.js#L1469-L1478))
with the pipeline from
[translator.ts:764-778](../../projects/Kiro-account-manager/Kiro-account-manager/src/main/proxy/translator.ts#L764-L778):

```
sanitizeConversation = pipe(
  ensureStartsWithUserMessage,        // L447
  removeEmptyUserMessages,            // L620
  relocateToolResultMessages,         // L480 — moves orphan tool_results next to their tool_use
  removeInvalidToolResultMessages,    // L522
  ensureValidToolUsesAndResults,      // L567 — drops tool_use without matching result
  ensureAlternatingMessages,          // L462 — merges/drops to enforce user/assistant alternation
  ensureEndsWithUserMessage           // L455
)
```

Port each helper as a private method on `KiroApiService` or as module-level
functions. Order is load-bearing — `relocateToolResultMessages` MUST run before
`ensureValidToolUsesAndResults`, and `ensureAlternatingMessages` MUST run after
`removeInvalidToolResultMessages`.

### 2.4 `normalizeToolHistory` orphan flattening

Before sanitize, run
[translator.ts:730 normalizeToolHistory](../../projects/Kiro-account-manager/Kiro-account-manager/src/main/proxy/translator.ts#L730):
when a history message references a tool name that is NOT in the current request's
tools list, flatten the `tool_use` / `tool_result` blocks into XML text:

```
<tool_use name="Foo" id="...">{...input json...}</tool_use>
<tool_result tool_use_id="...">...content...</tool_result>
```

Without flattening, Kiro 400s on the unknown tool reference (common when an old
session referenced tools the current client no longer offers).

### 2.5 Port `ToolNameRegistry`

Today's [shortenKiroToolName](src/providers/claude/claude-kiro.js#L61) uses
SHA-256 + 12-char hex; the new code uses an FNV-1a base36 hash inside a stateful
[ToolNameRegistry](../../projects/Kiro-account-manager/Kiro-account-manager/src/main/proxy/toolNameRegistry.ts)
with bidirectional `originalToKiro` + `kiroToOriginal` Maps and explicit
collision-handling. Port verbatim (60 lines, no dependencies).

Reuse the existing `restoreKiroToolCallNames` ([line 95](src/providers/claude/claude-kiro.js#L95))
on the response side — pass the registry's `kiroToOriginal` Map as the existing
function already expects.

**Decision: keep head+tail+whitelist tool-description truncation.** The new code
uses simple `...` substring truncation at `KIRO_MAX_TOOL_DESC_LEN = 10237`. Our
existing [truncateHeadTailByTool](src/providers/claude/claude-kiro.js#L412) +
adaptive table at
[claude-kiro.js:425-427](src/providers/claude/claude-kiro.js#L425-L427) is strictly
better for tools like `Bash` whose description has critical instructions at both
ends. Deviate intentionally.

Drop the `web_search`/`websearch` filter at
[claude-kiro.js:1206-1213](src/providers/claude/claude-kiro.js#L1206-L1213) and
the `no_tool_available` placeholder at
[claude-kiro.js:1217-1234](src/providers/claude/claude-kiro.js#L1217-L1234). The
recent commit `3e071d4` already moved web_search to the Kiro-native tool spec, and
the placeholder was a workaround for an empty-tools edge case the new sanitize
pipeline handles.

### 2.6 Token-based history trimming

Port [trimHistoryByTokens](../../projects/Kiro-account-manager/Kiro-account-manager/src/main/proxy/translator.ts#L962)
(called from `buildKiroPayload`). Reuses existing
[getContextTokensForModel](src/providers/claude/claude-kiro.js#L196) and the
`MODEL_CONTEXT_TOKENS` table.

The current image-retention logic (drop images from messages older than the last
5) stays as a separate pass that runs BEFORE token-trim — image bytes are heavy.

### Phase 2 verification

1. **Tool round-trip (multi-turn)**: send a request with a `Bash`-style tool
   definition, force a tool_use response, send back a tool_result. Confirm:
   - No 400 "Improperly formed request".
   - Tool name correctly restored on the response side.
2. **Sanitize regression**: send a malformed conversation (orphan tool_use with no
   tool_result, two consecutive user messages, empty user message). Confirm
   request still succeeds and the dummy `Continue` assistant suffix is no longer
   needed (search the outgoing payload to confirm it's absent).
3. **Orphan tool flatten**: send history that references a tool name not present
   in the current `tools` list. Confirm it appears as
   `<tool_use name="...">...` text and the request succeeds.
4. **System prompt cache key**: dump the outgoing payload and confirm the system
   prompt is identical byte-for-byte to what `kiroApi.ts` produces for the same
   input (timestamp difference excepted). Required for Phase 3 cache hits.

---

## Phase 3 — Cache + Thinking (advanced features, smallest commit)

**Goal**: turn on the features that depend on the Phase 2 body shape — stable
conversationId, native thinking, prompt-cache markers.

Depends on Phase 2: cachePoint + conversationId fingerprint cache only pay off
when the system prompt is byte-stable across requests, which Phase 2 establishes.

### 3.1 `conversationId` stabilization (2h TTL fingerprint cache)

Today's `buildCodewhispererRequest` regenerates `uuidv4()` per request at
[claude-kiro.js:1099](src/providers/claude/claude-kiro.js#L1099) — every request
is a "new conversation" to Kiro, so prompt cache never hits.

Add a module-level `resolveConversationId(history, sessionHint?)` modeled on
[translator.ts:1022](../../projects/Kiro-account-manager/Kiro-account-manager/src/main/proxy/translator.ts#L1022):
- LRU `Map` keyed by `sessionHint || historyFingerprint(history)`.
- `historyFingerprint` = stable hash (FNV-1a or SHA-256 over the first N user
  message contents — recipe matches translator.ts).
- TTL 2h; on hit return cached id, on miss generate `uuidv4()` and store with
  insertion timestamp.
- Cap entries (~256), evict oldest.

Call site change in `buildCodewhispererRequest`:
```
const conversationId = resolveConversationId(messages, requestBody?.metadata?.session_id);
```

### 3.2 Thinking → `additionalModelRequestFields.thinking` (Claude 4+ only)

Today's [_generateThinkingPrefix](src/providers/claude/claude-kiro.js#L1033)
inlines `<thinking_mode>adaptive</thinking_mode>...` tags into user content, and
history `<thinking>...</thinking>` blocks are kept as text. Both are wrong for the
new protocol:

- New shape (matches [translator.ts](../../projects/Kiro-account-manager/Kiro-account-manager/src/main/proxy/translator.ts) `claudeToKiro`):
  `payload.additionalModelRequestFields = { thinking: { type: 'adaptive' } }` for
  Claude 4+ models only. Skip for Claude 3.x.
- History `reasoningContent` MUST be DISCARDED before sending — keeping it
  triggers a 400 "Improperly formed request".
- Stop injecting `KIRO_THINKING.START_TAG`/`END_TAG` text into outgoing user
  content. The constants ([claude-kiro.js:26-35](src/providers/claude/claude-kiro.js#L26-L35))
  remain ONLY for parsing inbound streamed thinking text.

### 3.3 `cachePoint` support

[types.ts:308-316](../../projects/Kiro-account-manager/Kiro-account-manager/src/main/proxy/types.ts#L308-L316)
shows `KiroToolWrapper` is a union — either a `toolSpecification` or a
`{ cachePoint: { type: 'default' } }` marker. Same applies to the synthetic
system-prompt user message.

For this pass: emit a single `cachePoint: { type: 'default' }` at the end of the
tools list and on the synthetic system-prompt user message. Matches what the IDE
emits for a typical session and is the minimum needed to enable server-side
prompt cache. Do not expose finer-grained cache control to clients in this pass.

### Phase 3 verification

1. **Thinking on Claude 4+**: send `thinking: { type: 'adaptive' }`. Confirm the
   outgoing payload has `additionalModelRequestFields.thinking.type === 'adaptive'`
   and contains NO `<thinking_mode>` text in user content. Confirm reasoning
   blocks come back as `thinking` content blocks, not text wrapped in tags.
2. **Thinking on Claude 3.x**: send the same request with a Claude 3.5 model.
   Confirm `additionalModelRequestFields` is absent (or empty) — no thinking field
   leaks.
3. **conversationId stability**: send the same message twice within 2h with the
   same session hint. Confirm the second request's logged `conversationId` is
   identical to the first.
4. **Cache hit observable**: same setup as (3). The second request's logged
   `inputTokens` should drop materially (Kiro reports cache reads via
   `cacheReadTokens` in the metering event — confirm it's > 0).
5. **History reasoning drop**: send a request with prior assistant turns
   containing `reasoningContent`. Confirm the outgoing payload has no
   `reasoningContent` fields anywhere in `history`.

---

## Out of scope (all phases)

- Refactoring the `streamApiReal` event-handling switch — already uses the native
  parser correctly; only its request-side endpoint loop changes (Phase 1).
- Refresh-token / IDC token plumbing — orthogonal; new headers re-use whatever
  tokens the existing credential manager produces.
- The `fetchKiroModels` / `fetchAvailableSubscriptions` GET endpoints from
  kiroApi.ts (1848+) — not used by claude-kiro.js's hot path. Defer.
- Replacing head+tail tool-description truncation with simple `...` (keep the
  better local strategy — see §2.5).
