# StateCore Production Readiness Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four gaps between current state and production-grade reliability: concurrency correctness, CI/CD, observability, and LLM robustness.

**Architecture:** Four independent phases — each ships working software on its own. Phase 1 is the only blocker for production; Phases 2–4 improve operational safety and quality. Execute phases in order, but individual tasks within a phase can be parallelized.

**Tech Stack:** NestJS (API), BullMQ + Redis (job queue), Prisma + PostgreSQL (DB), Vitest (tests), GitHub Actions (CI), Docker Compose (deployment), TypeScript throughout.

---

## Scope Check

This plan covers four independent subsystems. They can be executed in parallel by different engineers:

| Phase | Subsystem | Blocks prod? |
|-------|-----------|-------------|
| 1 | Concurrency & Data Correctness | **YES** |
| 2 | CI/CD & Deployment | YES (for any team workflow) |
| 3 | Observability & Health | NO but required for ops |
| 4 | LLM Robustness & Accuracy | NO but required for quality claims |

---

## File Map

**Phase 1 — new files:**
- `apps/worker/src/digest-lock.ts` — per-scope digest mutex using Redis SETNX
- `packages/core/src/digest-state-serialization.test.ts` — DB round-trip tests for DigestState JSON

**Phase 1 — modified files:**
- `apps/worker/src/main.ts:225-238` — add event windowing for first-run scopes
- `apps/worker/src/env.ts` — add `DIGEST_FIRST_RUN_MAX_EVENTS` env var

**Phase 2 — new files:**
- `.github/workflows/ci.yml` — GitHub Actions CI pipeline
- `apps/api/src/health.controller.ts` — extend existing health endpoint with digest status

**Phase 3 — new files:**
- `apps/api/src/metrics.controller.ts` — per-scope digest metrics endpoint
- `packages/db/prisma/migrations/20260615000000_digest_job_log/migration.sql`

**Phase 3 — modified files:**
- `packages/db/prisma/schema.prisma` — add `DigestJobLog` model
- `apps/worker/src/main.ts:455-473` — log job outcome to DigestJobLog

**Phase 4 — new files:**
- `packages/core/src/extract-kind.accuracy.test.ts` — extractKind classification accuracy test
- `apps/api/test/multi-user-isolation.test.ts` — integration test: two users cannot read each other's scopes

---

## Phase 1: Concurrency & Data Correctness

**Why first:** Two bugs can corrupt production data today.

**Bug A:** `digestConcurrency > 1` in env allows two digest jobs for the **same scope** to run in parallel. Both read the same `lastState`, both write a new snapshot. Second write silently discards first's state changes.

**Bug B:** When a scope has no prior digest, `recentStreamEvents` fetches with **no `take` limit**. A scope with 50,000 events sends all of them to the LLM context.

---

### Task 1: Per-scope digest lock

**Files:**
- Create: `apps/worker/src/digest-lock.ts`
- Modify: `apps/worker/src/main.ts:204-322` (wrap `runDigestScopeJob`)

- [ ] **Step 1: Write failing test**

Create `apps/worker/src/digest-lock.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { withDigestLock } from "./digest-lock";

describe("withDigestLock", () => {
  it("runs the job when lock is acquired", async () => {
    const redis = {
      set: vi.fn().mockResolvedValue("OK"),
      del: vi.fn().mockResolvedValue(1)
    } as any;

    const result = await withDigestLock(redis, "scope-1", async () => "done");
    expect(result).toBe("done");
    expect(redis.set).toHaveBeenCalledWith(
      "digest-lock:scope-1",
      expect.any(String),
      "EX",
      300,
      "NX"
    );
    expect(redis.del).toHaveBeenCalledWith("digest-lock:scope-1");
  });

  it("throws DigestAlreadyRunningError when lock is taken", async () => {
    const redis = {
      set: vi.fn().mockResolvedValue(null), // NX returns null when key exists
      del: vi.fn()
    } as any;

    await expect(
      withDigestLock(redis, "scope-1", async () => "done")
    ).rejects.toThrow("DigestAlreadyRunning");
    expect(redis.del).not.toHaveBeenCalled();
  });

  it("releases lock even when job throws", async () => {
    const redis = {
      set: vi.fn().mockResolvedValue("OK"),
      del: vi.fn().mockResolvedValue(1)
    } as any;

    await expect(
      withDigestLock(redis, "scope-1", async () => { throw new Error("job failed"); })
    ).rejects.toThrow("job failed");
    expect(redis.del).toHaveBeenCalledWith("digest-lock:scope-1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
cd C:\StateCore\StateCore
pnpm --filter @statecore/worker test
```
Expected: FAIL — `withDigestLock` not found.

