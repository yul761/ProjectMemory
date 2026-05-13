# Integration Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add HTTP-level integration tests for the StateCore API covering scope management, event ingestion, and fast-view retrieval against a real PostgreSQL test database.

**Architecture:** Use `@nestjs/testing` + `supertest` to boot a real NestJS app in tests. A `vitest.setup.ts` (setupFiles) sets `DATABASE_URL` to the test DB before any modules load, so the Prisma singleton picks up the test connection. Tests truncate all tables in `beforeEach`. Redis is NOT required — the 6 test cases don't trigger queue operations.

**Tech Stack:** `@nestjs/testing`, `supertest`, `vitest`, PostgreSQL test DB (`statecore_test`).

---

## File Map

| File | Change |
|------|--------|
| `apps/api/package.json` | Add `supertest`, `@nestjs/testing`, `@types/supertest` |
| `apps/api/vitest.config.ts` | Create — configure setupFiles |
| `apps/api/src/test/vitest.setup.ts` | Create — set DATABASE_URL to test DB before modules load |
| `apps/api/src/test/setup.ts` | Create — createTestApp() factory |
| `apps/api/src/test/helpers.ts` | Create — clearDatabase() utility |
| `apps/api/src/test/api.integration.test.ts` | Create — 6 integration tests |
| `.env.example` | Modify — add DATABASE_URL_TEST |

---

## Task 1: Test Infrastructure Setup

**Files:**
- Modify: `apps/api/package.json`
- Create: `apps/api/vitest.config.ts`
- Create: `apps/api/src/test/vitest.setup.ts`
- Create: `apps/api/src/test/setup.ts`
- Create: `apps/api/src/test/helpers.ts`
- Modify: `.env.example`

- [ ] **Step 1: Add dependencies**

```bash
cd apps/api && pnpm add -D @nestjs/testing supertest @types/supertest
```

- [ ] **Step 2: Create the test database**

Run from repo root (requires Docker Postgres running):
```bash
docker exec -it $(docker ps -q -f name=postgres) psql -U postgres -c "CREATE DATABASE statecore_test;"
```

If that fails, use this alternative:
```bash
docker compose exec postgres psql -U postgres -c "CREATE DATABASE statecore_test;"
```

Expected: `CREATE DATABASE`

- [ ] **Step 3: Run migrations against test DB**

Use `db:deploy` (not `db:migrate`) — non-interactive, applies existing migrations only:
```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5433/statecore_test pnpm db:deploy
```

Expected: migrations applied, no errors.

- [ ] **Step 4: Add DATABASE_URL_TEST to .env.example**

Open `.env.example`. After the `DATABASE_URL=...` line, add:
```
DATABASE_URL_TEST=postgresql://postgres:postgres@localhost:5433/statecore_test
```

Also add it to your local `.env` file.

- [ ] **Step 5: Create vitest.config.ts**

Create `apps/api/vitest.config.ts`:

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./src/test/vitest.setup.ts"]
  }
});
```

- [ ] **Step 6: Create vitest.setup.ts**

Create `apps/api/src/test/vitest.setup.ts`:

```typescript
// Must run before any module imports — overrides DATABASE_URL for test DB.
// apps/api/src/env.ts skips keys already set (line 15: "if process.env[key] !== undefined, continue")
// so setting here before env.ts loads ensures the test DB URL is used.
const testUrl = process.env["DATABASE_URL_TEST"] ?? "postgresql://postgres:postgres@localhost:5433/statecore_test";
process.env["DATABASE_URL"] = testUrl;
```

- [ ] **Step 7: Create setup.ts**

Create `apps/api/src/test/setup.ts`:

```typescript
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { AppModule } from "../app.module";
import { GlobalErrorFilter } from "../error.filter";

export async function createTestApp(): Promise<INestApplication> {
  const module = await Test.createTestingModule({
    imports: [AppModule]
  }).compile();

  const app = module.createNestApplication();
  app.useGlobalFilters(new GlobalErrorFilter());
  await app.init();
  return app;
}
```

- [ ] **Step 8: Create helpers.ts**

Create `apps/api/src/test/helpers.ts`:

```typescript
import { prisma } from "@statecore/db";

