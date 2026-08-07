---
"@statecore/core": patch
---

Extract from the whole corpus, not the first prompt-full of it.

Stage 2 clipped its `deltaCandidates` section at 60k characters and dropped the
remainder, so on any corpus larger than one prompt the extractor only ever saw
the beginning. On LongMemEval that was ~490k characters of sessions against a
60k window — about 12% reaching extraction. Bulk import (`ingest:docs`) hits the
same wall, and the shortfall was invisible because the verbatim promotion paths
were separately copying every event into the fact registry.

Stage 2 now runs one pass per prompt-sized chunk, threading each pass's output
forward as the next pass's `lastDigest` so the summary accumulates the way
consecutive incremental digests do, and unioning the extracted facts.
`STAGE2_MAX_CHUNKS` bounds the work per run; events beyond it stay in the store
for the next one.
