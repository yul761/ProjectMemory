# S2 Statelessness / Multi-Instance Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `apps/api` and `apps/worker` safe to run as multiple replicas by removing the in-process rate limiter, giving `rebuild_digest_chain` the same distributed digest-lock, converting the 3 direct-call `setInterval` schedulers to BullMQ repeatable jobs, bounding the runtime recall caches, and documenting lite-mode as single-instance.

**Architecture:** `apps/worker/src/main.ts` has top-level side effects (creates Workers, opens Redis, starts intervals) so it is NOT unit-testable — the codebase pattern is to extract job logic into small `*-job.ts` modules with their own tests and let `main.ts` only wire them. We follow that: new testable modules (`rebuild-job.ts`, `expire-events.ts`, `BoundedTtlCache`) carry the tests; `main.ts` wiring is verified by review against existing precedents (`digest_scope` already uses `withDigestLock`).

**Tech Stack:** TypeScript, NestJS (api), BullMQ ^5.22 + ioredis (worker), Prisma, vitest.

## Global Constraints

- Test commands: `pnpm --filter @statecore/api test`, `pnpm --filter @statecore/worker test`, `pnpm --filter @statecore/core test`. (Confirm exact package names in each task via `package.json`; worker/api/core all use `vitest run`.)
- **No breaking `/v1` changes.** Rate-limit `429` is NOT in the OpenAPI document or the frozen `__snapshots__/*.snap` (verified: only `embeddingCandidateLimit` matches "...ateLimit"). The api OpenAPI snapshot tests MUST stay byte-identical (green) after removing the limiter.
- Repeatable schedulers MUST be cluster-safe single-fire: use BullMQ `queue.upsertJobScheduler(schedulerId, { every: ms }, { name })` (idempotent by `schedulerId` across replicas) — NOT `setInterval` + time-bucketed jobId (residual double-run risk for non-idempotent jobs).
- The distributed lock helper is `withDigestLock(redis: LockRedis, scopeId: string, fn, ttlSeconds=300)` in `apps/worker/src/digest-lock.ts`; it throws `DigestAlreadyRunningError` when the lock is held. `rebuild_digest_chain` MUST reuse the SAME key (`digest-lock:<scopeId>`) so it is mutually exclusive with `digest_scope`.
- Keep the existing `send_reminders_tick` `setInterval` (lines ~612-617 of worker main.ts) UNCHANGED — it is already cluster-safe.
- Preserve the `if (!llm) return;` no-op guard for `daily_remind` and `detect_emotional_patterns`.

---

### Task 1: Remove the in-process rate limiter (api)

**Files:**
- Modify: `apps/api/src/main.ts` (delete lines ~32-90 rate-limit code + the `app.use(rateLimitMiddleware)` line ~95)
- Modify: `apps/api/src/env.ts` (delete rate-limit env: schema lines 61-64, parsed lines 177-180)
- Modify: `.env.production.example`, `deploy.md` (remove `RATE_LIMIT_*` / `TURN_RATE_LIMIT_*` references)

**Interfaces:**
- Produces: nothing consumed by later tasks (independent).

- [ ] **Step 1: Confirm there is no test asserting 429 / rate-limit behavior**

Run: `grep -rn "429\|rateLimit\|rate.limit\|RATE_LIMIT\|TooMany" apps/api/src --include="*.test.ts" apps/api/src/test`
Expected: no matches in test files (only `main.ts` and `env.ts` reference it). If a test DOES assert 429, delete that test case as part of Step 3 and note it in the report.

- [ ] **Step 2: Capture the current OpenAPI snapshot as the regression guard**

Run: `pnpm --filter @statecore/api test`
Expected: PASS (baseline green, including the snapshot tests). This is the guard — the snapshot must be identical after the change.

- [ ] **Step 3: Delete the rate-limit code from `apps/api/src/main.ts`**

Remove the `RateBucket` type (lines ~32-35), `const rateBuckets = new Map...` (line ~37), `getBucketKey` (~39-41), `consumeRateLimit` (~43-62), and `rateLimitMiddleware` (~64-90). Then remove the registration line inside `bootstrap()`:

```typescript
  app.use(rateLimitMiddleware);
```

In the imports, `NextFunction` is now unused (only `rateLimitMiddleware` used it). Change:

```typescript
import type { Request, Response, NextFunction } from "express";
```
to:
```typescript
import type { Request, Response } from "express";
```
(`Request`/`Response` are still used by the `/docs/scalar.js` handler — keep them.)

