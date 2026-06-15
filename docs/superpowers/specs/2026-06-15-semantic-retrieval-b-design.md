# Semantic Retrieval — Option B: pgvector Stored Embeddings

**Date:** 2026-06-15
**Scope:** Add pgvector to PostgreSQL, store embedding vectors in a separate `MemoryEventEmbedding` table, generate embeddings asynchronously via worker, and add a vector ANN search path to `RetrieveService` that finds semantically relevant events even with zero keyword overlap.

---

## Problem Statement

Option A (embedding reranking) only rerankss the top-24 keyword candidates. If a relevant event has zero keyword overlap with the query — e.g., query "what persistence layer?" vs event "We decided to use Postgres" — keyword search never surfaces it, and embeddings never get a chance to save it.

Option B stores embedding vectors at ingest time and queries them directly at retrieval time, bypassing the keyword filter entirely.

---

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| When to embed | Async via worker | Zero ingest latency; embedding failure doesn't block event storage |
| Vector storage | Separate `MemoryEventEmbedding` table | MemoryEvent table unchanged; clean separation; easier model migration |
| Index | None initially (exact KNN) | At personal-tool scale (<50k events/scope) exact `<->` is <5ms |
| Coexistence with Option A | Both paths available, separate env vars | New events get vectors; existing events fall back to keyword+rerank |

---

## Architecture

```
INGEST PATH:
POST /memory/events
  → DB: INSERT MemoryEvent
  → Queue: embed_event { eventId, content, model }
  → Return 201 immediately

Worker embed_event job:
  → embedding API: embed([content]) → vector[1536]
  → DB: INSERT MemoryEventEmbedding (eventId, embedding, model)

RETRIEVAL PATH (with RETRIEVE_USE_VECTOR_SEARCH=true):
retrieve(scopeId, limit, query)
  → embed(query) → query_vector
  → SELECT eventId FROM MemoryEventEmbedding
      ORDER BY embedding <-> query_vector
      LIMIT candidateSize
  → Fetch those MemoryEvent rows
  → Keyword search → fetch MemoryEvent rows
  → Union + dedup by id
  → Hybrid rerank (embedding*0.55 + text*0.25 + recency*0.20)
  → Return top-N

FALLBACK (no RETRIEVE_USE_VECTOR_SEARCH or embedding not configured):
  → Option A behavior (keyword → optional embedding rerank on top-24)
```

---

## Part 1: Infrastructure

### Docker images

Change in both `docker-compose.local.yml` and `docker-compose.prod.yml`:

```yaml
# Before:
image: postgres:16

# After:
image: pgvector/pgvector:pg16
```

`pgvector/pgvector:pg16` is the official pgvector image, fully compatible with postgres:16 — same wire protocol, same data format.

### Migration

