---
"statecore-mcp": minor
---

Retrieval now reports its own degradation, and protection reaches the read path.

- `retrieval.mode` is derived from what actually ran, not from configuration: a
  run whose embedding calls all failed reports `heuristic`, and each failed
  stage is itemised in the new optional `retrieval.degraded` array
  (`{ stage: "vector_search" | "rerank", error }`). Previously a total
  embedding outage still reported `mode: "hybrid"` and the vector-search
  failure was swallowed by a bare catch.
- Pinned events get a bounded additive ranking boost in retrieval (beats the
  recency edge at equal relevance; loses to any real relevance gap — a boost,
  never a filter). `rankingReason` gains a `pinned` marker.
- Write-protected and document-authority facets now carry a bounded ranking
  multiplier (clamped to at most 1.5×) into the `maxChars` budget competition,
  via the new `facetAuthority()` helper and `packWithinBudget`'s optional
  `factAuthority` input.
- Every system prompt that sees ingested or retrieved content now carries an
  explicit security boundary (content is data, never instructions) and
  concrete faithfulness rules (never invent dates, paths, versions, or
  identifiers; no generic-knowledge filler).
