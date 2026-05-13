# SQLite Lite Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `STATECORE_MODE=lite` that uses SQLite + in-process fire-and-forget queues so StateCore runs with zero Docker dependencies.

**Architecture:** Two Prisma schemas (PostgreSQL for full, SQLite for lite) with runtime client selection. A `IQueue` abstraction layer replaces direct BullMQ imports; in lite mode, `InMemoryQueueAdapter` runs jobs via `setImmediate`. `DomainService` registers the WM update handler. Full mode code paths are untouched.

**Tech Stack:** Prisma 6 (multi-schema), SQLite, TypeScript conditional require, NestJS DI, Vitest.

---

## File Map

| File | Change |
|------|--------|
| `packages/db/prisma/schema.lite.prisma` | Create — SQLite schema identical to PostgreSQL schema |
| `packages/db/package.json` | Add `generate:lite` and `push:lite` scripts |
| `packages/db/src/index.ts` | Conditional Prisma client (full vs lite) |
| `.gitignore` | Add `packages/db/generated/` |
| `apps/api/src/queue-adapter.ts` | Create — `IQueue` + `BullMqQueueAdapter` + `InMemoryQueueAdapter` |
| `apps/api/src/queue-adapter.test.ts` | Create — unit tests for adapters |
| `apps/api/src/queue.ts` | Refactor to use adapters + add `registerLiteHandlers()` |
| `apps/api/src/env.ts` | Make `REDIS_URL` optional + add `STATECORE_MODE` |
| `apps/api/src/domain.service.ts` | Register lite WM handler in constructor |
| `package.json` (root) | Add `db:generate:lite`, `db:push:lite`, `dev:lite` scripts |
| `.env.example` | Add lite mode section |

---

## Task 1: SQLite Prisma Schema + Client

**Files:**
- Create: `packages/db/prisma/schema.lite.prisma`
- Modify: `packages/db/package.json`
- Modify: `packages/db/src/index.ts`
- Modify: `.gitignore`
- Modify: `package.json` (root)

- [ ] **Step 1: Create schema.lite.prisma**

Create `packages/db/prisma/schema.lite.prisma` with this exact content:

```prisma
generator client {
  provider = "prisma-client-js"
  output   = "../generated/client-lite"
}

datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}

enum ProjectStage {
  idea
  build
  test
  launch
}

enum MemoryType {
  stream
  document
}

enum MemorySource {
  telegram
  cli
  api
  sdk
}

enum ReminderStatus {
  scheduled
  sent
  cancelled
}

model User {
  id             String   @id @default(uuid())
  identity       String   @unique
  telegramUserId String?  @unique
  createdAt      DateTime @default(now())

  scopes    ProjectScope[]
  state     UserState?
  memories  MemoryEvent[]
  reminders Reminder[]
}

model ProjectScope {
  id        String       @id @default(uuid())
  userId    String
  name      String
  goal      String?
  stage     ProjectStage @default(idea)
  createdAt DateTime     @default(now())

  user         User                  @relation(fields: [userId], references: [id])
  memories     MemoryEvent[]
  digests      Digest[]
  digestStates DigestStateSnapshot[]
  workingMemory WorkingMemorySnapshot?
  reminders    Reminder[]
  userStates   UserState[]

  @@index([userId])
}

model UserState {
  userId          String  @id
  activeProjectId String?

  user          User          @relation(fields: [userId], references: [id])
  activeProject ProjectScope? @relation(fields: [activeProjectId], references: [id])
}

model MemoryEvent {
  id          String       @id @default(uuid())
  userId      String
  scopeId     String
  type        MemoryType
  source      MemorySource @default(api)
  key         String?
  content     String
  contentHash String?
  chatId      String?
  messageId   String?
  createdAt   DateTime     @default(now())
  updatedAt   DateTime?

  user  User         @relation(fields: [userId], references: [id])
  scope ProjectScope @relation(fields: [scopeId], references: [id])

  @@unique([scopeId, key])
  @@index([userId, scopeId, createdAt])
  @@index([scopeId, key])
}

model Digest {
  id             String   @id @default(uuid())
  scopeId        String
  summary        String
  changes        String
  nextSteps      Json
  rebuildGroupId String?
  createdAt      DateTime @default(now())

  scope          ProjectScope        @relation(fields: [scopeId], references: [id])
  stateSnapshot  DigestStateSnapshot?

  @@index([scopeId, createdAt])
  @@index([scopeId, rebuildGroupId])
}

model DigestStateSnapshot {
  id          String   @id @default(uuid())
  scopeId     String
  digestId    String   @unique
  state       Json
  consistency Json?
  createdAt   DateTime @default(now())

  scope  ProjectScope @relation(fields: [scopeId], references: [id])
  digest Digest       @relation(fields: [digestId], references: [id])

  @@index([scopeId, createdAt])
}

model WorkingMemorySnapshot {
  id        String   @id @default(uuid())
  scopeId    String   @unique
  version    Int      @default(1)
  state      Json
  view       Json
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt

  scope ProjectScope @relation(fields: [scopeId], references: [id])

  @@index([scopeId, updatedAt])
}

model Reminder {
  id        String         @id @default(uuid())
  userId    String
  scopeId   String?
  dueAt     DateTime
  text      String
  status    ReminderStatus @default(scheduled)
  createdAt DateTime       @default(now())

  user  User          @relation(fields: [userId], references: [id])
  scope ProjectScope? @relation(fields: [scopeId], references: [id])

  @@index([userId, status, dueAt])
}
```

