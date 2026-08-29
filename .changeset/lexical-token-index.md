---
"statecore-mcp": minor
---

Lexical inverted token index: recall now reaches old events.

The retrieval candidate pool used to be the newest ~200 events plus optional
vector hits — anything older was unreachable however relevant, which hit the
keyless embedded store hardest (no embeddings, so recency was everything).
Ingest now writes an inverted token index (`MemoryEventToken`) using the same
tokenizer the relevance scorer uses (ASCII words + CJK bigrams — a term
matches in the index iff it matches in the score; this is also why no FTS
engine is involved), and retrieval unions a lexical candidate stream into the
pool. Final ranking is unchanged. Index-query failures are reported as
`retrieval.degraded` stage `lexical_search`, never swallowed.

English stopwords are excluded from the index (the relevance scorer is
unchanged), long bilingual queries interleave ASCII and CJK tokens instead of
truncating CJK away, and `forget` removes the suppressed event's index rows.

The embedded store backfills existing events automatically at open. Server
deployments run the `20260829120000_memory_event_tokens` and
`20260829200000_session_handoff` migrations and then `pnpm backfill:tokens`
once.
