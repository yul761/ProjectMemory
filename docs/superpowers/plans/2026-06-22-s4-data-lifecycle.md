# S4 Data Lifecycle / GC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound long-run DB growth with cluster-safe daily GC of digest/snapshot history, digest job logs, and terminal reminders — never deleting the live state (latest digest+snapshot per scope) or pending reminders.

**Architecture:** Three pure, testable GC functions in a new `apps/worker/src/data-gc.ts` (stub-prisma unit-tested), wired into the existing S2 `maintenance` BullMQ worker as a single daily `data_gc` repeatable job. No schema change, no migration, no `/v1` change.

**Tech Stack:** TypeScript, Prisma, BullMQ (`upsertJobScheduler`), vitest.

## Global Constraints

- Tests: `pnpm --filter @statecore/worker test` (vitest). `main.ts` has top-level side effects → NOT unit-testable; extracted functions carry the tests, wiring is review-verified (same pattern as S2/S3).
- NO schema change, NO migration, NO `/v1` contract change. OpenAPI snapshots stay byte-identical (worker-only change; not even imported by api tests).
- **Never delete the latest digest per scope** (it is the live `lastState` for the digest pipeline + rebuild). FK-safe order: `DigestStateSnapshot` has NO `onDelete: Cascade` to `Digest`, so a doomed digest's snapshot MUST be deleted BEFORE the digest.
- **Never delete `scheduled` reminders** (only terminal `sent`/`cancelled`).
- `DigestJobLog`'s timestamp column is **`completedAt`** (not `createdAt`).
- Retention defaults (env, `apps/worker/src/env.ts`): `DIGEST_RETENTION_DAYS`=90, `JOB_LOG_RETENTION_DAYS`=30, `REMINDER_RETENTION_DAYS`=30.
- Reuse the S2 `maintenance` worker + `upsertJobScheduler` pattern (one daily scheduler `data-gc-daily`). Do NOT touch `MemoryEvent`/`expire_events` (S2 owns it), `WorkingMemorySnapshot` (one per scope), or embeddings (cascade).

---

### Task 1: The three GC functions (extracted, unit-tested)

**Files:**
- Create: `apps/worker/src/data-gc.ts`
- Create: `apps/worker/src/data-gc.test.ts`

**Interfaces:**
- Produces:
  - `runGcDigestsJob(prisma: GcDigestPrisma, retentionDays: number): Promise<{ deletedDigests: number; deletedSnapshots: number }>`
  - `runGcJobLogsJob(prisma: GcJobLogPrisma, retentionDays: number): Promise<{ count: number }>`
  - `runGcRemindersJob(prisma: GcReminderPrisma, retentionDays: number): Promise<{ count: number }>`
  - and the three structural prisma types below.

- [ ] **Step 1: Write the failing tests**

