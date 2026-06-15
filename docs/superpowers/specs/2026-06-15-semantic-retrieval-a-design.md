# Semantic Retrieval — Option A: Enable Embedding Reranking

**Date:** 2026-06-15
**Scope:** Activate and validate the existing embedding reranking path in `RetrieveService`. Infrastructure already exists but is untested, unconfigured, and silently fails.

---

## Problem Statement

`RetrieveService.rerankWithEmbeddings()` is fully implemented (hybrid score: `embeddingScore * 0.55 + textScore * 0.25 + recency * 0.2`) but:

1. `catch {}` block silently swallows embedding API failures — no log, no warning
2. No unit tests for the embedding reranking path
3. No documentation on how to configure `MODEL_EMBEDDING_NAME` + `RETRIEVE_USE_EMBEDDINGS`
4. Never validated end-to-end

Consequence: `useEmbeddings` is `false` in production. Queries with zero keyword overlap ("what persistence layer?" vs "We decided to use Postgres") silently return wrong results.

---

## What This Is NOT

This spec does not add pgvector, store embedding vectors in the database, or change the retrieval architecture. Option A only activates the existing at-query-time reranking path. Stored vector search is Option B, a future spec.

---

## Architecture (existing, unchanged)

```
query
  │
  ▼
keyword search → top-200 events from DB
  │
  ▼
heuristic rank (text match 0.8 + recency 0.2)
  │
  ▼
rerankWithEmbeddings (top-24 candidates)
  │  embed([query, c1, c2, ...c24]) → vectors
  │  finalScore = embedding*0.55 + text*0.25 + recency*0.20
  ▼
return top-N reranked results
```

Embedding is computed at query time on the top `embeddingCandidateLimit` (default: 24) keyword candidates. Events beyond rank 24 are not reranked — they remain keyword-sorted at the tail.

---

## Changes

### 1. Fix silent error logging

**File:** `packages/core/src/index.ts` — `rerankWithEmbeddings` catch block

**Before:**
```typescript
} catch {
  return ranked;
}
```

**After:**
```typescript
} catch (err) {
  logger.warn({ err }, "Embedding rerank failed, falling back to heuristic ranking");
  return ranked;
}
```

`logger` is already imported in the file. No other changes to the function.

---

### 2. Unit tests — embedding reranking path

**New file:** `packages/core/src/retrieve-embedding.test.ts`

Three tests using a mock `EmbeddingModel` (no real API calls):

**Test 1 — Embedding rerank changes ranking:**
- 3 events: keyword scores are A=0.9, B=0.1, C=0.1
- Embedding similarity: A=0.2, B=0.9, C=0.1 (B is semantically closer despite low keyword score)
- After reranking: B should rank above A
- Result items have `embeddingScore` field

**Test 2 — Embedding failure falls back gracefully:**
- `embed()` throws an error
- Results return in original keyword order (no crash)
- No `embeddingScore` field on results

**Test 3 — Hybrid score formula correctness:**
- Fixed: embeddingScore=0.8, textScore=0.5, recency=0.3
- Expected finalScore = 0.8×0.55 + 0.5×0.25 + 0.3×0.20 = 0.44 + 0.125 + 0.06 = 0.625
- Verified to 3 decimal places

---

### 3. Skipped integration test

**New file:** `packages/core/src/retrieve-embedding.integration.test.ts`

All tests wrapped in `it.skip` — run locally with real API key, skipped in CI.

```typescript
it.skip("requires OPENAI_API_KEY: semantic query finds relevant event with no keyword overlap", async () => {
  // Uses real text-embedding-3-small via OPENAI_API_KEY env var
  // events: ["We decide to use Postgres for storage", "The weather is nice today"]
  // query: "what persistence layer did we choose?"
  // Assert: Postgres event finalScore > weather event finalScore
});
```

Comment explains how to run: `OPENAI_API_KEY=sk-... pnpm --filter @statecore/core test -- retrieve-embedding.integration`

---

### 4. Configuration documentation

**File:** `docker-compose.local.yml` — add commented env vars to the `api` service environment block:

```yaml
# Semantic retrieval — set both to enable embedding reranking:
# - MODEL_EMBEDDING_NAME: text-embedding-3-small
# - RETRIEVE_USE_EMBEDDINGS: "true"
```

**File:** `CLAUDE.md` — add to "Running locally" section:

```markdown
### Semantic retrieval (optional)
Set in `.env`:
- `MODEL_EMBEDDING_NAME=text-embedding-3-small`
- `RETRIEVE_USE_EMBEDDINGS=true`
Uses the same API key as the LLM model.
```

---

## File Map

| File | Action |
|------|--------|
| `packages/core/src/index.ts` | Modify — add `logger.warn` to catch block in `rerankWithEmbeddings` |
| `packages/core/src/retrieve-embedding.test.ts` | Create — 3 unit tests with mock embedding model |
| `packages/core/src/retrieve-embedding.integration.test.ts` | Create — 1 `it.skip` integration test |
| `docker-compose.local.yml` | Modify — add commented embedding env var documentation |
| `CLAUDE.md` | Modify — document optional semantic retrieval config |

---

## Success Criteria

1. `pnpm --filter @statecore/core test` — all pass including 3 new unit tests (no real API calls)
2. `rerankWithEmbeddings` catch block emits `logger.warn` on error (verified in test)
3. `docker-compose.local.yml` has commented config block for embedding
4. `CLAUDE.md` explains how to enable semantic retrieval
5. Integration test file exists with `it.skip` and clear run instructions

## Out of Scope

- Storing embedding vectors in the database (Option B)
- Changing the hybrid score weights
- Adding new embedding model providers beyond the existing OpenAI-compatible client
- Backfilling existing events with stored embeddings
