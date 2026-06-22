# S3 Retrieval Scale + Latency Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make vector retrieval scale-ready (add the pgvector HNSW index and fix the operator/opclass mismatch that prevents the index from being used), and add per-stage latency observability (structured logs) so future perf work is data-driven.

**Architecture:** Two coupled DB-layer/query changes (a new raw-SQL Prisma migration creating an HNSW index with `vector_cosine_ops`, plus switching the query operator in `apps/api/src/vector-search.ts` from `<->` (L2) to `<=>` (cosine) so the index is actually used), then per-stage timing instrumentation emitted via the existing `logger` (NOT added to the `/v1` response — keeping the soon-frozen contract clean and snapshots byte-identical).

**Tech Stack:** PostgreSQL + pgvector (HNSW), Prisma (raw-SQL migration), TypeScript, `@statecore/core` logger, vitest.

## Global Constraints

- Tests: `pnpm --filter @statecore/core test`, `pnpm --filter @statecore/api test`. Migrations live in `packages/db/prisma/migrations/`.
- NO breaking `/v1`: do NOT add fields to the retrieve API response / `MemoryRetrieveOutput` contract. Per-stage timings go to LOGS only. The OpenAPI snapshot tests (`apps/api/src/__snapshots__/*.snap`) MUST stay byte-identical (green, no `-u`).
- Index opclass = `vector_cosine_ops`; query operator MUST be `<=>` (cosine) to match (the index is ignored otherwise). OpenAI embeddings are unit-normalized, so cosine and the old L2 (`<->`) rank identically — retrieval results do not change.
- Do NOT edit already-applied migrations; add a NEW migration.
- Lowering the current p95 is OUT of scope (it is LLM/network-bound, not pgvector); this task only makes retrieval scale-ready and adds the breakdown for a future, data-driven perf effort.
- No new telemetry/metrics framework — reuse the existing `logger` and the digest-control stage metrics that already exist.

---

### Task 1: Add HNSW index + align query operator to cosine

**Files:**
- Create: `packages/db/prisma/migrations/20260622000000_hnsw_embedding_index/migration.sql`
- Modify: `apps/api/src/vector-search.ts:18` (`<->` → `<=>`)
- Modify: `docs/benchmarking.md` (add a manual EXPLAIN-verification note)

**Interfaces:**
- Produces: the HNSW index `MemoryEventEmbedding_embedding_hnsw_idx`; the cosine-operator query in `createVectorSearchFn`.

- [ ] **Step 1: Confirm there is no other `<->` (L2) embedding query to update**

Run: `grep -rn "<->" apps packages`
Expected: the ONLY match is `apps/api/src/vector-search.ts:18`. If others exist (another raw embedding query), update them too in Step 3 and note them.

- [ ] **Step 2: Create the HNSW index migration**

Create `packages/db/prisma/migrations/20260622000000_hnsw_embedding_index/migration.sql`:

```sql
-- HNSW index on the embedding vector for scalable approximate-nearest-neighbour
-- search. Uses vector_cosine_ops to match the `<=>` (cosine) query operator in
-- apps/api/src/vector-search.ts. Postgres only uses an HNSW index when the query
-- operator matches the index opclass.
CREATE INDEX IF NOT EXISTS "MemoryEventEmbedding_embedding_hnsw_idx"
  ON "MemoryEventEmbedding" USING hnsw (embedding vector_cosine_ops);
```

(Default HNSW build params `m=16, ef_construction=64` are fine; do not over-tune. `IF NOT EXISTS` keeps the migration idempotent.)

- [ ] **Step 3: Switch the query operator to cosine in `vector-search.ts`**