Create `apps/worker/src/data-gc.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { runGcDigestsJob, runGcJobLogsJob, runGcRemindersJob } from "./data-gc";

describe("runGcDigestsJob", () => {
  it("deletes old non-latest digests + their snapshots (snapshots first), protecting the latest per scope", async () => {
    const order: string[] = [];
    // scope s: d1 (old), d2 (old, latest); scope s2: d3 (old, latest/only)
    const oldDigests = [
      { id: "d1", scopeId: "s" },
      { id: "d2", scopeId: "s" },
      { id: "d3", scopeId: "s2" }
    ];
    const latestByScope: Record<string, { id: string }> = { s: { id: "d2" }, s2: { id: "d3" } };
    const snapDelete = vi.fn(async (_args: any) => { order.push("snapshot"); return { count: 1 }; });
    const digestDelete = vi.fn(async (_args: any) => { order.push("digest"); return { count: 1 }; });
    const prisma = {
      digest: {
        findMany: vi.fn(async () => oldDigests),
        findFirst: vi.fn(async (args: any) => latestByScope[args.where.scopeId] ?? null),
        deleteMany: digestDelete
      },
      digestStateSnapshot: { deleteMany: snapDelete }
    };

    const result = await runGcDigestsJob(prisma as any, 90);

    // Only d1 is doomed (d2 is s's latest, d3 is s2's latest -> both protected).
    expect(snapDelete).toHaveBeenCalledWith({ where: { digestId: { in: ["d1"] } } });
    expect(digestDelete).toHaveBeenCalledWith({ where: { id: { in: ["d1"] } } });
    // FK-safe: snapshot deleted before digest.
    expect(order).toEqual(["snapshot", "digest"]);
    // Protected ids never appear in any delete call.
    const allDeletedDigestIds = digestDelete.mock.calls.flatMap((c: any) => c[0].where.id.in);
    expect(allDeletedDigestIds).not.toContain("d2");
    expect(allDeletedDigestIds).not.toContain("d3");
    expect(result).toEqual({ deletedDigests: 1, deletedSnapshots: 1 });
  });

  it("protects a scope whose only old digest IS the latest (deletes nothing)", async () => {
    const prisma = {
      digest: {
        findMany: vi.fn(async () => [{ id: "only", scopeId: "s" }]),
        findFirst: vi.fn(async () => ({ id: "only" })),
        deleteMany: vi.fn(async () => ({ count: 0 }))
      },
      digestStateSnapshot: { deleteMany: vi.fn(async () => ({ count: 0 })) }
    };
    const result = await runGcDigestsJob(prisma as any, 90);
    expect(prisma.digestStateSnapshot.deleteMany).not.toHaveBeenCalled();
    expect(prisma.digest.deleteMany).not.toHaveBeenCalled();
    expect(result).toEqual({ deletedDigests: 0, deletedSnapshots: 0 });
  });
});

describe("runGcJobLogsJob", () => {
  it("deletes job logs older than the retention window by completedAt", async () => {
    const deleteMany = vi.fn(async () => ({ count: 5 }));
    const prisma = { digestJobLog: { deleteMany } };
    const result = await runGcJobLogsJob(prisma as any, 30);
    expect(result).toEqual({ count: 5 });
    const arg = deleteMany.mock.calls[0][0];
    expect(arg.where.completedAt.lt).toBeInstanceOf(Date);
  });
});

describe("runGcRemindersJob", () => {
  it("deletes terminal (sent/cancelled) reminders older than the window, keeping scheduled", async () => {
    const deleteMany = vi.fn(async () => ({ count: 2 }));
    const prisma = { reminder: { deleteMany } };
    const result = await runGcRemindersJob(prisma as any, 30);
    expect(result).toEqual({ count: 2 });
    const arg = deleteMany.mock.calls[0][0];
    expect(arg.where.status.in).toEqual(["sent", "cancelled"]);
    expect(arg.where.createdAt.lt).toBeInstanceOf(Date);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @statecore/worker test data-gc`
Expected: FAIL — `./data-gc` does not exist.

- [ ] **Step 3: Implement `apps/worker/src/data-gc.ts`**