New file: `packages/db/prisma/migrations/20260615020000_pgvector_embeddings/migration.sql`

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE "MemoryEventEmbedding" (
    "eventId"   TEXT        NOT NULL,
    "embedding" vector(1536) NOT NULL,
    "model"     TEXT        NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MemoryEventEmbedding_pkey" PRIMARY KEY ("eventId"),
    CONSTRAINT "MemoryEventEmbedding_eventId_fkey"
        FOREIGN KEY ("eventId")
        REFERENCES "MemoryEvent"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "MemoryEventEmbedding_eventId_idx" ON "MemoryEventEmbedding"("eventId");

-- Uncomment when MemoryEventEmbedding exceeds ~50k rows for ANN acceleration:
-- CREATE INDEX ON "MemoryEventEmbedding" USING hnsw (embedding vector_cosine_ops);
```

### Prisma schema

Add to `packages/db/prisma/schema.prisma` after `MemoryEvent` model. The `vector(1536)` column is managed via raw SQL — Prisma only tracks the non-vector fields:

```prisma
model MemoryEventEmbedding {
  eventId   String      @id
  model     String
  createdAt DateTime    @default(now())
  event     MemoryEvent @relation(fields: [eventId], references: [id], onDelete: Cascade)
}
```

Add the relation field to `MemoryEvent`:
```prisma
  embedding MemoryEventEmbedding?
```

---

## Part 2: Worker Embedding Generation

### New env var

In `apps/worker/src/env.ts`, add:
```typescript
embedEventModel: clean(env.MODEL_EMBEDDING_NAME) || "",
```

This reuses the existing `MODEL_EMBEDDING_NAME` env var already defined for Option A.

### New worker job: `embed_event`

In `apps/worker/src/main.ts`, add a new BullMQ Worker for the `"embed"` queue:

```typescript
async function runEmbedEventJob(data: { eventId: string; scopeId: string }) {
  if (!embeddingModel) return; // embedding not configured — skip silently

  // Fetch event content
  const event = await prisma.memoryEvent.findUnique({ where: { id: data.eventId } });
  if (!event) return;

  // Generate embedding
  const vectors = await embeddingModel.embed([event.content]);
  const vector = vectors[0];
  if (!vector?.length) throw new Error("Embedding returned empty vector");

  const modelName = workerEnv.embedEventModel;

  // Upsert into MemoryEventEmbedding (raw SQL for vector type)
  await prisma.$executeRaw`
    INSERT INTO "MemoryEventEmbedding" ("eventId", "embedding", "model")
    VALUES (
      ${data.eventId},
      ${`[${vector.join(",")}]`}::vector,
      ${modelName}
    )
    ON CONFLICT ("eventId") DO UPDATE
      SET "embedding" = EXCLUDED."embedding",
          "model"     = EXCLUDED."model"
  `;
}
```

The `embeddingModel` variable is the existing `provider?.embedding` already constructed in main.ts.

### Trigger from API

In `apps/api/src/domain.service.ts` (or wherever ingest is handled), after a MemoryEvent is created, add to the BullMQ `embed` queue:

```typescript
await embedQueue.add("embed_event", { eventId: createdEvent.id, scopeId });
```

The `embedQueue` is a `new Queue("embed", { connection })`.

### Backfill endpoint

New endpoint: `POST /memory/embed/backfill`

```typescript
@Post("memory/embed/backfill")
async backfillEmbeddings(
  @Body() body: { scopeId: string },
  @Headers("x-user-id") userId: string
) {
  // Verify scope belongs to user
  const scope = await this.domain.scopes.findById(body.scopeId, userId);
  if (!scope) throw new NotFoundException("Scope not found");

  // Find events in scope without embeddings
  const eventsWithoutEmbedding = await prisma.$queryRaw<{ id: string }[]>`
    SELECT me.id
    FROM "MemoryEvent" me
    LEFT JOIN "MemoryEventEmbedding" mee ON me.id = mee."eventId"
    WHERE me."scopeId" = ${body.scopeId}
      AND mee."eventId" IS NULL
  `;

  // Queue embed job for each
  for (const event of eventsWithoutEmbedding) {
    await embedQueue.add("embed_event", { eventId: event.id, scopeId: body.scopeId });
  }

  return { queued: eventsWithoutEmbedding.length };
}
```

---

## Part 3: RetrieveService Vector Search

### New env var

`RETRIEVE_USE_VECTOR_SEARCH=true` (separate from `RETRIEVE_USE_EMBEDDINGS`). Both can be true simultaneously.

In `apps/api/src/env.ts`:
```typescript
retrieveUseVectorSearch: toBool(env.RETRIEVE_USE_VECTOR_SEARCH),
```

### New MemoryRepo method

Add to the `MemoryRepo` interface in `packages/core/src/index.ts`:

```typescript
findByIds: (ids: string[]) => Promise<MemoryEvent[]>;
```

And to the repo in `apps/api/src/domain.service.ts`:
```typescript
findByIds: (ids: string[]) => prisma.memoryEvent.findMany({ where: { id: { in: ids } } })
```

### New RetrieveService option + method

Add to `RetrieveService` constructor options:
```typescript
useVectorSearch?: boolean;
vectorSearchFn?: (queryVector: number[], limit: number) => Promise<string[]>; // returns eventIds
```

The `vectorSearchFn` is injected from `DomainService` and executes:
```typescript
async (queryVector, limit) => {
  const rows = await prisma.$queryRaw<{ eventId: string }[]>`
    SELECT "eventId"
    FROM "MemoryEventEmbedding"
    ORDER BY embedding <-> ${`[${queryVector.join(",")}]`}::vector
    LIMIT ${limit}
  `;
  return rows.map(r => r.eventId);
}
```

### Retrieval flow change

In `RetrieveService.retrieve()`, before keyword ranking:

```typescript
if (this.options?.useVectorSearch && this.options?.embeddingModel && this.options?.vectorSearchFn && query) {
  const queryVectors = await this.options.embeddingModel.embed([query]);
  const queryVector = queryVectors[0];
  if (queryVector) {
    const vectorEventIds = await this.options.vectorSearchFn(queryVector, candidateSize);
    const vectorEvents = await this.memories.findByIds(vectorEventIds);
    // Merge with keyword candidates, dedup by id
    const keywordIds = new Set(events.items.map(e => e.id));
    const merged = [...events.items, ...vectorEvents.filter(e => !keywordIds.has(e.id))];
    // Use merged as the ranking pool
    events = { items: merged, nextCursor: null };
  }
}
```

After merge, the existing hybrid ranking (keyword score + recency + embedding rerank from Option A) runs on the full merged pool.

### Health endpoint update

`GET /health` already returns `retrieve.useEmbeddings`. Add `retrieve.useVectorSearch`:
```json
{ "retrieve": { "useEmbeddings": true, "useVectorSearch": true } }
```

---

## File Map

| File | Action |
|------|--------|
| `docker-compose.local.yml` | Modify — postgres image → pgvector/pgvector:pg16 |
| `docker-compose.prod.yml` | Modify — same |
| `packages/db/prisma/migrations/20260615020000_pgvector_embeddings/migration.sql` | Create |
| `packages/db/prisma/schema.prisma` | Modify — add MemoryEventEmbedding model + relation |
| `apps/worker/src/main.ts` | Modify — add embed Worker + runEmbedEventJob |
| `apps/worker/src/env.ts` | Modify — add embedEventModel |
| `apps/api/src/domain.service.ts` | Modify — add embedQueue, trigger after ingest, inject vectorSearchFn |
| `apps/api/src/memory.controller.ts` | Modify — add POST /memory/embed/backfill |
| `packages/core/src/index.ts` | Modify — add useVectorSearch + vectorSearchFn options, findByIds to MemoryRepo, merge logic in retrieve() |
| `apps/api/src/env.ts` | Modify — add retrieveUseVectorSearch |

---

## Success Criteria

1. `docker compose -f docker-compose.local.yml up` starts successfully with pgvector image
2. `CREATE EXTENSION vector` succeeds during migration
3. New events get embedding jobs queued after ingest
4. `MemoryEventEmbedding` rows appear in DB after worker processes embed_event jobs
5. `POST /memory/embed/backfill { scopeId }` queues embed jobs for events without vectors
6. `GET /health` shows `"retrieve":{"useVectorSearch":true}` when configured
7. With `RETRIEVE_USE_VECTOR_SEARCH=true`, query "what persistence layer?" returns event "We decided to use Postgres" even if no keyword overlap
8. With no `RETRIEVE_USE_VECTOR_SEARCH`, behavior is identical to before (Option A or heuristic)
9. All existing 153 unit tests still pass

---

## Out of Scope

- HNSW index (add when >50k events — see migration comment)
- Multi-model support (vector dimension changes require new migration)
- Streaming embedding generation
- Embedding version tracking beyond `model` column