- [ ] **Step 3: Implement the lock**

Create `apps/worker/src/digest-lock.ts`:

```typescript
import { randomUUID } from "crypto";

export class DigestAlreadyRunningError extends Error {
  constructor(scopeId: string) {
    super(`DigestAlreadyRunning:${scopeId}`);
    this.name = "DigestAlreadyRunningError";
  }
}

export async function withDigestLock<T>(
  redis: { set: (key: string, val: string, ex: string, ttl: number, nx: string) => Promise<string | null>; del: (key: string) => Promise<number> },
  scopeId: string,
  fn: () => Promise<T>,
  ttlSeconds = 300
): Promise<T> {
  const key = `digest-lock:${scopeId}`;
  const token = randomUUID();
  const acquired = await redis.set(key, token, "EX", ttlSeconds, "NX");
  if (!acquired) {
    throw new DigestAlreadyRunningError(scopeId);
  }
  try {
    return await fn();
  } finally {
    await redis.del(key);
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

```
pnpm --filter @statecore/worker test
```
Expected: PASS

- [ ] **Step 5: Wire lock into worker**

In `apps/worker/src/main.ts`, import and create a Redis client for locking, then wrap `runDigestScopeJob` call:

```typescript
// Add near top of file, after imports:
import { withDigestLock, DigestAlreadyRunningError } from "./digest-lock";
import { createClient } from "redis";

const lockRedis = createClient({ url: workerEnv.redisUrl });
await lockRedis.connect();
```

In the `digest` Worker callback (around line 458), replace:

```typescript
if (job.name === "digest_scope") {
  await runDigestScopeJob(job.data as { userId: string; scopeId: string });
  return { ok: true };
}
```

with:

```typescript
if (job.name === "digest_scope") {
  const data = job.data as { userId: string; scopeId: string };
  try {
    await withDigestLock(lockRedis as any, data.scopeId, () => runDigestScopeJob(data));
  } catch (err) {
    if (err instanceof DigestAlreadyRunningError) {
      logger.info({ scopeId: data.scopeId }, "Digest already running for scope — skipping");
      return { ok: true, skipped: true };
    }
    throw err;
  }
  return { ok: true };
}
```

- [ ] **Step 6: Run all tests**

```
pnpm --filter @statecore/core test && pnpm --filter @statecore/worker test
```
Expected: all pass

- [ ] **Step 7: Commit**

```bash
git add apps/worker/src/digest-lock.ts apps/worker/src/digest-lock.test.ts apps/worker/src/main.ts
git commit -m "fix(worker): per-scope digest lock prevents parallel state corruption"
```

---

### Task 2: First-run event windowing + DB serialization round-trip tests

**Files:**
- Modify: `apps/worker/src/main.ts:225-238`
- Modify: `apps/worker/src/env.ts`
- Create: `packages/core/src/digest-state-serialization.test.ts`

**Context:** When `lastDigestRow` is null (first run), the stream event query has no `take` limit. A scope with thousands of events would fetch all of them.

- [ ] **Step 1: Add env var**

In `apps/worker/src/env.ts`, find where `maxRecentEvents` is defined and add alongside it:

```typescript
digestFirstRunMaxEvents: number(env.DIGEST_FIRST_RUN_MAX_EVENTS ?? "200"),
```

- [ ] **Step 2: Fix first-run windowing**

In `apps/worker/src/main.ts`, replace the stream event query (around line 226):

```typescript
const streamEventQuery = {
  where: { scopeId: data.scopeId, createdAt: { gte: since }, type: "stream" as const },
  orderBy: [{ createdAt: "desc" as const }, { id: "desc" as const }],
  ...(lastDigestRow ? { take: workerEnv.maxRecentEvents } : {})
};
```

with:

```typescript
const streamEventQuery = {
  where: { scopeId: data.scopeId, createdAt: { gte: since }, type: "stream" as const },
  orderBy: [{ createdAt: "desc" as const }, { id: "desc" as const }],
  take: lastDigestRow ? workerEnv.maxRecentEvents : workerEnv.digestFirstRunMaxEvents
};
```

- [ ] **Step 3: Write DB serialization round-trip tests**

Create `packages/core/src/digest-state-serialization.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { normalizeDigestState, type DigestState } from "./digest-control";

