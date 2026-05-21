# Fix: reasoning event path missing thinking block `content_block_stop`

## Context

In [claude-kiro.js](src/providers/claude/claude-kiro.js), there are two paths that produce thinking deltas:

1. **Content path** (line 2635-2701): Parses `<thinking>` XML tags, sets `streamState.inThinking = true`, and emits `stopBlock` when `</thinking>` is found.
2. **Reasoning path** (line 2731-2735): Handles `{ type: 'reasoning' }` events directly, calls `createThinkingDeltaEvents()` which opens the block via `ensureBlockStart('thinking')`, but **never sets `streamState.inThinking`**.

At stream end (line 2912), the close logic only fires if `streamState.inThinking === true`. Since the reasoning path never sets this flag, the thinking block's `content_block_stop` is never emitted.

## Fix

Add `stopBlock(streamState.thinkingBlockIndex)` at stream end (line 2955), just before the existing `stopBlock(streamState.textBlockIndex)`.

This is safer than setting `streamState.inThinking = true` in the reasoning path because:
- Setting `inThinking` would cause the content event handler's buffer loop (line 2675) to look for `</thinking>` end tags in regular text if a content event arrives after reasoning events
- `stopBlock` already guards against null indices and double-stops via `stoppedBlocks` Set
- If the XML tag path already closed the thinking block, the duplicate is harmlessly skipped

### Concrete change

In [src/providers/claude/claude-kiro.js:2955](src/providers/claude/claude-kiro.js#L2955), change:

```javascript
yield* pushEvents(stopBlock(streamState.textBlockIndex));
```

to:

```javascript
yield* pushEvents(stopBlock(streamState.thinkingBlockIndex));
yield* pushEvents(stopBlock(streamState.textBlockIndex));
```

## File to modify

- [src/providers/claude/claude-kiro.js:2955](src/providers/claude/claude-kiro.js#L2955)

## Verification

1. Run the project with a model that returns `reasoning` events (not `<thinking>` tags)
2. Confirm the SSE stream now includes `content_block_stop` for the thinking block (index 0)
3. Verify the XML tag path still works correctly (no duplicate stop events due to `stoppedBlocks` guard)