- [ ] **Step 4: Delete the rate-limit env from `apps/api/src/env.ts`**

Remove these schema lines (~61-64):
```typescript
  RATE_LIMIT_WINDOW_MS: z.string().optional(),
  RATE_LIMIT_MAX: z.string().optional(),
  TURN_RATE_LIMIT_WINDOW_MS: z.string().optional(),
  TURN_RATE_LIMIT_MAX: z.string().optional(),
```
And these parsed fields (~177-180):
```typescript
  rateLimitWindowMs: Number(env.RATE_LIMIT_WINDOW_MS || 60000),
  rateLimitMax: Number(env.RATE_LIMIT_MAX || 120),
  turnRateLimitWindowMs: Number(env.TURN_RATE_LIMIT_WINDOW_MS || 60000),
  turnRateLimitMax: Number(env.TURN_RATE_LIMIT_MAX || 24)
```
(Watch the trailing comma on the field above `rateLimitWindowMs` — if `turnRateLimitMax` was the last field in the object, remove the now-dangling comma on the preceding line.)

- [ ] **Step 5: Remove doc/example references**

Run: `grep -n "RATE_LIMIT\|TURN_RATE" .env.production.example deploy.md`
Delete the matching lines (env-var rows / any prose describing in-app rate limiting). In `deploy.md`, if there is a sentence about in-process rate limiting, replace it with a one-liner: "Rate limiting is handled by the upstream gateway/reverse proxy, not the API process."

- [ ] **Step 6: Verify build + suite + snapshot unchanged**

Run: `pnpm --filter @statecore/api build && pnpm --filter @statecore/api test`
Expected: PASS, and the OpenAPI snapshot tests are GREEN (byte-identical — no `-u` needed). If a snapshot changed, STOP — the change leaked into the contract; investigate.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/main.ts apps/api/src/env.ts .env.production.example deploy.md
git commit -m "feat(api): remove in-process rate limiter (gateway owns rate limiting)"
```

---

### Task 2: Give rebuild_digest_chain the distributed digest-lock (worker)

**Files:**
- Create: `apps/worker/src/rebuild-job.ts`
- Create: `apps/worker/src/rebuild-job.test.ts`
- Modify: `apps/worker/src/main.ts` (the `rebuild_digest_chain` branch in the `"digest"` Worker, ~lines 501-503)

**Interfaces:**
- Consumes: `withDigestLock`, `DigestAlreadyRunningError`, `LockRedis` from `./digest-lock`.
- Produces: `processRebuildDigestChainJob(lockRedis: LockRedis, data: RebuildData, runRebuild: (data: RebuildData) => Promise<void>, logger: { info: (...a:any[])=>void }, ttlSeconds?: number): Promise<{ ok: true; skipped?: boolean }>` and `type RebuildData = { userId: string; scopeId: string; from?: string; to?: string; strategy?: "full" | "since_last_good"; rebuildGroupId?: string }`.

- [ ] **Step 1: Write the failing test**

Create `apps/worker/src/rebuild-job.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { processRebuildDigestChainJob, type RebuildData } from "./rebuild-job";
import type { LockRedis } from "./digest-lock";

function mockRedis(setResult: "OK" | null) {
  const setFn = vi.fn().mockResolvedValue(setResult);
  const evalFn = vi.fn().mockResolvedValue(1);
  return { mock: { set: setFn as any, eval: evalFn as any } as LockRedis, setFn, evalFn };
}
const logger = { info: vi.fn() };
const data: RebuildData = { userId: "u1", scopeId: "scope-1", strategy: "full" };