// Simulates the Prisma JSON → unknown → DigestState cast that happens in the worker.
// If normalizeDigestState doesn't handle any of these shapes, prod data can corrupt state.
function simulateDbRoundTrip(state: DigestState): DigestState {
  const json = JSON.parse(JSON.stringify(state)) as unknown;
  return normalizeDigestState(json as DigestState);
}

describe("DigestState DB serialization round-trip", () => {
  it("survives a full-state round-trip without data loss", () => {
    const state: DigestState = {
      stableFacts: {
        goal: "ship beta runtime",
        constraints: ["self-hosted first", "keep api stable"],
        decisions: ["use postgres", "use ONNX for inference"]
      },
      workingNotes: {
        openQuestions: ["should we support ollama first?"],
        risks: ["blocked by provider setup"],
        context: "actively optimizing digest latency"
      },
      todos: ["ship runtime docs", "add p95 benchmark"],
      volatileContext: ["queue is stable now"],
      evidenceRefs: [
        { id: "evt-1", sourceType: "event", kind: "decision" },
        { id: "doc-1", sourceType: "document", key: "doc:plan" }
      ],
      provenance: {
        goal: [{ id: "doc-1", sourceType: "document", key: "doc:plan" }],
        decisions: [
          { value: "use postgres", refs: [{ id: "evt-1", sourceType: "event", kind: "decision" }] }
        ]
      },
      confidence: {
        goal: 1,
        decisions: [{ value: "use postgres", score: 0.7 }]
      },
      recentChanges: [
        { field: "decisions", action: "add", value: "use postgres", evidence: { id: "evt-1", sourceType: "event", kind: "decision" } }
      ],
      transitionSummary: { "decisions:add": 1 },
      factRegistry: [
        {
          id: "fact-1",
          content: "use ONNX for inference",
          type: "decision",
          confidence: 0.9,
          addedAt: "2026-01-01T00:00:00.000Z",
          evidenceId: "evt-onnx",
          evidenceType: "event"
        }
      ]
    };

    const result = simulateDbRoundTrip(state);

    expect(result.stableFacts.goal).toBe("ship beta runtime");
    expect(result.stableFacts.constraints).toEqual(["self-hosted first", "keep api stable"]);
    expect(result.stableFacts.decisions).toEqual(["use postgres", "use ONNX for inference"]);
    expect(result.workingNotes.openQuestions).toEqual(["should we support ollama first?"]);
    expect(result.workingNotes.risks).toEqual(["blocked by provider setup"]);
    expect(result.todos).toEqual(["ship runtime docs", "add p95 benchmark"]);
    expect(result.volatileContext).toEqual(["queue is stable now"]);
    expect(result.evidenceRefs).toHaveLength(2);
    expect(result.provenance?.decisions?.[0].value).toBe("use postgres");
    expect(result.confidence?.goal).toBe(1);
    expect(result.recentChanges).toHaveLength(1);
    expect(result.transitionSummary?.["decisions:add"]).toBe(1);
    expect(result.factRegistry).toHaveLength(1);
    expect(result.factRegistry![0].id).toBe("fact-1");
  });

  it("survives null/undefined fields gracefully after DB round-trip", () => {
    const minimal = { stableFacts: { decisions: [] }, workingNotes: {}, todos: [] };
    const result = simulateDbRoundTrip(minimal as DigestState);
    expect(result.stableFacts.decisions).toEqual([]);
    expect(result.todos).toEqual([]);
    expect(result.volatileContext).toEqual([]);
    expect(result.factRegistry).toEqual([]);
    expect(result.evidenceRefs).toEqual([]);
  });

  it("survives arrays stored as JSON arrays (Prisma Json type behaviour)", () => {
    // Prisma stores Json as plain JS objects after parse — arrays stay arrays, but
    // if a field was accidentally stored as a string, we want a clear failure, not silent corruption.
    const withArrays: DigestState = {
      stableFacts: { decisions: ["d1", "d2"], constraints: ["c1"] },
      workingNotes: { openQuestions: ["q1"], risks: ["r1"] },
      todos: ["t1"],
      volatileContext: ["v1"],
      evidenceRefs: []
    };
    const result = simulateDbRoundTrip(withArrays);
    expect(Array.isArray(result.stableFacts.decisions)).toBe(true);
    expect(Array.isArray(result.stableFacts.constraints)).toBe(true);
    expect(Array.isArray(result.workingNotes.openQuestions)).toBe(true);
    expect(Array.isArray(result.todos)).toBe(true);
    expect(Array.isArray(result.volatileContext)).toBe(true);
  });

  it("does not lose factRegistry entries with supersededBy during round-trip", () => {
    const state: DigestState = {
      stableFacts: { decisions: ["use TensorRT"] },
      workingNotes: {},
      todos: [],
      factRegistry: [
        {
          id: "fact-old",
          content: "use ONNX",
          type: "decision",
          confidence: 0.9,
          addedAt: "2026-01-01T00:00:00.000Z",
          evidenceId: "e1",
          evidenceType: "event",
          supersededBy: "fact-new"
        },
        {
          id: "fact-new",
          content: "use TensorRT",
          type: "decision",
          confidence: 0.9,
          addedAt: "2026-01-02T00:00:00.000Z",
          evidenceId: "e2",
          evidenceType: "event"
        }
      ]
    };
    // normalizeDigestState filters superseded entries — only fact-new survives
    const result = simulateDbRoundTrip(state);
    expect(result.factRegistry).toHaveLength(1);
    expect(result.factRegistry![0].id).toBe("fact-new");
  });
});
```

- [ ] **Step 4: Run tests to verify they pass**

```
pnpm --filter @statecore/core test
```
Expected: PASS (normalizeDigestState already handles these shapes)

If any test fails, fix `normalizeDigestState` to handle the failing shape, then re-run.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/main.ts apps/worker/src/env.ts packages/core/src/digest-state-serialization.test.ts
git commit -m "fix(worker): cap first-run event fetch; add DigestState DB round-trip tests"
```