In `apps/api/src/vector-search.ts`, change line 18 from:
```typescript
      ORDER BY mee.embedding <-> ${vectorString}::vector
```
to:
```typescript
      ORDER BY mee.embedding <=> ${vectorString}::vector
```
(`<=>` is pgvector's cosine-distance operator, matching `vector_cosine_ops`.)

- [ ] **Step 4: Run the core + api suites (operator change is rank-equivalent)**

Run: `pnpm --filter @statecore/core test`
Expected: PASS — `retrieve-vector.test.ts` / `retrieve-embedding*.test.ts` use an injected fake `vectorSearchFn`, so the SQL operator change does not affect them; they confirm retrieve logic is unchanged.
Run: `pnpm --filter @statecore/api test`
Expected: PASS, OpenAPI snapshots byte-identical (the raw SQL string is internal; not in the contract).

- [ ] **Step 5: Document the manual index-usage verification**

In `docs/benchmarking.md`, add a short subsection (near the retrieve/latency section):

```markdown
### Verifying the HNSW index is used

The HNSW index (`MemoryEventEmbedding_embedding_hnsw_idx`, `vector_cosine_ops`)
is used only when the query uses the matching cosine operator `<=>`. To confirm
on a populated database:

    EXPLAIN ANALYZE
    SELECT mee."eventId" FROM "MemoryEventEmbedding" mee
    JOIN "MemoryEvent" me ON me.id = mee."eventId"
    WHERE me."scopeId" = '<scope>'
    ORDER BY mee.embedding <=> '<query-vector>'::vector LIMIT 20;

Look for an `Index Scan using MemoryEventEmbedding_embedding_hnsw_idx`. On small
tables the planner may still choose a sequential scan — that is expected and
correct; the index matters at scale. Set `SET hnsw.ef_search = <n>;` to trade
recall vs latency.
```

- [ ] **Step 6: Commit**

```bash
git add packages/db/prisma/migrations/20260622000000_hnsw_embedding_index/migration.sql apps/api/src/vector-search.ts docs/benchmarking.md
git commit -m "feat(db): add HNSW embedding index + align vector query to cosine operator"
```

---

### Task 2: Per-stage retrieve latency logs + surface digest stage metrics

**Files:**
- Modify: `packages/core/src/index.ts` (`RetrieveService.retrieve` + `rerankWithEmbeddings` — add stage timings + one structured log)
- Test: `packages/core/src/retrieve-timing.test.ts` (new)
- Modify: `docs/benchmarking.md` (note how to read the per-stage timings)

**Interfaces:**
- Consumes: the existing `logger` from `@statecore/core`.
- Produces: a structured log line `logger.info({ retrieveTimings: { embedMs, vectorSearchMs, rerankMs, totalMs } }, "retrieve stage timings")` emitted once per `retrieve()` call. No change to `RetrieveResult` / `RetrieveMetadata` / the `/v1` contract.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/retrieve-timing.test.ts`. It drives `RetrieveService.retrieve` with a stubbed embedding model + fake vector search and asserts a `retrieveTimings` log is emitted with numeric stage fields:

```typescript
import { describe, it, expect, vi, afterEach } from "vitest";
import { RetrieveService, logger } from "./index";
import type { MemoryEvent } from "./index";

function ev(id: string, content: string): MemoryEvent {
  return { id, scopeId: "sc", userId: "u", type: "stream", source: "api", content, createdAt: new Date("2026-01-01T00:00:00Z") };
}

describe("retrieve stage timings", () => {
  afterEach(() => vi.restoreAllMocks());

  it("emits a structured retrieveTimings log with numeric stages", async () => {
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => {});
    const events = [ev("e1", "we decide to use postgres"), ev("e2", "ship the beta")];
    const svc = new RetrieveService({
      listRecent: async () => ({ items: events, nextCursor: null }),
      getLatestDigest: async () => null,
      embeddingModel: { embed: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]) },
      vectorSearchFn: async () => ["e1"],
      useEmbeddingRerank: true,
      embeddingCandidateLimit: 24
    } as any);

    await svc.retrieve("sc", 10, "postgres");

    const timingCall = infoSpy.mock.calls.find((c) => (c[0] as any)?.retrieveTimings);
    expect(timingCall, "a retrieveTimings log should be emitted").toBeTruthy();
    const t = (timingCall![0] as any).retrieveTimings;
    expect(typeof t.totalMs).toBe("number");
    expect(typeof t.embedMs).toBe("number");
    expect(typeof t.vectorSearchMs).toBe("number");
    expect(typeof t.rerankMs).toBe("number");
  });
});
```

(Read `RetrieveService`'s constructor options shape in `packages/core/src/index.ts:273-300` and adapt the stub keys to the real option names — the names above are the expected ones (`listRecent`/`getLatestDigest`/`embeddingModel`/`vectorSearchFn`/`useEmbeddingRerank`/`embeddingCandidateLimit`); fix any mismatch you find while keeping the assertions.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @statecore/core test retrieve-timing`
Expected: FAIL — no `retrieveTimings` log is emitted yet.

- [ ] **Step 3: Instrument `retrieve()` + `rerankWithEmbeddings()`**

