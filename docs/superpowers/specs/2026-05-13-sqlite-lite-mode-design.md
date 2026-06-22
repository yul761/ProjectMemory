# SQLite Lite Mode Design

**Date:** 2026-05-13
**Status:** Shelved — out of terminal scope (production path is Postgres + pgvector); see core-readiness W4 (2026-06-21).

## Problem

StateCore requires PostgreSQL + Redis to start. New developers must run Docker before they can try it. This raises the barrier to entry and creates friction for personal/solo use.

## Goal

Add a `STATECORE_MODE=lite` option that uses SQLite (file-based) instead of PostgreSQL, and runs background jobs in-process instead of BullMQ + Redis. Full mode (PostgreSQL + BullMQ) must be completely unaffected.

## Approach

Two schema files, a queue abstraction layer, and conditional env validation. Full mode has zero code changes to its hot paths.

---

## Architecture

```
STATECORE_MODE=lite:
  DATABASE_URL=file:./statecore.db  → SQLite (Prisma client-lite)
  REDIS_URL                         → not required
  Queues                            → InMemoryQueue (fire-and-forget)
  Worker process                    → not needed

STATECORE_MODE=full (default, unchanged):
  DATABASE_URL=postgresql://...     → PostgreSQL (Prisma client)
  REDIS_URL required                → BullMQ queues
  Worker process                    → separate (unchanged)
```

---

## File Changes

### 1. `packages/db/prisma/schema.lite.prisma`

Copy of `schema.prisma` with two differences:
- `provider = "sqlite"` instead of `"postgresql"`
- Generator output: `"../generated/client-lite"` (separate directory)

JSON fields (`Digest.nextSteps`, `DigestStateSnapshot.state`, `DigestStateSnapshot.consistency`, `WorkingMemorySnapshot.state`, `WorkingMemorySnapshot.view`) stay as `Json` — Prisma serializes these to TEXT automatically for SQLite.

### 2. `packages/db/package.json`

Add two scripts:
- `"generate:lite": "prisma generate --schema=prisma/schema.lite.prisma"` — generate SQLite client
- `"push:lite": "prisma db push --schema=prisma/schema.lite.prisma"` — create/update SQLite DB schema

Add to root `package.json`:
- `"db:generate:lite": "pnpm --filter @statecore/db generate:lite"`
- `"db:push:lite": "pnpm --filter @statecore/db push:lite"`

### 3. `packages/db/src/index.ts`

Export `prisma` that selects client at runtime:

```typescript
import type { PrismaClient } from "@prisma/client";

function createPrismaClient(): PrismaClient {
  if (process.env["STATECORE_MODE"] === "lite") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PrismaClient: LiteClient } = require("../generated/client-lite");
    return new LiteClient() as PrismaClient;
  }
  const { PrismaClient: FullClient } = require("@prisma/client");
  return new FullClient();
}

export const prisma = createPrismaClient();
```

Type-safe: both clients have identical schema, cast is safe.

### 4. `apps/api/src/queue-adapter.ts` (new file)

```typescript
export interface IQueue {
  add(jobName: string, data: unknown): Promise<void>;
}
```

Two implementations:
- `BullMqQueueAdapter`: wraps existing `Queue` from bullmq, delegates `.add()`
- `InMemoryQueueAdapter`: accepts a handler function, runs it via `setImmediate` (fire-and-forget)

### 5. `apps/api/src/queue.ts`

In full mode (unchanged behavior): export BullMQ Queue instances wrapped in `BullMqQueueAdapter`.

In lite mode: export `InMemoryQueueAdapter` instances. The working memory adapter handler calls `DomainService.workingMemoryService.extractAndPersist()`. Digest adapter is a no-op (FEATURE_LLM defaults to false in lite mode). Reminder adapter is a no-op.

**Dependency injection problem:** `queue.ts` is a module-level singleton — it can't import DomainService (circular dependency). Solution: use a late-binding callback pattern:

```typescript
// queue.ts exports a setter
export function registerLiteHandlers(handlers: LiteHandlers): void
```

`DomainService` constructor calls `registerLiteHandlers(...)` when `STATECORE_MODE=lite`.

### 6. `apps/api/src/env.ts`

Change `REDIS_URL` validation:
```typescript
// Before:
REDIS_URL: z.string().min(1),

// After:
REDIS_URL: z.string().optional(),
```

Add:
```typescript
STATECORE_MODE: z.enum(["lite", "full"]).optional(),
```

Post-parse validation: if `STATECORE_MODE !== "lite"` AND `REDIS_URL` is empty → throw error with message "REDIS_URL required in full mode. Set STATECORE_MODE=lite for zero-dependency development."

### 7. `.env.example`

Add lite mode section with quickstart instructions.

### 8. Root `package.json`

Add `"dev:lite"` script:
```json
"dev:lite": "STATECORE_MODE=lite DATABASE_URL=file:./statecore.db pnpm dev:api"
```

---

## Lite Mode Startup Flow

1. Developer runs `pnpm dev:lite` (or sets env vars manually)
2. `packages/db/src/index.ts` loads Prisma client from `generated/client-lite`
3. `apps/api/src/env.ts` skips REDIS_URL validation
4. `apps/api/src/queue.ts` creates `InMemoryQueueAdapter` instances
5. NestJS starts, `DomainService` registers live handlers on the adapters
6. WM updates fire in-process via `setImmediate`

**First run setup:**
```bash
pnpm db:generate:lite   # generate SQLite Prisma client
pnpm db:push:lite       # create statecore.db with schema
pnpm dev:lite           # start
```

---

## What Works in Lite Mode

| Feature | Works |
|---------|-------|
| Scope CRUD | ✅ |
| Event ingestion | ✅ |
| Working Memory updates | ✅ (in-process) |
| Fast View | ✅ |
| Digest generation | ❌ (requires FEATURE_LLM=true + LLM config) |
| Answer/Recall | ❌ (requires FEATURE_LLM=true) |
| Runtime Turn | ❌ (requires FEATURE_LLM=true) |
| Reminders | ❌ (no-op in lite) |
| Telegram adapter | ❌ (FEATURE_TELEGRAM=false default) |

---

## Out of Scope

- SQLite migrations (use `db push` for schema sync)
- Lite worker process (all jobs run in-process)
- Reminder delivery in lite mode
- Performance optimization of SQLite path