---

## Phase 2: CI/CD Pipeline

**Why:** Without CI, every push can silently break tests. All 108 tests pass locally today — they need to pass on every PR.

---

### Task 3: GitHub Actions CI

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Create workflow file**

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    name: Test
    runs-on: ubuntu-latest

    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: statecore
          POSTGRES_PASSWORD: statecore
          POSTGRES_DB: statecore_test
        ports:
          - 5432:5432
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

      redis:
        image: redis:7-alpine
        ports:
          - 6379:6379
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

    env:
      DATABASE_URL: postgresql://statecore:statecore@localhost:5432/statecore_test
      REDIS_URL: redis://localhost:6379

    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 9

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Run database migrations
        run: pnpm --filter @statecore/db exec prisma migrate deploy

      - name: Run unit tests
        run: pnpm --filter @statecore/core test

      - name: Run API tests
        run: pnpm --filter @statecore/api test

      - name: Type check
        run: pnpm --filter @statecore/core exec tsc --noEmit
```

- [ ] **Step 2: Verify CI passes locally by running what CI will run**

```
pnpm --filter @statecore/core test
pnpm --filter @statecore/api test
```
Expected: all pass. Fix any failures before pushing.

- [ ] **Step 3: Commit and push**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add GitHub Actions workflow for unit and API tests"
git push
```