```typescript
// Cluster-safe data-lifecycle GC. Pure functions over minimal structural prisma
// types so they unit-test with stubs. Never deletes the latest digest per scope
// (the live state) or scheduled reminders.

function cutoffDate(retentionDays: number): Date {
  return new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
}

export type GcDigestPrisma = {
  digest: {
    findMany: (args: { where: { createdAt: { lt: Date } }; select: { id: true; scopeId: true } }) => Promise<{ id: string; scopeId: string }[]>;
    findFirst: (args: { where: { scopeId: string }; orderBy: Array<{ createdAt: "desc" } | { id: "desc" }>; select: { id: true } }) => Promise<{ id: string } | null>;
    deleteMany: (args: { where: { id: { in: string[] } } }) => Promise<{ count: number }>;
  };
  digestStateSnapshot: {
    deleteMany: (args: { where: { digestId: { in: string[] } } }) => Promise<{ count: number }>;
  };
};

// Keep the latest digest per scope (always); delete older digests + their paired
// snapshots. Snapshots are deleted BEFORE digests because DigestStateSnapshot has
// no ON DELETE CASCADE to Digest (FK would otherwise block the delete).
export async function runGcDigestsJob(
  prisma: GcDigestPrisma,
  retentionDays: number
): Promise<{ deletedDigests: number; deletedSnapshots: number }> {
  const cutoff = cutoffDate(retentionDays);
  const oldDigests = await prisma.digest.findMany({
    where: { createdAt: { lt: cutoff } },
    select: { id: true, scopeId: true }
  });
  const scopeIds = [...new Set(oldDigests.map((d) => d.scopeId))];
  let deletedDigests = 0;
  let deletedSnapshots = 0;
  for (const scopeId of scopeIds) {
    const latest = await prisma.digest.findFirst({
      where: { scopeId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true }
    });
    const doomedIds = oldDigests
      .filter((d) => d.scopeId === scopeId && d.id !== latest?.id)
      .map((d) => d.id);
    if (doomedIds.length === 0) continue;
    const snaps = await prisma.digestStateSnapshot.deleteMany({ where: { digestId: { in: doomedIds } } });
    const digs = await prisma.digest.deleteMany({ where: { id: { in: doomedIds } } });
    deletedSnapshots += snaps.count;
    deletedDigests += digs.count;
  }
  return { deletedDigests, deletedSnapshots };
}

export type GcJobLogPrisma = {
  digestJobLog: {
    deleteMany: (args: { where: { completedAt: { lt: Date } } }) => Promise<{ count: number }>;
  };
};

export async function runGcJobLogsJob(prisma: GcJobLogPrisma, retentionDays: number): Promise<{ count: number }> {
  return prisma.digestJobLog.deleteMany({ where: { completedAt: { lt: cutoffDate(retentionDays) } } });
}

export type GcReminderPrisma = {
  reminder: {
    deleteMany: (args: { where: { status: { in: string[] }; createdAt: { lt: Date } } }) => Promise<{ count: number }>;
  };
};

export async function runGcRemindersJob(prisma: GcReminderPrisma, retentionDays: number): Promise<{ count: number }> {
  return prisma.reminder.deleteMany({
    where: { status: { in: ["sent", "cancelled"] }, createdAt: { lt: cutoffDate(retentionDays) } }
  });
}
```

- [ ] **Step 4: Run to verify it passes + full worker suite**

Run: `pnpm --filter @statecore/worker test data-gc`
Expected: PASS (4 tests).
Run: `pnpm --filter @statecore/worker test`
Expected: full worker suite PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/data-gc.ts apps/worker/src/data-gc.test.ts
git commit -m "feat(worker): data-lifecycle GC functions (digests/snapshots, job logs, reminders)"
```

---

### Task 2: Wire the daily data_gc job into the maintenance worker

**Files:**
- Modify: `apps/worker/src/env.ts` (3 retention env vars)
- Modify: `apps/worker/src/main.ts` (import GC fns; `data_gc` dispatch branch; `data-gc-daily` scheduler)

**Interfaces:**
- Consumes: `runGcDigestsJob`, `runGcJobLogsJob`, `runGcRemindersJob` from `./data-gc` (Task 1); `workerEnv.digestRetentionDays` / `jobLogRetentionDays` / `reminderRetentionDays`.

- [ ] **Step 1: Add the retention env vars in `apps/worker/src/env.ts`**

In the env schema object (near the other `DIGEST_*` entries, ~lines 53-64), add:
```typescript
  DIGEST_RETENTION_DAYS: z.string().optional(),
  JOB_LOG_RETENTION_DAYS: z.string().optional(),
  REMINDER_RETENTION_DAYS: z.string().optional(),
```
In the parsed `workerEnv` object (find the block that does `Number(env.X || default)` for the other digest fields), add:
```typescript
  digestRetentionDays: Number(env.DIGEST_RETENTION_DAYS || 90),
  jobLogRetentionDays: Number(env.JOB_LOG_RETENTION_DAYS || 30),
  reminderRetentionDays: Number(env.REMINDER_RETENTION_DAYS || 30),