export async function clearDatabase() {
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

- [ ] **Step 9: Verify unit tests still pass**

```bash
cd apps/api && pnpm test
```
Expected: 4 filter tests pass (integration test file doesn't exist yet, so no DB connection needed).

- [ ] **Step 10: Commit**

```bash
git add apps/api/package.json apps/api/vitest.config.ts apps/api/src/test/vitest.setup.ts apps/api/src/test/setup.ts apps/api/src/test/helpers.ts .env.example pnpm-lock.yaml
git commit -m "feat(api): add integration test infrastructure"
```

---

## Task 2: Integration Tests

**Files:**
- Create: `apps/api/src/test/api.integration.test.ts`

**Prerequisite:** Docker must be running with `docker compose up -d` (Postgres only; Redis not needed for these tests).

- [ ] **Step 1: Write the test file**

Create `apps/api/src/test/api.integration.test.ts`:

```typescript
import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { createTestApp } from "./setup";
import { clearDatabase } from "./helpers";

const TEST_USER = "test-user";

describe("API Integration Tests", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  beforeEach(async () => {
    await clearDatabase();
  });

  afterAll(async () => {
    await app.close();
  });

  describe("Scope management", () => {
    it("POST /scopes creates a scope and returns it", async () => {
      const res = await request(app.getHttpServer())
        .post("/scopes")
        .set("x-user-id", TEST_USER)
        .send({ name: "test-scope" });

      expect(res.status).toBe(200);
      expect(res.body.name).toBe("test-scope");
      expect(typeof res.body.id).toBe("string");
    });

    it("GET /scopes returns created scopes", async () => {
      await request(app.getHttpServer())
        .post("/scopes")
        .set("x-user-id", TEST_USER)
        .send({ name: "scope-a" });

      const res = await request(app.getHttpServer())
        .get("/scopes")
        .set("x-user-id", TEST_USER);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.items)).toBe(true);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].name).toBe("scope-a");
    });

    it("POST /scopes/:id/active sets the active scope", async () => {
      const createRes = await request(app.getHttpServer())
        .post("/scopes")
        .set("x-user-id", TEST_USER)
        .send({ name: "active-scope" });

      const scopeId = createRes.body.id;

      const res = await request(app.getHttpServer())
        .post(`/scopes/${scopeId}/active`)
        .set("x-user-id", TEST_USER);

      expect(res.status).toBe(200);
      expect(res.body.activeScopeId).toBe(scopeId);
    });
  });

  describe("Memory events", () => {
    it("POST /memory/events ingests a stream event", async () => {
      const scopeRes = await request(app.getHttpServer())
        .post("/scopes")
        .set("x-user-id", TEST_USER)
        .send({ name: "event-scope" });

      const scopeId = scopeRes.body.id;

      const res = await request(app.getHttpServer())
        .post("/memory/events")
        .set("x-user-id", TEST_USER)
        .send({ scopeId, type: "stream", content: "User decided to use TypeScript" });

      expect(res.status).toBe(200);
      expect(res.body.scopeId).toBe(scopeId);
      expect(res.body.type).toBe("stream");
      expect(res.body.content).toBe("User decided to use TypeScript");
      expect(typeof res.body.id).toBe("string");
    });
  });

  describe("Fast view", () => {
    it("GET /memory/fast-view returns context for a scope", async () => {
      const scopeRes = await request(app.getHttpServer())
        .post("/scopes")
        .set("x-user-id", TEST_USER)
        .send({ name: "fastview-scope" });

      const scopeId = scopeRes.body.id;

      const res = await request(app.getHttpServer())
        .get(`/memory/fast-view?scopeId=${scopeId}`)
        .set("x-user-id", TEST_USER);

      expect(res.status).toBe(200);
      expect(res.body.scopeId).toBe(scopeId);
      expect(typeof res.body.fastLayerContext).toBe("string");
    });

    it("GET /memory/fast-view without scopeId returns 400", async () => {
      const res = await request(app.getHttpServer())
        .get("/memory/fast-view")
        .set("x-user-id", TEST_USER);

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "scopeId required" });
    });
  });
});
```

- [ ] **Step 2: Run tests**

```bash
cd apps/api && pnpm test
```
Expected: 4 filter tests + 6 integration tests = **10 tests pass**.

If integration tests fail with connection errors, ensure `docker compose up -d` is running and `DATABASE_URL_TEST` is set in `.env`.

If tests fail with BullMQ/Redis connection errors: the queues connect lazily, but if Redis is completely unavailable, BullMQ may log warnings. This is acceptable — add `REDIS_URL=redis://localhost:6379` to the test env if needed.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/test/api.integration.test.ts
git commit -m "feat(api): add HTTP integration tests for scope, events, and fast-view"
```