Go to `https://github.com/<your-repo>/actions` and verify the workflow runs green.

---

## Phase 3: Observability

**Why:** In production you need to know: is the digest worker running? When did the last digest for scope X complete? How many have failed?

---

### Task 4: DigestJobLog table + metrics endpoint

**Files:**
- Create: `packages/db/prisma/migrations/20260615000000_digest_job_log/migration.sql`
- Modify: `packages/db/prisma/schema.prisma`
- Modify: `apps/worker/src/main.ts` — log job outcomes
- Create: `apps/api/src/metrics.controller.ts`
- Modify: `apps/api/src/app.module.ts` — register MetricsController

- [ ] **Step 1: Write failing test for metrics endpoint**

Create `apps/api/src/metrics.controller.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

// Minimal test: metrics returns per-scope digest stats
describe("GET /metrics/digest/:scopeId", () => {
  it("returns total, failed, and lastRunAt fields", async () => {
    const mockPrisma = {
      digestJobLog: {
        aggregate: vi.fn().mockResolvedValue({ _count: { _all: 10 } }),
        count: vi.fn().mockResolvedValue(2),
        findFirst: vi.fn().mockResolvedValue({ completedAt: new Date("2026-06-15T00:00:00Z"), durationMs: 3200 })
      }
    };

    const { MetricsService } = await import("./metrics.service");
    const service = new MetricsService(mockPrisma as any);
    const result = await service.getDigestMetrics("scope-1");

    expect(result.total).toBe(10);
    expect(result.failed).toBe(2);
    expect(result.lastRunAt).toBe("2026-06-15T00:00:00.000Z");
    expect(result.lastDurationMs).toBe(3200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
pnpm --filter @statecore/api test
```
Expected: FAIL — `MetricsService` not found.

- [ ] **Step 3: Add Prisma migration**

Create `packages/db/prisma/migrations/20260615000000_digest_job_log/migration.sql`:

```sql
CREATE TABLE "DigestJobLog" (
    "id"         TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "scopeId"    TEXT NOT NULL,
    "jobId"      TEXT,
    "status"     TEXT NOT NULL,
    "durationMs" INTEGER,
    "error"      TEXT,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DigestJobLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DigestJobLog_scopeId_completedAt_idx" ON "DigestJobLog"("scopeId", "completedAt");
CREATE INDEX "DigestJobLog_status_idx" ON "DigestJobLog"("status");
```

- [ ] **Step 4: Add model to schema.prisma**

In `packages/db/prisma/schema.prisma`, add after the `Reminder` model:

```prisma
model DigestJobLog {
  id          String   @id @default(uuid())
  scopeId     String
  jobId       String?
  status      String
  durationMs  Int?
  error       String?
  completedAt DateTime @default(now())

  @@index([scopeId, completedAt])
  @@index([status])
}
```

Then run:
```
pnpm --filter @statecore/db exec prisma migrate dev --name digest_job_log
pnpm --filter @statecore/db exec prisma generate
```

- [ ] **Step 5: Create MetricsService**

Create `apps/api/src/metrics.service.ts`:

```typescript
import { Injectable } from "@nestjs/common";
import { prisma } from "@statecore/db";

@Injectable()
export class MetricsService {
  constructor(private readonly db: typeof prisma = prisma) {}

  async getDigestMetrics(scopeId: string) {
    const [total, failed, last] = await Promise.all([
      this.db.digestJobLog.count({ where: { scopeId } }),
      this.db.digestJobLog.count({ where: { scopeId, status: "failed" } }),
      this.db.digestJobLog.findFirst({
        where: { scopeId },
        orderBy: { completedAt: "desc" }
      })
    ]);

    return {
      total,
      failed,
      successRate: total === 0 ? null : ((total - failed) / total),
      lastRunAt: last?.completedAt.toISOString() ?? null,
      lastDurationMs: last?.durationMs ?? null,
      lastStatus: last?.status ?? null
    };
  }
}
```

