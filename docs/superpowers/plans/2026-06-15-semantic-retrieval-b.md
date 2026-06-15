# Semantic Retrieval Option B — pgvector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add pgvector to PostgreSQL, store embedding vectors in `MemoryEventEmbedding`, generate them asynchronously via a BullMQ worker job, and add a vector ANN search path to `RetrieveService` that finds semantically relevant events even with zero keyword overlap.

**Architecture:** Four tasks in dependency order. Task 1 sets up the database infrastructure (Docker image + migration + Prisma schema). Task 2 extends `RetrieveService` with an injectable `vectorSearchFn` option and merge logic — fully tested with mocks. Task 3 adds the `embed_event` BullMQ worker job that calls the embedding API and upserts vectors via raw SQL. Task 4 wires everything together: adds `embedQueue` to the API, triggers embed jobs after ingest, adds the backfill endpoint, and connects `vectorSearchFn` in `DomainService`.

**Tech Stack:** TypeScript, pgvector (PostgreSQL extension), Prisma (with raw SQL for vector column), BullMQ, Vitest, pnpm workspaces.

---

## File Map

| File | Action |
|------|--------|
| `docker-compose.local.yml` | Modify — postgres image → `pgvector/pgvector:pg16` |
| `docker-compose.prod.yml` | Modify — same |
| `packages/db/prisma/migrations/20260615020000_pgvector_embeddings/migration.sql` | Create |
| `packages/db/prisma/schema.prisma` | Modify — add `MemoryEventEmbedding` model + relation on `MemoryEvent` |
| `packages/core/src/index.ts` | Modify — add `findByIds` to `MemoryRepo`; add `useVectorSearch`/`vectorSearchFn` to `RetrieveService`; merge logic in `retrieve()` |
| `packages/core/src/retrieve-vector.test.ts` | Create — unit tests for vector search merge path |
| `apps/worker/src/main.ts` | Modify — add `embed` BullMQ Worker + `runEmbedEventJob` function |
| `apps/worker/src/embed-job.test.ts` | Create — unit tests for embed job |
| `apps/api/src/queue.ts` | Modify — add `embedQueue` export |
| `apps/api/src/env.ts` | Modify — add `retrieveUseVectorSearch` |
| `apps/api/src/memory.controller.ts` | Modify — trigger `embed_event` after ingest; add `POST /memory/embed/backfill` |
| `apps/api/src/domain.service.ts` | Modify — inject `vectorSearchFn` into `RetrieveService`; add `findByIds` to memoryRepo |
| `apps/api/src/health.controller.ts` | Modify — add `useVectorSearch` to health response |

---

## Task 1: Database Infrastructure

**Files:**
- Modify: `docker-compose.local.yml`
- Modify: `docker-compose.prod.yml`
- Create: `packages/db/prisma/migrations/20260615020000_pgvector_embeddings/migration.sql`
- Modify: `packages/db/prisma/schema.prisma`

- [ ] **Step 1: Update Docker images**

In `docker-compose.local.yml`, find `image: postgres:16` (under the `postgres:` service) and change to:
```yaml
image: pgvector/pgvector:pg16
```

Do the same in `docker-compose.prod.yml`.

- [ ] **Step 2: Create migration SQL**