```
(Match the existing comma/placement style; read the parsed object first to place them correctly.)

- [ ] **Step 2: Import the GC functions in `main.ts`**

Near the other job-module imports (~line 26-28, the `runExpireEventsJob` import):
```typescript
import { runGcDigestsJob, runGcJobLogsJob, runGcRemindersJob } from "./data-gc";
```

- [ ] **Step 3: Add the `data_gc` dispatch branch to the maintenance worker**

In the `new Worker("maintenance", ...)` handler (the block around lines 632-650 that already handles `expire_events`/`daily_remind`/`detect_emotional_patterns`), add a branch:
```typescript
    if (job.name === "data_gc") {
      const digests = await runGcDigestsJob(prisma, workerEnv.digestRetentionDays);
      const jobLogs = await runGcJobLogsJob(prisma, workerEnv.jobLogRetentionDays);
      const reminders = await runGcRemindersJob(prisma, workerEnv.reminderRetentionDays);
      logger.info(
        { gc: { deletedDigests: digests.deletedDigests, deletedSnapshots: digests.deletedSnapshots, deletedJobLogs: jobLogs.count, deletedReminders: reminders.count } },
        "data_gc completed"
      );
      return { ok: true };
    }
```
(`prisma`, `workerEnv`, `logger` are already in scope. The real `prisma` client structurally satisfies the `GcDigestPrisma`/`GcJobLogPrisma`/`GcReminderPrisma` types.)

- [ ] **Step 4: Register the daily scheduler**

After the existing `upsertJobScheduler` calls (~lines 658-665), add:
```typescript
void maintenanceQueue
  .upsertJobScheduler("data-gc-daily", { every: 24 * HOUR_MS }, { name: "data_gc", opts: { removeOnComplete: true, removeOnFail: true } })
  .catch((err) => logger.error({ err }, "failed to register data_gc scheduler"));
```
(`HOUR_MS` is already defined at ~line 657.)

- [ ] **Step 5: Build + full worker suite**

Run: `pnpm --filter @statecore/worker build && pnpm --filter @statecore/worker test`
Expected: PASS (the real `prisma` client typechecks against the structural GC types; if `tsc` complains about a `select`/`orderBy` shape mismatch, widen the structural type in `data-gc.ts` minimally to match Prisma's actual signature — note any such adjustment in the report).

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/env.ts apps/worker/src/main.ts
git commit -m "feat(worker): schedule daily data_gc maintenance job"
```

---

## Self-Review

**Spec coverage:**
- Spec §1 (digest+snapshot GC, keep latest per scope, snapshot-before-digest FK order) → Task 1 `runGcDigestsJob` + its two tests (latest-protected, FK order asserted). ✓
- Spec §2 (DigestJobLog GC by `completedAt`) → `runGcJobLogsJob` + test. ✓
- Spec §3 (Reminder GC terminal-only by createdAt, keep scheduled) → `runGcRemindersJob` + test (status in [sent,cancelled]). ✓
- Spec §4 (event sweep unchanged) → not touched; plan explicitly leaves `expire_events`/`MemoryEvent`/embeddings alone (Global Constraints). ✓
- Spec mechanism (extend S2 maintenance worker, one daily `data_gc` scheduler, env retention defaults 90/30/30) → Task 2. ✓
- Spec "no schema/migration/contract change" → Task 2 Global Constraints; only env + worker wiring + new module. ✓

**Placeholder scan:** No TBD/vague steps; all code shown. Task 2 Step 1/5 ask the implementer to read the parsed env block / widen a structural type if Prisma's signature differs — both are concrete read-and-adapt instructions with the exact additions given, not placeholders.

**Type consistency:** `runGcDigestsJob` returns `{ deletedDigests, deletedSnapshots }`, `runGcJobLogsJob`/`runGcRemindersJob` return `{ count }` — used consistently in the Task 2 `data_gc` log. `workerEnv.digestRetentionDays`/`jobLogRetentionDays`/`reminderRetentionDays` names match between env.ts (Task 2 Step 1) and the dispatch (Step 3). Status values `["sent","cancelled"]` match the `ReminderStatus` enum.
