# W1 — Tenant Isolation Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the cross-tenant data-leak in vector search and harden two defense-in-depth gaps so user A can never read user B's data, with a durable regression test guarding it.

**Architecture:** Two layers of protection. (1) The raw SQL vector query is scoped by `scopeId` at the data layer. (2) `RetrieveService` independently filters vector hits to the requested scope after fetch (defense-in-depth, fully unit-testable without a DB). Two controller raw-SQL/update sites gain composite `(id/scopeId, userId)` predicates. A multi-tenant integration test exercises real cross-user HTTP access and is the permanent guard for Definition-of-Ready #1.

**Tech Stack:** TypeScript (strict), NestJS, Prisma + Postgres/pgvector, vitest, supertest.

## Global Constraints

- Core readiness scope is `packages/*`, `apps/api`, `apps/worker` only — do not touch `apps/cli`, `apps/adapter-telegram`, `apps/adapter-mcp`, `apps/demo-web`.
- No new core memory capabilities; this workstream is correctness/hardening only.
- Contract/signature changes must stay backward-additive where possible; the one signature change here (`vectorSearchFn`) is internal (not part of the public HTTP contract).
- No `any`: the repo lints `@typescript-eslint/no-explicit-any`. Use precise types or a named structural type.
- Conventional-commit messages. End every commit message with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Unit tests run with `pnpm --filter @statecore/core test` and `pnpm --filter @statecore/api test`. Integration tests (Task 4) need the provisioned Postgres test DB — see Task 4 prerequisite.

## File Structure

- `packages/core/src/index.ts` — `RetrieveService`: change `vectorSearchFn` signature to receive `scopeId`; pass it at the call site; filter fetched vector events by `scopeId`. (Modify)
- `packages/core/src/retrieve-vector.test.ts` — update the existing call-args assertion; add a tenant-isolation unit test. (Modify)
- `apps/api/src/vector-search.ts` — NEW. Exports `createVectorSearchFn(client)` returning a scope-filtered vector search closure. Isolating it makes the SQL unit-testable. (Create)
- `apps/api/src/vector-search.test.ts` — NEW. Unit test asserting the query is scope-parameterized. (Create)
- `apps/api/src/domain.service.ts` — replace the inline `vectorSearchFn` closure with `createVectorSearchFn(prisma)`. (Modify)
- `apps/api/src/memory.controller.ts` — `backfillEmbeddings`: add `userId` predicate to the raw SQL. (Modify)
- `apps/api/src/scopes.controller.ts` — `setWebhook`: switch to `updateMany` with `{ id, userId }` and assert a row was updated. (Modify)
- `apps/api/src/test/multi-tenant-isolation.integration.test.ts` — NEW. Cross-user HTTP regression matrix. (Create)

---

### Task 1: Scope-filter vector hits inside RetrieveService (defense-in-depth, unit-tested)

**Files:**
- Modify: `packages/core/src/index.ts:282` (signature), `:440` (call site), `:445-446` (post-fetch filter)
- Test: `packages/core/src/retrieve-vector.test.ts`