Note: SQLite does not support enums natively. Prisma maps them to `TEXT` automatically. `Json` fields are stored as `TEXT`. These work transparently through the ORM.

- [ ] **Step 2: Add scripts to packages/db/package.json**

Current scripts in `packages/db/package.json`:
```json
"scripts": {
  "build": "tsc -p tsconfig.json",
  "prisma": "prisma",
  "seed": "tsx src/seed.ts"
}
```

Add two scripts:
```json
"scripts": {
  "build": "tsc -p tsconfig.json",
  "prisma": "prisma",
  "seed": "tsx src/seed.ts",
  "generate:lite": "prisma generate --schema=prisma/schema.lite.prisma",
  "push:lite": "prisma db push --schema=prisma/schema.lite.prisma"
}
```

- [ ] **Step 3: Generate the lite Prisma client**

```bash
pnpm db:generate:lite
```

Wait — this script doesn't exist in root yet. Run directly:
```bash
cd packages/db && DATABASE_URL=file:./statecore.db pnpm generate:lite
```

Expected: `packages/db/generated/client-lite/` directory created with Prisma client files.

- [ ] **Step 4: Add generated directory to .gitignore**

Open `.gitignore` at repo root. Add this line:
```
packages/db/generated/
```

- [ ] **Step 5: Update packages/db/src/index.ts**

Replace the entire content of `packages/db/src/index.ts`:

```typescript
import type { PrismaClient } from "@prisma/client";

function createPrismaClient(): PrismaClient {
  if (process.env["STATECORE_MODE"] === "lite") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PrismaClient: LiteClient } = require("../generated/client-lite");
    return new LiteClient() as PrismaClient;
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PrismaClient: FullClient } = require("@prisma/client");
  return new FullClient();
}

export const prisma = createPrismaClient();
```

- [ ] **Step 6: Add root scripts to package.json**

Open root `package.json`. In the `scripts` section, after `"db:deploy": ...` add:
```json
"db:generate:lite": "pnpm --filter @statecore/db generate:lite",
"db:push:lite": "DATABASE_URL=file:./statecore.db pnpm --filter @statecore/db push:lite",
```

- [ ] **Step 7: Verify full mode still works**

```bash
pnpm db:generate
```
Expected: `@prisma/client` regenerated normally, no errors. The lite schema is independent.

- [ ] **Step 8: Commit**

```bash
git add packages/db/prisma/schema.lite.prisma packages/db/package.json packages/db/src/index.ts .gitignore package.json
git commit -m "feat(db): add SQLite lite mode schema and conditional Prisma client"
```

---

## Task 2: Queue Abstraction Layer

**Files:**
- Create: `apps/api/src/queue-adapter.ts`
- Create: `apps/api/src/queue-adapter.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/queue-adapter.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { InMemoryQueueAdapter, BullMqQueueAdapter } from "./queue-adapter";

describe("InMemoryQueueAdapter", () => {
  it("resolves without error when no handler registered", async () => {
    const adapter = new InMemoryQueueAdapter();
    await expect(adapter.add("test-job", { x: 1 })).resolves.toBeUndefined();
  });

  it("calls registered handler with job name and data via setImmediate", async () => {
    const adapter = new InMemoryQueueAdapter();
    const handler = vi.fn().mockResolvedValue(undefined);
    adapter.register(handler);

    await adapter.add("my-job", { foo: "bar" });
    // handler not called yet (setImmediate)
    expect(handler).not.toHaveBeenCalled();

    // flush setImmediate
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(handler).toHaveBeenCalledWith("my-job", { foo: "bar" });
  });

  it("swallows handler errors without throwing", async () => {
    const adapter = new InMemoryQueueAdapter();
    adapter.register(async () => { throw new Error("boom"); });

    await adapter.add("bad-job", {});
    await new Promise<void>((resolve) => setImmediate(resolve));
    // no throw — error is caught internally
  });
});

describe("BullMqQueueAdapter", () => {
  it("delegates add() to the underlying BullMQ queue", async () => {
    const mockQueue = { add: vi.fn().mockResolvedValue({ id: "1" }) };
    const adapter = new BullMqQueueAdapter(mockQueue as unknown as import("bullmq").Queue);
    await adapter.add("test-job", { x: 1 });
    expect(mockQueue.add).toHaveBeenCalledWith("test-job", { x: 1 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/api && pnpm test -- --reporter=verbose 2>&1 | grep -E "FAIL|PASS|queue-adapter"
```
Expected: FAIL — `queue-adapter` not found.