Create `apps/api/src/metrics.controller.ts`:

```typescript
import { Controller, Get, Param, Headers, UnauthorizedException } from "@nestjs/common";
import { MetricsService } from "./metrics.service";

@Controller()
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get("metrics/digest/:scopeId")
  async getDigestMetrics(
    @Param("scopeId") scopeId: string,
    @Headers("x-user-id") userId: string
  ) {
    if (!userId) throw new UnauthorizedException();
    return this.metrics.getDigestMetrics(scopeId);
  }
}
```

Register in `apps/api/src/app.module.ts` — add `MetricsController` and `MetricsService` to the module's `controllers` and `providers` arrays.

- [ ] **Step 6: Log job outcomes in worker**

In `apps/worker/src/main.ts`, update the `digest` Worker's `.on("completed")` and `.on("failed")` handlers:

```typescript
new Worker(
  "digest",
  async (job) => {
    const t0 = Date.now();
    if (job.name === "digest_scope") {
      const data = job.data as { userId: string; scopeId: string };
      try {
        await withDigestLock(lockRedis as any, data.scopeId, () => runDigestScopeJob(data));
        await prisma.digestJobLog.create({
          data: { scopeId: data.scopeId, jobId: job.id, status: "success", durationMs: Date.now() - t0 }
        });
        return { ok: true };
      } catch (err) {
        if (err instanceof DigestAlreadyRunningError) {
          logger.info({ scopeId: data.scopeId }, "Digest already running for scope — skipping");
          return { ok: true, skipped: true };
        }
        await prisma.digestJobLog.create({
          data: {
            scopeId: data.scopeId,
            jobId: job.id,
            status: "failed",
            durationMs: Date.now() - t0,
            error: err instanceof Error ? err.message : String(err)
          }
        });
        throw err;
      }
    }
    // ... rebuild job unchanged
  },
  { connection, concurrency: workerEnv.digestConcurrency }
)
```

- [ ] **Step 7: Run tests**

```
pnpm --filter @statecore/api test
```
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add packages/db/prisma/schema.prisma \
        packages/db/prisma/migrations/20260615000000_digest_job_log/ \
        apps/api/src/metrics.service.ts \
        apps/api/src/metrics.controller.ts \
        apps/api/src/app.module.ts \
        apps/api/src/metrics.controller.test.ts \
        apps/worker/src/main.ts
git commit -m "feat(observability): DigestJobLog table + /metrics/digest/:scopeId endpoint"
```

---

## Phase 4: LLM Robustness & Accuracy

**Why:** `extractKind` classification accuracy has never been measured. Wrong classification → wrong field written to stable state.

---

### Task 5: extractKind accuracy test harness

**Context:** `extractKind` is the heuristic classifier that assigns each stream event a `kind` (decision/constraint/todo/question/status/note/noise). The digest pipeline uses `kind` to decide which stable field to write. We need to measure false-positive rate on real-world-shaped inputs.

**Files:**
- Create: `packages/core/src/extract-kind.accuracy.test.ts`

- [ ] **Step 1: Write accuracy test**

Create `packages/core/src/extract-kind.accuracy.test.ts`:

```typescript
import { describe, it, expect } from "vitest";

// extractKind is not exported — test via protectedStateMerge routing behaviour.
// We verify that each class of input ends up in the correct stable field.
import { protectedStateMerge } from "./digest-control";
import type { MemoryEvent } from "./index";

function mkDelta(id: string, content: string) {
  const event: MemoryEvent = {
    id, scopeId: "sc", userId: "u", type: "stream",
    source: "api", content, createdAt: new Date()
  };
  // Use high noveltyScore so nothing is filtered
  return { eventId: id, reason: "novel_event" as const, features: { kind: "note" as const, importanceScore: 0.6, noveltyScore: 0.9 }, event };
}

