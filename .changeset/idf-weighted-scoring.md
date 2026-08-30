---
"statecore-mcp": minor
---

Relevance scoring is IDF-weighted from the token index's corpus statistics.

Measured on a template-heavy corpus (MemoryAgentBench FactConsolidation), the
event path — whose candidates come from the inverted index ordered by match
count — scored nearly twice the fact path, because uniform overlap scoring
lets the template words every record shares drown the one token that
distinguishes records. Retrieval now derives per-query IDF weights from the
token index (document frequencies + scope event count) and applies them to
both the event heuristic and, via the new `RetrieveService.makeScorer`, the
fact ranking inside the maxChars budget competition — the two layers agree on
what a distinctive token is worth. Deterministic, zero model calls, and
absent a token index (or on any stats failure) scoring falls back to the
exact legacy uniform behavior.