- [ ] **Step 3: Create queue-adapter.ts**

Create `apps/api/src/queue-adapter.ts`:

```typescript
import type { Queue } from "bullmq";

export interface IQueue {
  add(jobName: string, data: unknown): Promise<void>;
}

export class BullMqQueueAdapter implements IQueue {
  constructor(private readonly queue: Queue) {}

  async add(jobName: string, data: unknown): Promise<void> {
    await this.queue.add(jobName, data as object);
  }
}

export class InMemoryQueueAdapter implements IQueue {
  private handler: ((jobName: string, data: unknown) => Promise<void>) | null = null;

  register(handler: (jobName: string, data: unknown) => Promise<void>): void {
    this.handler = handler;
  }

  async add(jobName: string, data: unknown): Promise<void> {
    if (!this.handler) return;
    const h = this.handler;
    setImmediate(() => {
      h(jobName, data).catch((err: unknown) => {
        console.error(`[InMemoryQueue] job ${jobName} failed:`, err);
      });
    });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/api && pnpm test 2>&1 | tail -10
```
Expected: all tests pass (4 filter tests + 3 new queue-adapter tests = 7 total; integration tests also run = more).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/queue-adapter.ts apps/api/src/queue-adapter.test.ts
git commit -m "feat(api): add IQueue abstraction with BullMQ and in-memory adapters"
```

---

## Task 3: Refactor queue.ts + env.ts

**Files:**
- Modify: `apps/api/src/queue.ts`
- Modify: `apps/api/src/env.ts`

- [ ] **Step 1: Refactor queue.ts**

Replace the entire content of `apps/api/src/queue.ts`:

```typescript
import { Queue } from "bullmq";
import { apiEnv } from "./env";
import { BullMqQueueAdapter, InMemoryQueueAdapter, type IQueue } from "./queue-adapter";

const isLite = process.env["STATECORE_MODE"] === "lite";

export let digestQueue: IQueue;
export let workingMemoryQueue: IQueue;
export let reminderQueue: IQueue;

if (isLite) {
  digestQueue = new InMemoryQueueAdapter();
  workingMemoryQueue = new InMemoryQueueAdapter();
  reminderQueue = new InMemoryQueueAdapter();
} else {
  const connection = { url: apiEnv.redisUrl as string };
  digestQueue = new BullMqQueueAdapter(new Queue("digest", { connection }));
  workingMemoryQueue = new BullMqQueueAdapter(new Queue("working-memory", { connection }));
  reminderQueue = new BullMqQueueAdapter(new Queue("reminder", { connection }));
}

export function registerLiteHandlers(handlers: {
  workingMemory: (jobName: string, data: unknown) => Promise<void>;
}): void {
  if (!isLite) return;
  (workingMemoryQueue as InMemoryQueueAdapter).register(handlers.workingMemory);
}
```

- [ ] **Step 2: Update env.ts — make REDIS_URL optional + add STATECORE_MODE**

In `apps/api/src/env.ts`, find line 27:
```typescript
  REDIS_URL: z.string().min(1),
```
Replace with:
```typescript
  REDIS_URL: z.string().optional(),
  STATECORE_MODE: z.enum(["lite", "full"]).optional(),
```

Then, after the existing `parsed.success` check (line 68-73), add a new validation block. Find the section after `process.exit(1);` on line 73 and the blank line, then add before `const env = parsed.data;`:

```typescript
// Validate REDIS_URL requirement based on mode
const parsedMode = (process.env["STATECORE_MODE"] === "lite") ? "lite" : "full";
if (parsedMode !== "lite" && !process.env["REDIS_URL"]) {
  // eslint-disable-next-line no-console
  console.error("REDIS_URL is required in full mode. Set STATECORE_MODE=lite for zero-dependency development mode.");
  process.exit(1);
}
```

Then find line 133 in the `apiEnv` export:
```typescript
  redisUrl: env.REDIS_URL,
```
Replace with:
```typescript
  redisUrl: env.REDIS_URL ?? "",
  mode: (env.STATECORE_MODE ?? "full") as "lite" | "full",
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd apps/api && pnpm build 2>&1 | grep -E "error TS|warning"
```
Expected: same pre-existing errors only, no new errors from the queue.ts or env.ts changes.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/queue.ts apps/api/src/env.ts
git commit -m "feat(api): refactor queue.ts to use IQueue adapters, make REDIS_URL optional in lite mode"
```