describe("extractKind routing accuracy", () => {
  const decisionInputs = [
    "We decide to use Postgres for persistence",
    "We will ship CLI first before the API",
    "Agreed: keep the assistant runtime as a product boundary",
    "Decision: no GPU required for V1 inference",
    "We approved the migration to UUIDv7"
  ];

  it.each(decisionInputs)("routes decision input to stableFacts.decisions: %s", (content) => {
    const merged = protectedStateMerge({
      prevState: null,
      documents: [],
      deltaCandidates: [mkDelta("d1", content)]
    });
    expect(merged.stableFacts.decisions).toContain(content);
    expect(merged.stableFacts.constraints).toHaveLength(0);
  });

  const constraintInputs = [
    "constraint: no paid third-party APIs in V1",
    "We cannot use cloud storage in the first release",
    "Limitation: must support arm64",
    "Must not store user PII outside the local machine"
  ];

  it.each(constraintInputs)("routes constraint input to stableFacts.constraints: %s", (content) => {
    const merged = protectedStateMerge({
      prevState: null,
      documents: [],
      deltaCandidates: [mkDelta("c1", content)]
    });
    // normalizeConstraintFactText strips "constraint:" prefix
    const stored = merged.stableFacts.constraints;
    expect(stored.length).toBeGreaterThan(0);
  });

  const noiseInputs = [
    "ok",
    "thanks",
    "noted",
    "Assistant reply: We decided to keep postgres.",
    "What are the current decisions?",
    "What is the state?"
  ];

  it.each(noiseInputs)("does not write noise to any stable field: %s", (content) => {
    const merged = protectedStateMerge({
      prevState: null,
      documents: [],
      deltaCandidates: [mkDelta("n1", content)]
    });
    expect(merged.stableFacts.decisions).toHaveLength(0);
    expect(merged.stableFacts.constraints).toHaveLength(0);
    expect(merged.todos).toHaveLength(0);
  });

  const todoInputs = [
    "TODO: add benchmark assertion for p95 latency",
    "Next step: write queue latency notes",
    "Action item: document the API surface",
    "Follow up: review the digest control logic"
  ];

  it.each(todoInputs)("routes todo input to todos: %s", (content) => {
    const merged = protectedStateMerge({
      prevState: null,
      documents: [],
      deltaCandidates: [mkDelta("t1", content)]
    });
    expect(merged.todos.length).toBeGreaterThan(0);
    expect(merged.stableFacts.decisions).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run and check pass rate**

```
pnpm --filter @statecore/core test -- --reporter=verbose
```

Any failing cases indicate `extractKind` misclassification. For each failure:
1. Identify which regex in `extractKind` (in `digest-control.ts` around line 389) missed the pattern
2. Add the pattern to the correct branch
3. Re-run until all pass

- [ ] **Step 3: Fix any failing classification**

Common fixes needed — add patterns to `extractKind` in `packages/core/src/digest-control.ts`:

```typescript
// Example: "Agreed:" prefix not currently detected as decision
if (/\b(decide|decision|we will|agreed|approved)\b/.test(text)) return "decision";
// Already present — no change needed for "agreed"

// "Must not" should map to constraint
if (/\b(constraint|limitation|cannot|must not)\b/.test(text)) return "constraint";
// Already present

// "Follow up / Follow-up" → todo (already present)
if (/\b(todo|next step|action item|follow up|follow-up)\b/.test(text)) return "todo";
```

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/extract-kind.accuracy.test.ts packages/core/src/digest-control.ts
git commit -m "test(core): extractKind routing accuracy test harness"
```

---

### Task 6: Multi-user isolation integration test

**Context:** The API uses `x-user-id` header auth. We need a test that proves user A's scopes are invisible to user B, even if user B guesses scope IDs.

**Files:**
- Create: `apps/api/test/multi-user-isolation.test.ts`

- [ ] **Step 1: Write failing integration test**

Create `apps/api/test/multi-user-isolation.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const BASE = "http://127.0.0.1:3002";

async function api(path: string, options: { method?: string; userId: string; body?: unknown }) {
  const res = await fetch(`${BASE}${path}`, {
    method: options.method ?? "GET",
    headers: {
      "content-type": "application/json",
      "x-user-id": options.userId
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe("Multi-user isolation", () => {
  let scopeIdA: string;

  beforeAll(async () => {
    // Create a scope as user A
    const res = await api("/scopes", {
      method: "POST",
      userId: "test-user-a",
      body: { name: "User A scope" }
    });
    expect(res.status).toBe(201);
    scopeIdA = res.body.id;
  });

  it("user B cannot read user A scope via GET /scopes", async () => {
    const res = await api("/scopes", { userId: "test-user-b" });
    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ id: string }>).map((s) => s.id);
    expect(ids).not.toContain(scopeIdA);
  });

  it("user B cannot ingest events into user A scope", async () => {
    const res = await api("/memory/events", {
      method: "POST",
      userId: "test-user-b",
      body: {
        scopeId: scopeIdA,
        type: "stream",
        source: "api",
        content: "hostile injection"
      }
    });
    // Should be 403 or 404 — not 201
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("user B cannot retrieve memory from user A scope", async () => {
    const res = await api("/memory/retrieve", {
      method: "POST",
      userId: "test-user-b",
      body: { scopeId: scopeIdA, query: "hostile query", limit: 10 }
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("user B cannot trigger a digest on user A scope", async () => {
    const res = await api("/memory/digest", {
      method: "POST",
      userId: "test-user-b",
      body: { scopeId: scopeIdA }
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
```

- [ ] **Step 2: Run against live API**

Make sure the API is running (`pnpm start` or `docker compose -f docker-compose.local.yml up -d`), then:

```
cd C:\StateCore\StateCore
npx tsx apps/api/test/multi-user-isolation.test.ts
```

Or add to vitest config and run:

```
pnpm --filter @statecore/api test -- multi-user-isolation
```

Expected: All pass — if any fail, the endpoint is missing a user ownership check.

- [ ] **Step 3: Fix any failing isolation checks**

If user B can access user A's scope, find the endpoint in `apps/api/src/memory.controller.ts` or `apps/api/src/domain.service.ts` and add a userId ownership check:

```typescript
// Example fix pattern in domain.service.ts:
const scope = await prisma.projectScope.findFirst({
  where: { id: scopeId, userId }  // <-- userId guard
});
if (!scope) throw new ForbiddenException("Scope not found");
```

Re-run until all isolation tests pass.

- [ ] **Step 4: Commit**

```bash
git add apps/api/test/multi-user-isolation.test.ts
git commit -m "test(api): multi-user isolation integration tests"
```

---

## Self-Review

**Spec coverage check:**

| Gap identified | Task that addresses it |
|---------------|----------------------|
| Parallel digest corruption | Task 1 (per-scope lock) |
| First-run event flooding | Task 2 (windowing fix) |
| DB serialization bugs | Task 2 (round-trip tests) |
| No CI | Task 3 (GitHub Actions) |
| No digest health metrics | Task 4 (DigestJobLog + endpoint) |
| extractKind accuracy unmeasured | Task 5 (accuracy test harness) |
| Multi-user isolation untested | Task 6 (isolation tests) |

**Remaining gaps NOT in this plan** (post-v1 scope):
- LLM prompt regression tests with fixed-seed responses (requires deterministic LLM stub)
- Digest drift metrics dashboard (UI work, separate plan)
- Rate limiting on `/memory/events` ingest (needs NestJS throttler, ~2 day task)
- State snapshot versioning / schema migration safety (depends on Prisma version column)

**Placeholder scan:** No TBDs or "implement later" found. All code blocks are complete.

**Type consistency:** `DigestJobLog`, `MetricsService`, `MetricsController` used consistently. `withDigestLock` signature matches test mock. `simulateDbRoundTrip` uses `normalizeDigestState` which is already exported.