In `packages/core/src/index.ts`:
- In `retrieve()` (starts line 421): capture `const tStart = Date.now();`. Around the vector-search block (the `embeddingModel.embed([query])` at ~437 and `vectorSearchFn(...)` at ~440) capture `embedMs` (time for the query embedding) and `vectorSearchMs` (time for `vectorSearchFn`). Have `rerankWithEmbeddings` return or set a `rerankMs` (time spent in its `embed([query, ...candidates])` call) — the simplest is to measure the whole `rerankWithEmbeddings` call from `retrieve()`: `const tRerank = Date.now(); const reranked = await this.rerankWithEmbeddings(...); const rerankMs = Date.now() - tRerank;`.
- For stages that don't run (no query / no embedding configured / vector search skipped), record `0`.
- After building the result, before returning, emit:
```typescript
    logger.info(
      { retrieveTimings: { embedMs, vectorSearchMs, rerankMs, totalMs: Date.now() - tStart } },
      "retrieve stage timings"
    );
```
- Do NOT add these timings to `RetrieveMetadata` or `RetrieveResult` (keep them out of the contract).

- [ ] **Step 4: Run to verify it passes + full core suite**

Run: `pnpm --filter @statecore/core test retrieve-timing`
Expected: PASS.
Run: `pnpm --filter @statecore/core test`
Expected: full core suite PASS (existing retrieve tests unaffected — they don't assert logs).

- [ ] **Step 5: Ensure digest stage metrics are observable + document both**

Digest already computes stage metrics (`selectionMs`, `classificationMs`, `deltaMs`, `mergeMs`, `generationMs`) in `runDigestControlPipeline` (`packages/core/src/digest-control.ts`). Confirm they are logged where the pipeline runs: `grep -rn "selectionMs\|generationMs\|digestTimings\|metrics" packages/core/src/digest-control.ts apps/worker/src/main.ts`. If the pipeline's `metrics` object is NOT already logged at its call site, add one structured log at the digest call site in `apps/worker/src/main.ts` (inside the `digest_scope` handler, after the pipeline returns): `logger.info({ digestTimings: metrics }, "digest stage timings")`. If it is already logged, leave it and note that in the report.

Then in `docs/benchmarking.md`, add:
```markdown
### Per-stage latency breakdown

Retrieve and digest emit structured stage timings to the logs (the benchmark
reports end-to-end p95; the breakdown lives in logs to keep it out of the /v1
response):

- Retrieve: log `"retrieve stage timings"` → `retrieveTimings: { embedMs, vectorSearchMs, rerankMs, totalMs }`
- Digest: log `"digest stage timings"` → `digestTimings: { selectionMs, classificationMs, deltaMs, mergeMs, generationMs }`

Filter the API/worker logs by these messages to see where retrieve/digest time
goes (the current p95 is dominated by the embedding/LLM calls, not the DB query).
```

- [ ] **Step 6: Run the full core + worker suites**

Run: `pnpm --filter @statecore/core test` and `pnpm --filter @statecore/worker test`
Expected: both PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/index.ts packages/core/src/retrieve-timing.test.ts docs/benchmarking.md apps/worker/src/main.ts
git commit -m "feat(core): structured per-stage latency logs for retrieve and digest"
```

---

## Self-Review

**Spec coverage:**
- Spec §1 (HNSW index, new raw-SQL migration, cosine opclass, add now) → Task 1 Step 2. ✓
- Spec §2 (operator/opclass bug fix `<->`→`<=>`, grep for stray uses, rank-equivalent) → Task 1 Steps 1, 3, 4. ✓
- Spec §3 (per-stage latency breakdown: retrieve embed/vectorSearch/rerank; surface digest's existing stage metrics) → Task 2. ✓
- Spec "index-usage verification is best-effort/manual, not a CI gate" → Task 1 Step 5 (documented EXPLAIN, no CI assertion). ✓
- Spec "snapshot unchanged / no contract change" → timings to logs only (Task 2 Step 3 explicitly keeps them out of RetrieveMetadata/contract); Task 1 Step 4 confirms snapshots. ✓
- Spec "lowering current p95 OUT of scope" → no perf-optimization task; instrumentation is measurement only. ✓
- Spec YAGNI (no new telemetry framework) → reuses `logger` + existing digest metrics. ✓

**Placeholder scan:** No TBD/vague steps. Task 2 Step 1 notes the implementer must reconcile the stub option keys against the real `RetrieveService` constructor (lines cited) — this is a read-and-adapt instruction with the exact expected key names given, not a placeholder. Task 2 Step 5 is conditional (log only if not already logged) with the exact grep + exact log line.

**Type consistency:** `retrieveTimings: { embedMs, vectorSearchMs, rerankMs, totalMs }` and `digestTimings: { selectionMs, classificationMs, deltaMs, mergeMs, generationMs }` are used consistently between the instrumentation (Task 2 Step 3/5), the test (Step 1), and the docs (Step 5). The migration index name `MemoryEventEmbedding_embedding_hnsw_idx` matches between the migration SQL and the EXPLAIN doc note.