---

## Task 4: DomainService + Scripts + Documentation

**Files:**
- Modify: `apps/api/src/domain.service.ts`
- Modify: `package.json` (root)
- Modify: `.env.example`

- [ ] **Step 1: Register lite WM handler in DomainService**

In `apps/api/src/domain.service.ts`, add these imports after the existing import block:

```typescript
import { registerLiteHandlers } from "./queue";
import { selectWorkingMemoryEvents } from "@statecore/core";
```

Then at the END of the `constructor()` body (after line 234: `this.reminderService = new ReminderService(reminderRepo);`), add:

```typescript
    if (process.env["STATECORE_MODE"] === "lite") {
      const wmMaxTurns = apiEnv.workingMemoryMaxRecentTurns;
      const wmSvc = this.workingMemoryService;
      registerLiteHandlers({
        workingMemory: async (_jobName, data) => {
          const { scopeId } = data as { userId: string; scopeId: string };
          const take = Math.max(wmMaxTurns * 3, wmMaxTurns + 8);
          const { prisma: db } = await import("@statecore/db");
          const recentEvents = await db.memoryEvent.findMany({
            where: { scopeId },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take
          });
          const selected = selectWorkingMemoryEvents(
            recentEvents.reverse().map((event) => ({
              id: event.id,
              type: event.type as "stream" | "document",
              key: event.key ?? null,
              content: event.content,
              createdAt: event.createdAt,
              role: /^assistant reply:/i.test(event.content.trim()) ? "assistant" as const : "user" as const
            })),
            wmMaxTurns
          );
          await wmSvc.updateFromEvents(scopeId, selected);
        }
      });
    }
```

The handler mirrors what `apps/worker/src/main.ts:324-357` does: fetch recent events, select relevant ones via `selectWorkingMemoryEvents`, and call `updateFromEvents`.

- [ ] **Step 2: Add dev:lite to root package.json scripts**

In root `package.json`, add after `"dev:mcp": ...`:

```json
"dev:lite": "STATECORE_MODE=lite DATABASE_URL=file:./statecore.db pnpm dev:api",
```

On Windows (PowerShell doesn't support inline env), also add a cross-platform variant using cross-env. Actually, since the project uses shell scripts for dev commands (see `dev:demo-stack`), keep it simple and note that Windows users should set env vars manually or use a `.env.lite` file.

For Windows compatibility, change to:
```json
"dev:lite": "pnpm --filter @statecore/api exec tsx src/main.ts",
```

And document in `.env.example` that users should set `STATECORE_MODE=lite` and `DATABASE_URL=file:./statecore.db` in their `.env` file.

Actually, the simplest cross-platform approach: the `.env` file is loaded by `env.ts` at startup. So just document the `.env` values and use a regular `pnpm dev:api` call:

```json
"dev:lite": "pnpm dev:api",
```

And in `.env.example`, show the lite config. This is the most reliable cross-platform approach.

- [ ] **Step 3: Add lite mode section to .env.example**

Open `.env.example`. After the DATABASE_URL line (around line 15), add a comment block:

```
# --- Lite mode (zero Docker dependencies) ---
# Uncomment these lines and comment out DATABASE_URL + REDIS_URL above
# STATECORE_MODE=lite
# DATABASE_URL=file:./statecore.db
# (REDIS_URL not needed in lite mode)
# Setup: pnpm db:generate:lite && pnpm db:push:lite && pnpm dev:lite
# ---
```

- [ ] **Step 4: Test lite mode end-to-end**

First, generate the lite client and push the schema:
```bash
pnpm db:generate:lite
pnpm db:push:lite
```
Expected: `statecore.db` file created at repo root with all tables.

Then verify the API starts in lite mode (no Docker required):
```bash
STATECORE_MODE=lite DATABASE_URL=file:./statecore.db pnpm dev:api &
sleep 3
curl -s http://localhost:3000/health
```
Expected: `{"ok":true}` (or similar health response).

Then create a scope:
```bash
curl -s -X POST http://localhost:3000/scopes \
  -H "Content-Type: application/json" \
  -H "x-user-id: lite-test" \
  -d '{"name":"my-lite-project"}'
```
Expected: JSON with `id` and `name: "my-lite-project"`.

Kill the test server: `kill %1`

- [ ] **Step 5: Run all tests to confirm nothing broke**

```bash
cd apps/api && pnpm test 2>&1 | tail -15
```
Expected: all tests pass (filter tests + queue-adapter tests + integration tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/domain.service.ts package.json .env.example
git commit -m "feat(api): add STATECORE_MODE=lite with SQLite + in-process WM updates"
```