**Interfaces:**
- Produces: `vectorSearchFn?: (queryVector: number[], limit: number, scopeId: string) => Promise<string[]>` — the third positional arg `scopeId` is the active scope. Consumers (Task 2's `createVectorSearchFn`) must accept and honor it.

- [ ] **Step 1: Update the existing call-args assertion and add the failing isolation test**

In `packages/core/src/retrieve-vector.test.ts`, the existing "includes vector search results" test asserts the call args — update it to expect the new third argument:

```ts
expect(vectorSearchFn).toHaveBeenCalledWith(expect.any(Array), expect.any(Number), "sc");
```

Then add this new test inside the `describe("RetrieveService — vector search path", ...)` block:

```ts
it("excludes vector hits that belong to a different scope (tenant isolation)", async () => {
  const kwEvent = event({ id: "kw", scopeId: "sc", content: "database postgres storage" });
  const foreignEvent = event({ id: "foreign", scopeId: "OTHER", content: "We decided to use Postgres" });
  const { digestRepo, memoryRepo } = mockRepos([kwEvent], [foreignEvent]);

  // Simulate a leaky data layer: vector search returns an id from another scope.
  const vectorSearchFn = vi.fn().mockResolvedValue(["foreign", "kw"]);
  const embeddingModel = { embed: vi.fn().mockResolvedValue([[1, 0, 0]]) };

  const service = new RetrieveService(digestRepo, memoryRepo, {
    useVectorSearch: true,
    vectorSearchFn,
    embeddingModel,
    useEmbeddingRerank: true,
    embeddingCandidateLimit: 10
  });

  const result = await service.retrieve("sc", 5, "persistence layer");
  const ids = result.events.map((e) => e.id);

  expect(ids).toContain("kw");
  expect(ids).not.toContain("foreign");
  expect(vectorSearchFn).toHaveBeenCalledWith(expect.any(Array), expect.any(Number), "sc");
});
```

- [ ] **Step 2: Run the tests to verify the new one fails**

Run: `pnpm --filter @statecore/core test -- retrieve-vector`
Expected: FAIL — the isolation test fails because `foreign` is currently included, and the updated call-args assertion fails (only 2 args passed today).

- [ ] **Step 3: Thread `scopeId` through and filter fetched events**

In `packages/core/src/index.ts`, change the option type (currently line ~282):

```ts
      vectorSearchFn?: (queryVector: number[], limit: number, scopeId: string) => Promise<string[]>;
```

At the call site inside `retrieve(scopeId, limit, query?)` (currently line ~440), pass `scopeId`:

```ts
          const vectorIds = await this.options.vectorSearchFn(queryVector, candidateSize, scopeId);
```

And where the fetched events are merged (currently lines ~445-446), filter to the requested scope:

```ts
            if (newIds.length) {
              const vectorEvents = (await this.memories.findByIds(newIds)).filter(
                (e) => e.scopeId === scopeId
              );
              mergedItems = [...events.items, ...vectorEvents];
            }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @statecore/core test -- retrieve-vector`
Expected: PASS (all vector-path tests, including the new isolation test).

- [ ] **Step 5: Verify no other caller passes the old 2-arg shape**

Run: `grep -rn "vectorSearchFn" packages apps`
Expected: only `packages/core/src/index.ts` (type + call), `packages/core/src/retrieve-vector.test.ts` (mocks), and `apps/api/src/domain.service.ts` (constructed closure, fixed in Task 2). No other call sites need editing.

- [ ] **Step 6: Run the full core suite + typecheck**

Run: `pnpm --filter @statecore/core test && pnpm --filter @statecore/core exec tsc --noEmit`
Expected: PASS / no type errors.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/index.ts packages/core/src/retrieve-vector.test.ts
git commit -m "$(cat <<'EOF'
fix(core): scope-filter vector retrieval hits to the requested scope

RetrieveService now passes scopeId to vectorSearchFn and drops any fetched
vector event whose scopeId differs — defense-in-depth against a leaky data
layer. Unit-tested with a deliberately cross-scope vector result.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Scope-filter the raw SQL vector query (data layer, unit-tested)

**Files:**
- Create: `apps/api/src/vector-search.ts`
- Create: `apps/api/src/vector-search.test.ts`
- Modify: `apps/api/src/domain.service.ts:243-254`

**Interfaces:**
- Consumes: the `vectorSearchFn` signature from Task 1 — `(queryVector, limit, scopeId) => Promise<string[]>`.
- Produces: `createVectorSearchFn(client: RawQueryClient): (queryVector: number[], limit: number, scopeId: string) => Promise<string[]>` where `RawQueryClient = { $queryRaw: <T = unknown>(query: TemplateStringsArray, ...values: unknown[]) => Promise<T> }`.

- [ ] **Step 1: Write the failing unit test**

Create `apps/api/src/vector-search.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { createVectorSearchFn, type RawQueryClient } from "./vector-search";

describe("createVectorSearchFn — tenant scoping", () => {
  it("scopes the query by scopeId and returns event ids", async () => {
    let capturedSql = "";
    let capturedValues: unknown[] = [];
    const fakeClient: RawQueryClient = {
      $queryRaw: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
        capturedSql = strings.join("?");
        capturedValues = values;
        return Promise.resolve([{ eventId: "e1" }, { eventId: "e2" }]);
      })
    };

    const fn = createVectorSearchFn(fakeClient);
    const result = await fn([0.1, 0.2, 0.3], 10, "scope-123");

    expect(result).toEqual(["e1", "e2"]);
    expect(capturedSql).toContain('"scopeId"');
    expect(capturedSql).toContain('"MemoryEvent"');
    expect(capturedValues).toContain("scope-123");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @statecore/api test -- vector-search`
Expected: FAIL — `./vector-search` module does not exist yet.

- [ ] **Step 3: Implement the helper**

Create `apps/api/src/vector-search.ts`:

```ts
export type RawQueryClient = {
  $queryRaw: <T = unknown>(query: TemplateStringsArray, ...values: unknown[]) => Promise<T>;
};

/**
 * Builds a vector-search closure that is ALWAYS scoped to a single scopeId.
 * The join to "MemoryEvent" plus the scopeId predicate ensures embeddings from
 * other tenants' scopes can never be returned.
 */
export function createVectorSearchFn(client: RawQueryClient) {
  return async (queryVector: number[], limit: number, scopeId: string): Promise<string[]> => {
    const vectorString = `[${queryVector.join(",")}]`;
    const rows = await client.$queryRaw<{ eventId: string }[]>`
      SELECT mee."eventId"
      FROM "MemoryEventEmbedding" mee
      JOIN "MemoryEvent" me ON me.id = mee."eventId"
      WHERE me."scopeId" = ${scopeId}
      ORDER BY mee.embedding <-> ${vectorString}::vector
      LIMIT ${limit}
    `;
    return rows.map((r) => r.eventId);
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @statecore/api test -- vector-search`
Expected: PASS.

- [ ] **Step 5: Wire the helper into domain.service.ts**

In `apps/api/src/domain.service.ts`, add the import near the other local imports:

```ts
import { createVectorSearchFn } from "./vector-search";
```

Replace the inline closure (currently lines ~243-254) so the option reads:

```ts
      vectorSearchFn: apiEnv.retrieveUseVectorSearch && provider?.embedding
        ? createVectorSearchFn(prisma)
        : undefined
```

- [ ] **Step 6: Typecheck + run api suite (unit tests)**

Run: `pnpm --filter @statecore/api exec tsc --noEmit && pnpm --filter @statecore/api test -- vector-search`
Expected: no type errors; vector-search test PASS. (If `tsc` complains that `prisma` is not assignable to `RawQueryClient`, cast at the call site: `createVectorSearchFn(prisma as unknown as RawQueryClient)` and import the type.)

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/vector-search.ts apps/api/src/vector-search.test.ts apps/api/src/domain.service.ts
git commit -m "$(cat <<'EOF'
fix(api): scope vector search SQL to scopeId via MemoryEvent join

Extracts the inline vectorSearchFn closure into createVectorSearchFn and adds
a scopeId predicate (join to MemoryEvent), closing the cross-tenant leak when
RETRIEVE_USE_VECTOR_SEARCH is enabled. Unit-tested for the scope predicate.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Defense-in-depth composite keys in two controller sites

**Files:**
- Modify: `apps/api/src/memory.controller.ts:561-569` (`backfillEmbeddings` raw SQL)
- Modify: `apps/api/src/scopes.controller.ts:63-66` (`setWebhook` update)

**Interfaces:**
- No exported-signature changes. Both endpoints already verify ownership via `getScope(req.userId, …)` before reaching these lines; this task makes the DB operation itself enforce `userId` too.

- [ ] **Step 1: Add the userId predicate to backfillEmbeddings**

In `apps/api/src/memory.controller.ts`, the raw query (currently lines ~561-569) gains a `userId` predicate. `MemoryEvent` carries `userId` directly, so no extra join is needed:

```ts
    const eventsWithoutEmbedding = await prisma.$queryRaw<{ id: string }[]>`
      SELECT me.id
      FROM "MemoryEvent" me
      LEFT JOIN "MemoryEventEmbedding" mee ON me.id = mee."eventId"
      WHERE me."scopeId" = ${input.scopeId}
        AND me."userId" = ${req.userId}
        AND mee."eventId" IS NULL
      ORDER BY me."createdAt" DESC
      LIMIT 1000
    `;
```

- [ ] **Step 2: Make setWebhook update by composite (id, userId)**

In `apps/api/src/scopes.controller.ts`, replace the `prisma.projectScope.update({ where: { id }, … })` block (currently lines ~63-66) with an `updateMany` that includes `userId`, and treat zero rows as not-found:

```ts
    const updated = await prisma.projectScope.updateMany({
      where: { id, userId: req.userId },
      data: { notificationWebhook: input.notificationWebhook }
    });
    if (updated.count === 0) throw new NotFoundException("Scope not found");
```

(`NotFoundException` is already imported in this file — confirm with `grep -n NotFoundException apps/api/src/scopes.controller.ts`; it is used by `setActiveScope` above.)

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @statecore/api exec tsc --noEmit`
Expected: no type errors.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/memory.controller.ts apps/api/src/scopes.controller.ts
git commit -m "$(cat <<'EOF'
fix(api): enforce userId at DB layer for backfill + webhook update

Defense-in-depth: backfillEmbeddings raw SQL and setWebhook update now include
userId in their predicates (updateMany for webhook, with not-found on 0 rows),
so isolation holds at the data layer, not only via the prior ownership check.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Multi-tenant isolation integration regression test (DoR #1 guard)

**Prerequisite (one-time, per `apps/api/src/test/README.md`):** the Postgres test DB must exist and be migrated.

```bash
docker compose -f docker-compose.local.yml up -d postgres
docker exec statecore-postgres-1 psql -U postgres -c "CREATE DATABASE statecore_test"   # ignore error if it already exists
DATABASE_URL="postgresql://postgres:postgres@localhost:5434/statecore_test" \
  pnpm --filter @statecore/db prisma migrate deploy
```

**Files:**
- Create: `apps/api/src/test/multi-tenant-isolation.integration.test.ts`

**Interfaces:**
- Consumes: `createTestApp` from `./setup` and `clearDatabase` from `./helpers` (same harness as `api.integration.test.ts`). Auth is via the `x-user-id` header.

- [ ] **Step 1: Write the failing integration test**

Create `apps/api/src/test/multi-tenant-isolation.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { createTestApp } from "./setup";
import { clearDatabase } from "./helpers";

const USER_A = "user-a";
const USER_B = "user-b";

describe("Multi-tenant isolation", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  }, 30000);

  beforeEach(async () => {
    await clearDatabase();
  });

  afterAll(async () => {
    await app.close();
  });

  async function createScopeAs(user: string, name: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post("/scopes")
      .set("x-user-id", user)
      .send({ name });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  it("user B cannot list user A's scopes", async () => {
    await createScopeAs(USER_A, "a-scope");
    const res = await request(app.getHttpServer()).get("/scopes").set("x-user-id", USER_B);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(0);
  });

  it("user B cannot read user A's memory events", async () => {
    const scopeId = await createScopeAs(USER_A, "a-scope");
    const res = await request(app.getHttpServer())
      .get(`/memory/events?scopeId=${scopeId}`)
      .set("x-user-id", USER_B);
    expect(res.status).toBe(404);
  });

  it("user B cannot retrieve from user A's scope", async () => {
    const scopeId = await createScopeAs(USER_A, "a-scope");
    const res = await request(app.getHttpServer())
      .post("/memory/retrieve")
      .set("x-user-id", USER_B)
      .send({ scopeId, query: "anything", limit: 5 });
    expect(res.status).toBe(404);
  });

  it("user B cannot set a webhook on user A's scope", async () => {
    const scopeId = await createScopeAs(USER_A, "a-scope");
    const res = await request(app.getHttpServer())
      .patch(`/scopes/${scopeId}/webhook`)
      .set("x-user-id", USER_B)
      .send({ notificationWebhook: "https://evil.example.com/hook" });
    expect(res.status).toBe(404);
  });

  it("user B cannot backfill embeddings on user A's scope", async () => {
    const scopeId = await createScopeAs(USER_A, "a-scope");
    const res = await request(app.getHttpServer())
      .post("/memory/embed/backfill")
      .set("x-user-id", USER_B)
      .send({ scopeId });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the test to verify it passes against the provisioned DB**

Run: `pnpm --filter @statecore/api test -- multi-tenant-isolation`
Expected: PASS (all 5 cases). If it fails with `PrismaClientInitializationError`, the test DB is not provisioned — re-run the Prerequisite block.

- [ ] **Step 3: Run the full api suite to confirm nothing regressed**

Run: `pnpm --filter @statecore/api test`
Expected: PASS (existing integration tests + the new isolation file).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/test/multi-tenant-isolation.integration.test.ts
git commit -m "$(cat <<'EOF'
test(api): add multi-tenant isolation regression suite

Cross-user HTTP matrix (list scopes, read events, retrieve, set webhook,
backfill embeddings) asserting user B can never reach user A's scope. This is
the durable guard for the readiness Definition-of-Ready #1.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage (W1 section of `2026-06-21-statecore-core-readiness-design.md`):**
- "Fix `vectorSearchFn` … filter by scopeId/userId" → Task 2 (SQL scope filter) + Task 1 (core defense-in-depth). ✓
- "Defense-in-depth composite keys (backfillEmbeddings, setWebhook)" → Task 3. ✓
- "Regression test … user B reads user A's data and fails" → Task 4. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code. ✓

**Type consistency:** `vectorSearchFn` is `(queryVector: number[], limit: number, scopeId: string) => Promise<string[]>` in Task 1 (definition), Task 2 (`createVectorSearchFn` return), and the call site — consistent. `RawQueryClient` defined and reused in Task 2 test + impl. ✓

---

### Task 5: Real pgvector scope-isolation regression test (closes final-review issue #1)

The final whole-branch review found that the vector-search fix is proven by unit/mock tests only — the HTTP integration suite never exercises the real pgvector path because vector search is disabled in the test env. This task proves the actual SQL scope predicate against a real pgvector DB by calling `createVectorSearchFn(prisma)` directly with seeded cross-scope embeddings, and fixes the related `clearDatabase` gap (minor #3).

**Prerequisite:** same provisioned Postgres test DB as Task 4 (`statecore_test`, already migrated — the pgvector migration `20260615020000_pgvector_embeddings` creates the `vector(1536)` `embedding` column and the `vector` extension).

**Files:**
- Modify: `apps/api/src/test/helpers.ts` (clear `MemoryEventEmbedding`)
- Create: `apps/api/src/vector-search.integration.test.ts`

**Interfaces:**
- Consumes: `createVectorSearchFn(prisma)` from `./vector-search` (Task 2) — `(queryVector: number[], limit: number, scopeId: string) => Promise<string[]>`; `clearDatabase` from `./test/helpers`; `prisma` from `@statecore/db`.

- [ ] **Step 1: Clear embeddings in `clearDatabase`**

In `apps/api/src/test/helpers.ts`, add a `MemoryEventEmbedding` clear as the FIRST statement in `clearDatabase` (before `memoryEvent.deleteMany`), so seeded embeddings are removed deterministically rather than only via FK cascade:

```ts
export async function clearDatabase() {
  await prisma.memoryEventEmbedding.deleteMany();
  await prisma.reminder.deleteMany();
  await prisma.workingMemorySnapshot.deleteMany();
  await prisma.digestStateSnapshot.deleteMany();
  await prisma.digest.deleteMany();
  await prisma.memoryEvent.deleteMany();
  await prisma.userState.deleteMany();
  await prisma.projectScope.deleteMany();
  await prisma.user.deleteMany();
}
```

- [ ] **Step 2: Write the real-DB isolation test**

Create `apps/api/src/vector-search.integration.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "@statecore/db";
import { createVectorSearchFn } from "./vector-search";
import { clearDatabase } from "./test/helpers";

// A 1536-dim vector with one "hot" dimension, so L2 distance is controlled by `hot`.
function vecLiteral(hot: number): string {
  const arr = new Array(1536).fill(0);
  arr[0] = hot;
  return `[${arr.join(",")}]`;
}
function queryVector(hot: number): number[] {
  const arr = new Array(1536).fill(0);
  arr[0] = hot;
  return arr;
}

async function seedScopeWithEmbedding(opts: {
  identity: string;
  scopeName: string;
  content: string;
  hot: number;
}): Promise<{ scopeId: string; eventId: string }> {
  const user = await prisma.user.create({ data: { identity: opts.identity } });
  const scope = await prisma.projectScope.create({ data: { userId: user.id, name: opts.scopeName } });
  const event = await prisma.memoryEvent.create({
    data: { userId: user.id, scopeId: scope.id, type: "stream", source: "api", content: opts.content }
  });
  await prisma.$executeRaw`
    INSERT INTO "MemoryEventEmbedding" ("eventId", "embedding", "model")
    VALUES (${event.id}, ${vecLiteral(opts.hot)}::vector, 'test-model')
  `;
  return { scopeId: scope.id, eventId: event.id };
}

describe("createVectorSearchFn — real pgvector tenant isolation", () => {
  beforeEach(async () => {
    await clearDatabase();
  });
  afterAll(async () => {
    await clearDatabase();
  });

  it("never returns another scope's event, even when it is the nearest neighbor", async () => {
    // Scope A's event is far from the query; Scope B's event sits exactly on the
    // query vector (distance 0) — so without scope filtering B would rank first.
    const a = await seedScopeWithEmbedding({ identity: "user-a", scopeName: "a", content: "alpha", hot: 1 });
    const b = await seedScopeWithEmbedding({ identity: "user-b", scopeName: "b", content: "beta", hot: 10 });

    const fn = createVectorSearchFn(prisma);
    const query = queryVector(10); // identical to B's embedding → B is the nearest neighbor

    const idsForA = await fn(query, 10, a.scopeId);
    expect(idsForA).toContain(a.eventId);
    expect(idsForA).not.toContain(b.eventId); // isolation holds despite B being nearest

    const idsForB = await fn(query, 10, b.scopeId);
    expect(idsForB).toContain(b.eventId);
    expect(idsForB).not.toContain(a.eventId);
  });
});
```

- [ ] **Step 3: Run the test and confirm it passes against the fixed code**

Run: `pnpm --filter @statecore/api test -- vector-search.integration`
Expected: PASS (1 test). If it fails with `PrismaClientInitializationError`, provision the test DB (see Task 4 Prerequisite).

- [ ] **Step 4: Prove the test is non-vacuous (would catch a regression)**

Temporarily delete the line `WHERE me."scopeId" = ${scopeId}` from `apps/api/src/vector-search.ts`, re-run `pnpm --filter @statecore/api test -- vector-search.integration`, and confirm it now FAILS (`b.eventId` leaks into `idsForA`). Then restore the line exactly and re-run to confirm PASS again. Record both outputs in the report as RED/GREEN evidence. Do NOT commit the temporary deletion.

- [ ] **Step 5: Run the full api suite**

Run: `pnpm --filter @statecore/api test`
Expected: PASS (no regressions; `fileParallelism: false` is already in place).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/test/helpers.ts apps/api/src/vector-search.integration.test.ts
git commit -m "$(cat <<'EOF'
test(api): prove pgvector scope isolation against a real DB

Calls createVectorSearchFn(prisma) directly with two seeded scopes whose
embeddings are crafted so the other tenant's event is the nearest neighbor,
and asserts it is still excluded — closing the final-review gap where vector
isolation was guarded only by mocks. Also clears MemoryEventEmbedding in
clearDatabase for deterministic teardown.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```