Create directory `packages/db/prisma/migrations/20260615020000_pgvector_embeddings/` and file `migration.sql`:

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE "MemoryEventEmbedding" (
    "eventId"   TEXT         NOT NULL,
    "embedding" vector(1536) NOT NULL,
    "model"     TEXT         NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MemoryEventEmbedding_pkey" PRIMARY KEY ("eventId"),
    CONSTRAINT "MemoryEventEmbedding_eventId_fkey"
        FOREIGN KEY ("eventId")
        REFERENCES "MemoryEvent"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "MemoryEventEmbedding_eventId_idx" ON "MemoryEventEmbedding"("eventId");

-- Uncomment when MemoryEventEmbedding exceeds ~50k rows:
-- CREATE INDEX ON "MemoryEventEmbedding" USING hnsw (embedding vector_cosine_ops);
```

- [ ] **Step 3: Update Prisma schema**

In `packages/db/prisma/schema.prisma`:

Add to the `MemoryEvent` model (after the last relation field, before the `@@unique` lines):
```prisma
  embedding    MemoryEventEmbedding?
```

Add the new model at the end of the file:
```prisma
model MemoryEventEmbedding {
  eventId   String      @id
  model     String
  createdAt DateTime    @default(now())
  event     MemoryEvent @relation(fields: [eventId], references: [id], onDelete: Cascade)
}
```

Note: The `embedding vector(1536)` column is NOT in the Prisma schema — it's managed via raw SQL only. Prisma tracks only `eventId`, `model`, `createdAt`.

- [ ] **Step 4: Regenerate Prisma client**

```powershell
cd C:\StateCore\StateCore; pnpm --filter @statecore/db exec prisma generate
```

Expected: client regenerates with `MemoryEventEmbedding` model available.

- [ ] **Step 5: Restart Docker with new image and run migration**

```powershell
cd C:\StateCore\StateCore
docker compose -f docker-compose.local.yml down postgres
docker compose -f docker-compose.local.yml up -d postgres
Start-Sleep 5
pnpm --filter @statecore/db exec prisma migrate deploy
```

Expected: migration runs successfully, `MemoryEventEmbedding` table created with `vector` extension.

If migration fails with "extension vector does not exist": the pgvector image is not being used. Verify `docker compose images | grep postgres` shows `pgvector/pgvector`.

- [ ] **Step 6: Commit**

```powershell
cd C:\StateCore\StateCore
git add docker-compose.local.yml docker-compose.prod.yml packages/db/prisma/schema.prisma packages/db/prisma/migrations/20260615020000_pgvector_embeddings/
git commit -m "feat(db): add pgvector extension and MemoryEventEmbedding table"
```

---

## Task 2: RetrieveService Vector Search Path

**Files:**
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/src/retrieve-vector.test.ts`

### Context
`RetrieveService` is in `packages/core/src/index.ts` around line 270. Its constructor takes:
```typescript
constructor(
  private digests: DigestRepo,
  private memories: MemoryRepo,
  private options?: {
    embeddingModel?: EmbeddingModel | null;
    useEmbeddingRerank?: boolean;
    embeddingCandidateLimit?: number;
    // NEW:
    useVectorSearch?: boolean;
    vectorSearchFn?: (queryVector: number[], limit: number) => Promise<string[]>;
  }
)
```

`MemoryRepo` interface (around line 123) currently has `listRecent`. Need to add `findByIds`.

`retrieve()` returns `{ digest, events: MemoryEvent[], retrieval: { mode, matches, ... } }`.

- [ ] **Step 1: Write failing tests**

Create `packages/core/src/retrieve-vector.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { RetrieveService } from "./index";
import type { MemoryEvent } from "./index";

function event(partial: Partial<MemoryEvent> & Pick<MemoryEvent, "id" | "content">): MemoryEvent {
  return {
    scopeId: "sc", userId: "u", type: "stream", source: "api",
    createdAt: new Date("2026-01-01T10:00:00Z"),
    ...partial
  };
}

function mockRepos(keywordEvents: MemoryEvent[], vectorEvents: MemoryEvent[] = []) {
  const allById = new Map([...keywordEvents, ...vectorEvents].map(e => [e.id, e]));
  return {
    digestRepo: { findLatest: vi.fn().mockResolvedValue(null), listRecent: vi.fn() } as any,
    memoryRepo: {
      listRecent: vi.fn().mockResolvedValue({ items: keywordEvents, nextCursor: null }),
      findByIds: vi.fn().mockImplementation(async (ids: string[]) =>
        ids.map(id => allById.get(id)).filter(Boolean)
      )
    } as any
  };
}

describe("RetrieveService — vector search path", () => {
  it("includes vector search results that keyword search misses", async () => {
    const keywordEvent = event({ id: "kw", content: "database postgres storage" });
    const vectorOnlyEvent = event({ id: "vec", content: "We decided to use Postgres" });

    const { digestRepo, memoryRepo } = mockRepos([keywordEvent], [vectorOnlyEvent]);

    const vectorSearchFn = vi.fn().mockResolvedValue(["vec", "kw"]);
    const embeddingModel = { embed: vi.fn().mockResolvedValue([[1, 0, 0]]) };

    const service = new RetrieveService(digestRepo, memoryRepo, {
      useVectorSearch: true,
      vectorSearchFn,
      embeddingModel,
      useEmbeddingRerank: true,
      embeddingCandidateLimit: 10
    });

    const result = await service.retrieve("sc", 5, "persistence layer");

    const ids = result.events.map(e => e.id);
    expect(ids).toContain("vec");
    expect(ids).toContain("kw");
    expect(vectorSearchFn).toHaveBeenCalledWith(expect.any(Array), expect.any(Number));
    expect(memoryRepo.findByIds).toHaveBeenCalled();
  });

  it("deduplicates events appearing in both vector and keyword results", async () => {
    const sharedEvent = event({ id: "shared", content: "database postgres" });
    const { digestRepo, memoryRepo } = mockRepos([sharedEvent], [sharedEvent]);

    const vectorSearchFn = vi.fn().mockResolvedValue(["shared"]);
    const embeddingModel = { embed: vi.fn().mockResolvedValue([[1, 0, 0]]) };

    const service = new RetrieveService(digestRepo, memoryRepo, {
      useVectorSearch: true,
      vectorSearchFn,
      embeddingModel
    });

    const result = await service.retrieve("sc", 5, "database");

    const ids = result.events.map(e => e.id);
    expect(ids.filter(id => id === "shared")).toHaveLength(1);
  });

  it("falls back to keyword search when useVectorSearch is false", async () => {
    const e = event({ id: "e1", content: "postgres database" });
    const { digestRepo, memoryRepo } = mockRepos([e]);

    const vectorSearchFn = vi.fn();

    const service = new RetrieveService(digestRepo, memoryRepo, {
      useVectorSearch: false,
      vectorSearchFn
    });

    const result = await service.retrieve("sc", 5, "database");

    expect(result.events[0].id).toBe("e1");
    expect(vectorSearchFn).not.toHaveBeenCalled();
    expect(memoryRepo.findByIds).not.toHaveBeenCalled();
  });

  it("falls back to keyword search when vectorSearchFn throws", async () => {
    const e = event({ id: "e1", content: "postgres" });
    const { digestRepo, memoryRepo } = mockRepos([e]);

    const vectorSearchFn = vi.fn().mockRejectedValue(new Error("DB error"));
    const embeddingModel = { embed: vi.fn().mockResolvedValue([[1, 0, 0]]) };

    const service = new RetrieveService(digestRepo, memoryRepo, {
      useVectorSearch: true,
      vectorSearchFn,
      embeddingModel
    });

    const result = await service.retrieve("sc", 5, "postgres");

    expect(result.events[0].id).toBe("e1");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```powershell
cd C:\StateCore\StateCore; pnpm --filter @statecore/core test -- retrieve-vector 2>&1 | Select-Object -Last 15
```

Expected: 4 tests fail — `findByIds` not on MemoryRepo, `useVectorSearch`/`vectorSearchFn` options not on RetrieveService.

- [ ] **Step 3: Add findByIds to MemoryRepo interface**

In `packages/core/src/index.ts`, find the `MemoryRepo` interface (around line 123). Add after `listRecent`:

```typescript
  findByIds: (ids: string[]) => Promise<MemoryEvent[]>;
```

- [ ] **Step 4: Add vector search options to RetrieveService**

In `packages/core/src/index.ts`, find the `RetrieveService` constructor options type (around line 274). Replace the options block with:

```typescript
  private options?: {
    embeddingModel?: EmbeddingModel | null;
    useEmbeddingRerank?: boolean;
    embeddingCandidateLimit?: number;
    useVectorSearch?: boolean;
    vectorSearchFn?: (queryVector: number[], limit: number) => Promise<string[]>;
  }
```

- [ ] **Step 5: Add vector merge logic to retrieve()**

In `packages/core/src/index.ts`, find the `retrieve()` method. After the line:
```typescript
const events = await this.memories.listRecent(scopeId, candidateSize);
```

Add the vector search merge block:

```typescript
    let mergedItems = events.items;
    if (
      query?.trim() &&
      this.options?.useVectorSearch &&
      this.options.embeddingModel &&
      this.options.vectorSearchFn
    ) {
      try {
        const queryVectors = await this.options.embeddingModel.embed([query]);
        const queryVector = queryVectors[0];
        if (queryVector?.length) {
          const vectorIds = await this.options.vectorSearchFn(queryVector, candidateSize);
          if (vectorIds.length) {
            const keywordIdSet = new Set(events.items.map((e) => e.id));
            const newIds = vectorIds.filter((id) => !keywordIdSet.has(id));
            if (newIds.length) {
              const vectorEvents = await this.memories.findByIds(newIds);
              mergedItems = [...events.items, ...vectorEvents];
            }
          }
        }
      } catch {
        // Vector search failed — fall back to keyword candidates only
      }
    }
```

Then replace all subsequent uses of `events.items` with `mergedItems` in the `retrieve()` method body. Specifically, the `ranked` variable construction uses `events.items` — change it to `mergedItems`:

```typescript
    const ranked = mergedItems
      .map((event) => {
        // ... rest unchanged
```

Also update `newestTs`/`oldestTs` to use `mergedItems`:
```typescript
    const newestTs = mergedItems[0]?.createdAt.getTime() ?? Date.now();
    const oldestTs = mergedItems[mergedItems.length - 1]?.createdAt.getTime() ?? newestTs;
```

- [ ] **Step 6: Run tests to verify they pass**

```powershell
cd C:\StateCore\StateCore; pnpm --filter @statecore/core test 2>&1 | Select-Object -Last 10
```

Expected: all 157 pass (153 existing + 4 new).

If test 1 fails because vector events are deduplicated before being surfaced: check that `mergedItems` includes both keyword and vector events before ranking. The dedup should only prevent showing the same event twice if it appears in both pools.

- [ ] **Step 7: Commit**

```powershell
cd C:\StateCore\StateCore
git add packages/core/src/index.ts packages/core/src/retrieve-vector.test.ts
git commit -m "feat(core): add vector search merge path to RetrieveService"
```

---

## Task 3: Worker Embed Job

**Files:**
- Modify: `apps/worker/src/main.ts`
- Create: `apps/worker/src/embed-job.test.ts`

### Context
`apps/worker/src/main.ts` already has:
- `const llm` and `const structuredOutputModel` for LLM
- `const lockRedis = new Redis(workerEnv.redisUrl)` for the digest lock
- The existing `embeddingModel` is inside `createModelProvider(...)?.embedding`. Look for where `structuredOutputModel` is created and find the embedding model.

From `domain.service.ts`, the model provider creates: `provider?.embedding`. In the worker, this is `createModelProvider({...})?.embedding`.

- [ ] **Step 1: Write failing embed job tests**

Create `apps/worker/src/embed-job.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";

// runEmbedEventJob is not exported yet — tests will fail until we export it
// After implementation, import it:
// import { runEmbedEventJob } from "./embed-job";

describe("runEmbedEventJob", () => {
  it("embeds event content and upserts vector via raw SQL", async () => {
    const mockEvent = { id: "evt-1", content: "We decide to use Postgres" };
    const mockPrisma = {
      memoryEvent: { findUnique: vi.fn().mockResolvedValue(mockEvent) },
      $executeRaw: vi.fn().mockResolvedValue(1)
    } as any;

    const mockEmbeddingModel = {
      embed: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]])
    };

    const { runEmbedEventJob } = await import("./embed-job");
    await runEmbedEventJob(
      { eventId: "evt-1", scopeId: "sc" },
      mockEmbeddingModel,
      mockPrisma,
      "text-embedding-3-small"
    );

    expect(mockEmbeddingModel.embed).toHaveBeenCalledWith(["We decide to use Postgres"]);
    expect(mockPrisma.$executeRaw).toHaveBeenCalled();
  });

  it("skips silently when event not found", async () => {
    const mockPrisma = {
      memoryEvent: { findUnique: vi.fn().mockResolvedValue(null) },
      $executeRaw: vi.fn()
    } as any;
    const mockEmbeddingModel = { embed: vi.fn() };

    const { runEmbedEventJob } = await import("./embed-job");
    await runEmbedEventJob({ eventId: "missing", scopeId: "sc" }, mockEmbeddingModel, mockPrisma, "model");

    expect(mockEmbeddingModel.embed).not.toHaveBeenCalled();
    expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
  });

  it("skips silently when embeddingModel is null", async () => {
    const mockPrisma = { memoryEvent: { findUnique: vi.fn() }, $executeRaw: vi.fn() } as any;

    const { runEmbedEventJob } = await import("./embed-job");
    await runEmbedEventJob({ eventId: "evt-1", scopeId: "sc" }, null, mockPrisma, "");

    expect(mockPrisma.memoryEvent.findUnique).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify fail**

```powershell
cd C:\StateCore\StateCore; pnpm --filter @statecore/worker test 2>&1 | Select-Object -Last 15
```

Expected: tests fail — `./embed-job` module not found.

- [ ] **Step 3: Create embed-job.ts**

Create `apps/worker/src/embed-job.ts`:

```typescript
import { prisma } from "@statecore/db";
import type { EmbeddingModel } from "@statecore/core";

export async function runEmbedEventJob(
  data: { eventId: string; scopeId: string },
  embeddingModel: EmbeddingModel | null | undefined,
  db: typeof prisma = prisma,
  modelName: string
): Promise<void> {
  if (!embeddingModel) return;

  const event = await db.memoryEvent.findUnique({ where: { id: data.eventId } });
  if (!event) return;

  const vectors = await embeddingModel.embed([event.content]);
  const vector = vectors[0];
  if (!vector?.length) throw new Error(`Embedding returned empty vector for event ${data.eventId}`);

  const vectorString = `[${vector.join(",")}]`;
  await db.$executeRaw`
    INSERT INTO "MemoryEventEmbedding" ("eventId", "embedding", "model")
    VALUES (${data.eventId}, ${vectorString}::vector, ${modelName})
    ON CONFLICT ("eventId") DO UPDATE
      SET "embedding" = EXCLUDED."embedding",
          "model"     = EXCLUDED."model",
          "createdAt" = CURRENT_TIMESTAMP
  `;
}
```

- [ ] **Step 4: Register embed Worker in main.ts**

In `apps/worker/src/main.ts`, add import at top:
```typescript
import { runEmbedEventJob } from "./embed-job";
```

Find where the embedding model is constructed. Look for the `createModelProvider({...})` call. The result has `.embedding`. After the existing workers, add:

```typescript
const workerEmbeddingModel = structuredOutputModel
  ? createModelProvider({
      provider: workerEnv.modelProvider,
      apiKey: workerEnv.modelApiKey,
      baseUrl: workerEnv.modelBaseUrl,
      model: workerEnv.modelName,
      embeddingApiKey: workerEnv.embeddingModelApiKey,
      embeddingBaseUrl: workerEnv.embeddingModelBaseUrl,
      embeddingModel: workerEnv.embeddingModelName || undefined
    })?.embedding ?? null
  : null;

new Worker(
  "embed",
  async (job) => {
    if (job.name !== "embed_event") return;
    await runEmbedEventJob(
      job.data as { eventId: string; scopeId: string },
      workerEmbeddingModel,
      prisma,
      workerEnv.embedEventModel
    );
    return { ok: true };
  },
  { connection, concurrency: 4 }
).on("completed", (job) => {
  logger.info({ jobId: job.id }, "Embed job completed");
}).on("failed", (job, err) => {
  logger.error({ jobId: job?.id, err }, "Embed job failed");
});
```

Then add to `apps/worker/src/env.ts`:
```typescript
embedEventModel: clean(env.MODEL_EMBEDDING_NAME) || "",
```

- [ ] **Step 5: Run worker tests**

```powershell
cd C:\StateCore\StateCore; pnpm --filter @statecore/worker test 2>&1 | Select-Object -Last 10
```

Expected: 6 pass (3 existing + 3 new).

- [ ] **Step 6: Run core tests — confirm no regressions**

```powershell
cd C:\StateCore\StateCore; pnpm --filter @statecore/core test 2>&1 | Select-Object -Last 8
```

Expected: 157 pass.

- [ ] **Step 7: Commit**

```powershell
cd C:\StateCore\StateCore
git add apps/worker/src/embed-job.ts apps/worker/src/embed-job.test.ts apps/worker/src/main.ts apps/worker/src/env.ts
git commit -m "feat(worker): add embed_event job for async vector generation"
```

---

## Task 4: API Wiring — Queue, Trigger, Backfill, Env, Health

**Files:**
- Modify: `apps/api/src/queue.ts`
- Modify: `apps/api/src/env.ts`
- Modify: `apps/api/src/memory.controller.ts`
- Modify: `apps/api/src/domain.service.ts`
- Modify: `apps/api/src/health.controller.ts`

- [ ] **Step 1: Add embedQueue to queue.ts**

In `apps/api/src/queue.ts`, add `embedQueue` alongside the existing queues. Find the `isLite` block and update:

```typescript
export let embedQueue: IQueue;

if (isLite) {
  digestQueue = new InMemoryQueueAdapter();
  workingMemoryQueue = new InMemoryQueueAdapter();
  reminderQueue = new InMemoryQueueAdapter();
  embedQueue = new InMemoryQueueAdapter();
} else {
  const connection = { url: apiEnv.redisUrl as string };
  digestQueue = new BullMqQueueAdapter(new Queue("digest", { connection }));
  workingMemoryQueue = new BullMqQueueAdapter(new Queue("working-memory", { connection }));
  reminderQueue = new BullMqQueueAdapter(new Queue("reminder", { connection }));
  embedQueue = new BullMqQueueAdapter(new Queue("embed", { connection }));
}
```

- [ ] **Step 2: Add env var for vector search**

In `apps/api/src/env.ts`, find `retrieveUseEmbeddings` and add below it:
```typescript
retrieveUseVectorSearch: toBool(env.RETRIEVE_USE_VECTOR_SEARCH),
```

Also in the Zod env schema near the top of that file, add:
```typescript
RETRIEVE_USE_VECTOR_SEARCH: z.string().optional(),
```

- [ ] **Step 3: Trigger embed job after ingest**

In `apps/api/src/memory.controller.ts`:

Add import at top alongside existing queue imports:
```typescript
import { digestQueue, workingMemoryQueue, embedQueue } from "./queue";
```

Find the `ingestEvent` handler (around line 484). After:
```typescript
    const event = await this.domain.memoryService.ingestEvent({ ... });
```

Add:
```typescript
    // Queue async embedding generation (fire-and-forget, failure is non-critical)
    embedQueue.add("embed_event", { eventId: event.id, scopeId: input.scopeId }).catch(() => {
      // Embedding is best-effort — ingest must not fail if queue is unavailable
    });
```

- [ ] **Step 4: Add backfill endpoint**

In `apps/api/src/memory.controller.ts`, add after the `ingestEvent` handler:

```typescript
  @Post("/memory/embed/backfill")
  async backfillEmbeddings(@Req() req: RequestWithUser, @Body() body: unknown) {
    const input = z.object({ scopeId: z.string().uuid() }).parse(body);
    const scope = await this.domain.projectService.getScope(req.userId, input.scopeId);
    if (!scope) throw new NotFoundException("Scope not found");

    const eventsWithoutEmbedding = await prisma.$queryRaw<{ id: string }[]>`
      SELECT me.id
      FROM "MemoryEvent" me
      LEFT JOIN "MemoryEventEmbedding" mee ON me.id = mee."eventId"
      WHERE me."scopeId" = ${input.scopeId}
        AND mee."eventId" IS NULL
      ORDER BY me."createdAt" DESC
      LIMIT 1000
    `;

    for (const event of eventsWithoutEmbedding) {
      await embedQueue.add("embed_event", { eventId: event.id, scopeId: input.scopeId });
    }

    return { queued: eventsWithoutEmbedding.length };
  }
```

Make sure `prisma` is imported at the top of the file:
```typescript
import { prisma } from "@statecore/db";
```

(It may already be imported — check before adding.)

- [ ] **Step 5: Wire vectorSearchFn and findByIds into DomainService**

In `apps/api/src/domain.service.ts`, find where `RetrieveService` is instantiated (around line 231). Update:

First, add `findByIds` to the `memoryRepo` object:
```typescript
findByIds: (ids: string[]) => prisma.memoryEvent.findMany({ where: { id: { in: ids } } }),
```

Then update `RetrieveService` construction to add the vector search options:
```typescript
    this.retrieveService = new RetrieveService(digestRepo, memoryRepo, {
      embeddingModel: provider?.embedding ?? null,
      useEmbeddingRerank: apiEnv.retrieveUseEmbeddings,
      embeddingCandidateLimit: apiEnv.retrieveEmbeddingCandidateLimit,
      useVectorSearch: apiEnv.retrieveUseVectorSearch,
      vectorSearchFn: apiEnv.retrieveUseVectorSearch && provider?.embedding
        ? async (queryVector: number[], limit: number) => {
            const vectorString = `[${queryVector.join(",")}]`;
            const rows = await prisma.$queryRaw<{ eventId: string }[]>`
              SELECT "eventId"
              FROM "MemoryEventEmbedding"
              ORDER BY embedding <-> ${vectorString}::vector
              LIMIT ${limit}
            `;
            return rows.map((r) => r.eventId);
          }
        : undefined
    });
```

- [ ] **Step 6: Update health controller**

In `apps/api/src/health.controller.ts`, find the health endpoint response. It currently returns `retrieve: { useEmbeddings: boolean, ... }`. Add `useVectorSearch`:

```typescript
retrieve: {
  useEmbeddings: apiEnv.retrieveUseEmbeddings,
  useVectorSearch: apiEnv.retrieveUseVectorSearch,
  // ... existing fields
}
```

- [ ] **Step 7: Run all tests**

```powershell
cd C:\StateCore\StateCore; pnpm --filter @statecore/core test 2>&1 | Select-Object -Last 8
cd C:\StateCore\StateCore; pnpm --filter @statecore/worker test 2>&1 | Select-Object -Last 8
cd C:\StateCore\StateCore; pnpm --filter @statecore/api test 2>&1 | Select-Object -Last 8
```

Expected: core 157 pass, worker 6 pass, api tests pass (pre-existing integration failures unrelated to this change).

- [ ] **Step 8: Commit and push**

```powershell
cd C:\StateCore\StateCore
git add apps/api/src/queue.ts apps/api/src/env.ts apps/api/src/memory.controller.ts apps/api/src/domain.service.ts apps/api/src/health.controller.ts
git commit -m "feat(api): wire vector search — embedQueue, backfill endpoint, RETRIEVE_USE_VECTOR_SEARCH"
git push origin main
```

---

## Self-Review

**Spec coverage:**
| Spec requirement | Task |
|----------------|------|
| Docker image → pgvector/pgvector:pg16 | Task 1 ✅ |
| CREATE EXTENSION vector + MemoryEventEmbedding table | Task 1 ✅ |
| Prisma MemoryEventEmbedding model + relation | Task 1 ✅ |
| runEmbedEventJob: embed → raw SQL upsert | Task 3 ✅ |
| embed_event BullMQ Worker | Task 3 ✅ |
| Trigger embed job after ingest | Task 4 ✅ |
| POST /memory/embed/backfill | Task 4 ✅ |
| findByIds on MemoryRepo | Task 2 ✅ |
| useVectorSearch + vectorSearchFn on RetrieveService | Task 2 ✅ |
| Vector merge logic in retrieve() | Task 2 ✅ |
| RETRIEVE_USE_VECTOR_SEARCH env var | Task 4 ✅ |
| vectorSearchFn injected in DomainService | Task 4 ✅ |
| health endpoint shows useVectorSearch | Task 4 ✅ |
| All 153 existing tests pass | Verified in each task ✅ |

**Placeholder scan:** None found.

**Type consistency:**
- `runEmbedEventJob(data, embeddingModel, db, modelName)` — same signature in test file and main.ts ✅
- `vectorSearchFn: (queryVector: number[], limit: number) => Promise<string[]>` — consistent across RetrieveService options and DomainService injection ✅
- `findByIds: (ids: string[]) => Promise<MemoryEvent[]>` — consistent across MemoryRepo interface and domain.service.ts implementation ✅
- `embedQueue` exported from `queue.ts`, imported in `memory.controller.ts` ✅
