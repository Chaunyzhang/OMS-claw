# OMS Summary Compaction Design

Date: 2026-05-08

## Conclusion

OMS summaries now follow the same basic shape as lossless-claw:

```text
raw_messages
  -> leaf summaries from old contiguous raw chunks
  -> rollup summaries from same-level summary chunks
  -> evidence expansion always returns to raw
```

The important correction is that a leaf summary is **not** one turn. A leaf summary is a compacted chunk of older raw messages. Recent raw messages stay raw as a fresh tail.

## Defaults

```text
summaryFreshRawMessages      = 64
summaryLeafChunkTokens       = 20000
summaryLeafRollupMinFanout   = 8
summaryRollupMinFanout       = 4
summaryIncrementalMaxDepth   = 1
```

These mirror lossless-claw's practical defaults:

- keep the newest raw messages untouched;
- compact only older raw material;
- cap leaf input by token budget instead of turn count;
- merge multiple leaf summaries into higher-level rollups.

## Runtime Flow

After each turn, OMS now runs session-level compaction:

```text
afterTurn(session)
  -> count unsummarized raw outside fresh tail
  -> if below summaryLeafChunkTokens: skip summary
  -> select oldest contiguous unsummarized raw chunk
  -> create one active leaf summary
  -> if enough active leaf summaries exist, create rollup
  -> mark rolled-up child summaries inactive
```

Raw messages remain the durable source of truth. Summaries are navigation artifacts only.

## Evidence Rule

Summary text is never final evidence. Retrieval may use summary hits to navigate, but `oms_expand_evidence` must follow source edges back to `raw_messages`.

```text
summary -> source_edges -> raw_messages -> evidence packet
```

Rollups preserve this chain:

```text
rollup summary -> leaf summaries -> raw messages
```

## Why Not One Turn Per Leaf

One-turn leaves caused three problems:

1. `summaries` grew at the same rate as `raw_messages`.
2. A turn could be summarized multiple times as user/assistant messages arrived.
3. Rollups never became useful because the table filled with tiny derived artifacts.

Chunk leaves fix this by summarizing older material only when it has enough size to justify compaction.

## Operational Expectations

For small or fresh conversations it is normal to see:

```text
raw_messages > summaries
rollups = 0
```

For longer conversations:

```text
leaf summaries ~= old_raw_tokens / summaryLeafChunkTokens
rollups appear after enough leaf summaries accumulate
```

The exact count depends on message length, not turn count.