describe("processRebuildDigestChainJob", () => {
  it("runs the rebuild under the scope's digest-lock with a 900s TTL", async () => {
    const { mock, setFn } = mockRedis("OK");
    const runRebuild = vi.fn().mockResolvedValue(undefined);
    const result = await processRebuildDigestChainJob(mock, data, runRebuild, logger);
    expect(result).toEqual({ ok: true });
    expect(runRebuild).toHaveBeenCalledWith(data);
    expect(setFn).toHaveBeenCalledWith("digest-lock:scope-1", expect.any(String), "EX", 900, "NX");
  });

  it("skips (does not run rebuild) when the scope lock is already held", async () => {
    const { mock } = mockRedis(null);
    const runRebuild = vi.fn().mockResolvedValue(undefined);
    const result = await processRebuildDigestChainJob(mock, data, runRebuild, logger);
    expect(result).toEqual({ ok: true, skipped: true });
    expect(runRebuild).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @statecore/worker test rebuild-job`
Expected: FAIL — `./rebuild-job` module does not exist yet.

- [ ] **Step 3: Implement `apps/worker/src/rebuild-job.ts`**

```typescript
import { withDigestLock, DigestAlreadyRunningError, type LockRedis } from "./digest-lock";

export type RebuildData = {
  userId: string;
  scopeId: string;
  from?: string;
  to?: string;
  strategy?: "full" | "since_last_good";
  rebuildGroupId?: string;
};

// Rebuilds reuse the SAME digest-lock:<scopeId> key as digest_scope so the two
// can never run concurrently for one scope (both write digest + snapshot rows).
// Rebuilds can be slow, so use a longer TTL than the 300s digest_scope default.
export async function processRebuildDigestChainJob(
  lockRedis: LockRedis,
  data: RebuildData,
  runRebuild: (data: RebuildData) => Promise<void>,
  logger: { info: (...args: any[]) => void },
  ttlSeconds = 900
): Promise<{ ok: true; skipped?: boolean }> {
  try {
    await withDigestLock(lockRedis, data.scopeId, () => runRebuild(data), ttlSeconds);
    return { ok: true };
  } catch (err) {
    if (err instanceof DigestAlreadyRunningError) {
      logger.info({ scopeId: data.scopeId }, "Rebuild skipped — digest/rebuild already running for scope");
      return { ok: true, skipped: true };
    }
    throw err;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @statecore/worker test rebuild-job`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire it into `apps/worker/src/main.ts`**

Add to the imports near the other `./digest-lock` import:
```typescript
import { processRebuildDigestChainJob } from "./rebuild-job";
```
Replace the existing `rebuild_digest_chain` branch (~lines 501-503):
```typescript
    if (job.name === "rebuild_digest_chain") {
      await runRebuildDigestChainJob(job.data as { userId: string; scopeId: string; from?: string; to?: string; strategy?: "full" | "since_last_good"; rebuildGroupId?: string });
      return { ok: true };
    }
```
with:
```typescript
    if (job.name === "rebuild_digest_chain") {
      return processRebuildDigestChainJob(
        lockRedis,
        job.data as { userId: string; scopeId: string; from?: string; to?: string; strategy?: "full" | "since_last_good"; rebuildGroupId?: string },
        runRebuildDigestChainJob,
        logger
      );
    }
```
(`lockRedis`, `runRebuildDigestChainJob`, and `logger` are all already in scope in `main.ts`.)

- [ ] **Step 6: Verify build + full worker suite**

Run: `pnpm --filter @statecore/worker build && pnpm --filter @statecore/worker test`
Expected: PASS (existing tests + 2 new).

- [ ] **Step 7: Commit**

```bash
git add apps/worker/src/rebuild-job.ts apps/worker/src/rebuild-job.test.ts apps/worker/src/main.ts
git commit -m "fix(worker): run rebuild_digest_chain under the scope digest-lock"
```

---

### Task 3: Convert the 3 direct-call setInterval schedulers to BullMQ repeatable jobs (worker)

**Files:**
- Create: `apps/worker/src/expire-events.ts`
- Create: `apps/worker/src/expire-events.test.ts`
- Modify: `apps/worker/src/main.ts` (remove the 3 `setInterval` blocks ~lines 618-643; add a `maintenance` queue + worker + 3 schedulers)

**Interfaces:**
- Consumes: existing `runDailyRemindJob(llm, prisma)` from `./daily-remind`, `runDetectEmotionalPatternsJob(llm, prisma)` from `./detect-patterns`.
- Produces: `runExpireEventsJob(prisma: ExpirePrisma): Promise<{ count: number }>` where `type ExpirePrisma = { memoryEvent: { deleteMany: (args: { where: { expiresAt: { lt: Date } } }) => Promise<{ count: number }> } }`.

- [ ] **Step 1: Write the failing test for `runExpireEventsJob`**

Create `apps/worker/src/expire-events.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { runExpireEventsJob } from "./expire-events";

describe("runExpireEventsJob", () => {
  it("deletes events whose expiresAt is in the past and returns the count", async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 3 });
    const prisma = { memoryEvent: { deleteMany } };
    const result = await runExpireEventsJob(prisma);
    expect(result).toEqual({ count: 3 });
    expect(deleteMany).toHaveBeenCalledTimes(1);
    const arg = deleteMany.mock.calls[0][0];
    expect(arg.where.expiresAt.lt).toBeInstanceOf(Date);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @statecore/worker test expire-events`
Expected: FAIL — `./expire-events` does not exist.

- [ ] **Step 3: Implement `apps/worker/src/expire-events.ts`**

```typescript
export type ExpirePrisma = {
  memoryEvent: {
    deleteMany: (args: { where: { expiresAt: { lt: Date } } }) => Promise<{ count: number }>;
  };
};

// Purge MemoryEvent rows past their expiresAt. Idempotent — safe to run from a
// single cluster-wide repeatable job.
export async function runExpireEventsJob(prisma: ExpirePrisma): Promise<{ count: number }> {
  return prisma.memoryEvent.deleteMany({ where: { expiresAt: { lt: new Date() } } });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @statecore/worker test expire-events`
Expected: PASS (1 test).

- [ ] **Step 5: Replace the 3 setInterval blocks with a maintenance queue + worker + schedulers in `main.ts`**

Add the import near the other job-module imports:
```typescript
import { runExpireEventsJob } from "./expire-events";
```
`Queue` and `Worker` are already imported from `bullmq` in `main.ts`. DELETE the three `setInterval` blocks (the `expire_events` 6h block, the `daily_remind` 24h block, and the `detect_emotional_patterns` 7d block — roughly lines 618-643). KEEP the `send_reminders_tick` `setInterval` above them unchanged.

Then add, after the existing Worker definitions (near where `reminderQueue` is created/used):

```typescript
// Maintenance jobs run cluster-wide once per interval via BullMQ repeatable
// schedulers (idempotent by schedulerId across replicas), replacing per-replica
// setInterval calls that would fire N times with N worker replicas.
const maintenanceQueue = new Queue("maintenance", { connection });

new Worker(
  "maintenance",
  async (job) => {
    if (job.name === "expire_events") {
      const { count } = await runExpireEventsJob(prisma);
      if (count > 0) logger.info({ count }, "Expired events purged");
      return { ok: true };
    }
    if (job.name === "daily_remind") {
      if (!llm) return { ok: true, skipped: true };
      await runDailyRemindJob(llm, prisma);
      return { ok: true };
    }
    if (job.name === "detect_emotional_patterns") {
      if (!llm) return { ok: true, skipped: true };
      await runDetectEmotionalPatternsJob(llm, prisma);
      return { ok: true };
    }
    return { ok: true };
  },
  { connection, concurrency: 1 }
).on("failed", (job, err) => {
  logger.error({ jobId: job?.id, name: job?.name, err }, "Maintenance job failed");
});

const HOUR_MS = 60 * 60 * 1000;
void maintenanceQueue
  .upsertJobScheduler("expire-events-6h", { every: 6 * HOUR_MS }, { name: "expire_events" })
  .catch((err) => logger.error({ err }, "failed to register expire_events scheduler"));
void maintenanceQueue
  .upsertJobScheduler("daily-remind-24h", { every: 24 * HOUR_MS }, { name: "daily_remind" })
  .catch((err) => logger.error({ err }, "failed to register daily_remind scheduler"));
void maintenanceQueue
  .upsertJobScheduler("detect-emotional-patterns-7d", { every: 7 * 24 * HOUR_MS }, { name: "detect_emotional_patterns" })
  .catch((err) => logger.error({ err }, "failed to register detect_emotional_patterns scheduler"));
```

(`connection`, `prisma`, `llm`, `logger` are all already in scope in `main.ts`.)

- [ ] **Step 6: Verify build + full worker suite**

Run: `pnpm --filter @statecore/worker build && pnpm --filter @statecore/worker test`
Expected: PASS. Confirm the 3 `setInterval` direct-call blocks are gone (`grep -n "setInterval" apps/worker/src/main.ts` should show ONLY the `send_reminders_tick` one).

- [ ] **Step 7: Commit**

```bash
git add apps/worker/src/expire-events.ts apps/worker/src/expire-events.test.ts apps/worker/src/main.ts
git commit -m "fix(worker): run maintenance schedulers as cluster-safe BullMQ repeatable jobs"
```

---

### Task 4: Bound the runtime recall caches (packages/core)

**Files:**
- Create: `packages/core/src/bounded-ttl-cache.ts`
- Create: `packages/core/src/bounded-ttl-cache.test.ts`
- Modify: `packages/core/src/assistant-runtime.ts` (replace the two `Map`-based caches ~lines 429-436 and their access sites ~lines 881, 905, 914, 945)

**Interfaces:**
- Produces: `class BoundedTtlCache<V> { constructor(ttlMs: number, maxEntries: number); get(key: string, now?: number): V | undefined; set(key: string, value: V, now?: number): void }`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/bounded-ttl-cache.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { BoundedTtlCache } from "./bounded-ttl-cache";

describe("BoundedTtlCache", () => {
  it("returns a stored value before expiry and undefined after", () => {
    const c = new BoundedTtlCache<number>(1000, 10);
    c.set("a", 1, 0);
    expect(c.get("a", 500)).toBe(1);
    expect(c.get("a", 1000)).toBeUndefined(); // expiresAt is exclusive at ttl boundary
  });

  it("evicts the least-recently-written entry beyond the cap", () => {
    const c = new BoundedTtlCache<number>(10_000, 2);
    c.set("a", 1, 0);
    c.set("b", 2, 0);
    c.set("c", 3, 0); // exceeds cap 2 -> oldest ("a") evicted
    expect(c.get("a", 1)).toBeUndefined();
    expect(c.get("b", 1)).toBe(2);
    expect(c.get("c", 1)).toBe(3);
  });

  it("re-writing a key refreshes its recency so it is not the first evicted", () => {
    const c = new BoundedTtlCache<number>(10_000, 2);
    c.set("a", 1, 0);
    c.set("b", 2, 0);
    c.set("a", 11, 0); // refresh "a" -> "b" is now oldest
    c.set("c", 3, 0);  // evicts "b"
    expect(c.get("a", 1)).toBe(11);
    expect(c.get("b", 1)).toBeUndefined();
    expect(c.get("c", 1)).toBe(3);
  });

  it("purges expired entries on write so the map cannot grow unbounded with stale keys", () => {
    const c = new BoundedTtlCache<number>(1000, 100);
    c.set("old", 1, 0);
    c.set("new", 2, 2000); // 'old' is expired at now=2000 and purged during this set
    expect(c.get("old", 2001)).toBeUndefined();
    expect(c.get("new", 2001)).toBe(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @statecore/core test bounded-ttl-cache`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `packages/core/src/bounded-ttl-cache.ts`**

```typescript
// A TTL cache with a hard entry cap. On every write it opportunistically purges
// expired entries and evicts the least-recently-written entry once the cap is
// exceeded, so memory stays bounded without a background timer (no import-time
// side effects in this library).
export class BoundedTtlCache<V> {
  private readonly map = new Map<string, { expiresAt: number; value: V }>();

  constructor(private readonly ttlMs: number, private readonly maxEntries: number) {}

  get(key: string, now: number = Date.now()): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V, now: number = Date.now()): void {
    // Opportunistically purge expired entries.
    for (const [k, entry] of this.map) {
      if (entry.expiresAt <= now) this.map.delete(k);
    }
    // delete-then-set so insertion order tracks write recency (Map keeps order).
    this.map.delete(key);
    this.map.set(key, { expiresAt: now + this.ttlMs, value });
    // Evict least-recently-written entries beyond the cap.
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @statecore/core test bounded-ttl-cache`
Expected: PASS (4 tests).

- [ ] **Step 5: Replace the two Map caches in `assistant-runtime.ts`**

Read `packages/core/src/assistant-runtime.ts` around lines 425-450 and the access sites (~881, 905, 914, 945). Add the import (top of file with the other relative imports):
```typescript
import { BoundedTtlCache } from "./bounded-ttl-cache";
```
Replace the two declarations (~lines 429-436):
```typescript
const runtimeRecallCache = new Map<string, {
  expiresAt: number;
  result: Awaited<ReturnType<RuntimeRetrieveService["retrieve"]>>;
}>();
const runtimeResolvedRecallCache = new Map<string, {
  expiresAt: number;
  result: ResolvedRecall;
}>();
```
with:
```typescript
const RUNTIME_RECALL_CACHE_MAX_ENTRIES = 500;
const runtimeRecallCache = new BoundedTtlCache<
  Awaited<ReturnType<RuntimeRetrieveService["retrieve"]>>
>(RUNTIME_RECALL_CACHE_TTL_MS, RUNTIME_RECALL_CACHE_MAX_ENTRIES);
const runtimeResolvedRecallCache = new BoundedTtlCache<ResolvedRecall>(
  RUNTIME_RECALL_CACHE_TTL_MS,
  RUNTIME_RECALL_CACHE_MAX_ENTRIES
);
```
Then migrate every access site. The old pattern reads like:
```typescript
const cached = runtimeRecallCache.get(key);
if (cached && cached.expiresAt > Date.now()) {
  return cached.result;
}
// ...
runtimeRecallCache.set(key, { expiresAt: Date.now() + RUNTIME_RECALL_CACHE_TTL_MS, result });
```
Replace each read with the new API (the cache now handles expiry internally):
```typescript
const cached = runtimeRecallCache.get(key);
if (cached !== undefined) {
  return cached;
}
```
and each write with:
```typescript
runtimeRecallCache.set(key, result);
```
Do the same for `runtimeResolvedRecallCache` (it stores a `ResolvedRecall`). Inspect each of the ~4 sites and adapt exactly — the value stored is now the bare result, not `{ expiresAt, result }`.

- [ ] **Step 6: Verify build + full core suite**

Run: `pnpm --filter @statecore/core build && pnpm --filter @statecore/core test`
Expected: PASS (existing tests + 4 new). The recall behavior is unchanged for callers (hit/miss semantics identical within the 15s TTL).

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/bounded-ttl-cache.ts packages/core/src/bounded-ttl-cache.test.ts packages/core/src/assistant-runtime.ts
git commit -m "refactor(core): bound runtime recall caches with BoundedTtlCache"
```

---

### Task 5: Document lite-mode as single-instance only

**Files:**
- Modify: `apps/api/src/queue.ts` (comment at the lite branch)
- Modify: `deploy.md` (one operational note)

**Interfaces:** none.

- [ ] **Step 1: Add the comment in `apps/api/src/queue.ts`**

Above the `if (isLite) {` branch, add:
```typescript
// NOTE: lite mode uses in-process InMemoryQueueAdapter — jobs are NOT shared
// across processes. It is for single-instance / development use ONLY. A
// multi-replica deployment MUST use full mode (STATECORE_MODE unset/non-lite)
// so all replicas share the Redis-backed BullMQ queues.
```

- [ ] **Step 2: Add the operational note in `deploy.md`**

Add a short line in the relevant section (scaling / modes):
> **Multi-instance:** Run multiple API/worker replicas only in full mode (Redis-backed BullMQ). `STATECORE_MODE=lite` uses an in-process queue and is single-instance / development only.

- [ ] **Step 3: Verify build**

Run: `pnpm --filter @statecore/api build`
Expected: PASS (comment/doc only — no behavior change).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/queue.ts deploy.md
git commit -m "docs: document lite-mode queue as single-instance only"
```

---

## Self-Review

**Spec coverage:**
- Spec item 1 (remove rate limiter) → Task 1. ✓
- Spec item 2 (rebuild lock, same key, longer TTL) → Task 2 (ttl 900, `digest-lock:<scopeId>`). ✓
- Spec item 3 (3 schedulers → repeatable jobs, repeatable not bucketed-jobId, keep send_reminders_tick, keep `!llm` guard) → Task 3 (`upsertJobScheduler`, maintenance worker, guards preserved). ✓
- Spec item 4 (bound recall caches, no library setInterval) → Task 4 (`BoundedTtlCache`, opportunistic purge + cap). ✓
- Spec item 5 (lite-mode doc) → Task 5. ✓
- /v1 / snapshot constraint → Task 1 Steps 2 & 6 guard the snapshot. ✓
- Testing approach (no live Redis; extracted modules carry tests) → Tasks 2/3/4 test the extracted units with vi mocks; main.ts wiring reviewed. Note: the `main.ts` scheduler/worker wiring and the rebuild branch substitution are NOT unit-tested (main.ts has top-level side effects) — they are verified by build + review against the `digest_scope` precedent, as the architecture note states. ✓

**Placeholder scan:** No "TBD"/"handle errors"/bare "write tests" — every code step shows code; the one read-and-adapt step (Task 4 Step 5, assistant-runtime access sites) shows the exact before/after API because the file is large and the sites must be adapted in place. ✓

**Type consistency:** `RebuildData` (Task 2) matches the `job.data` cast in main.ts. `processRebuildDigestChainJob`, `runExpireEventsJob`, `BoundedTtlCache` signatures are used consistently between their definition tasks and their wiring. `LockRedis`/`withDigestLock`/`DigestAlreadyRunningError` reused from existing `digest-lock.ts` unchanged. ✓
