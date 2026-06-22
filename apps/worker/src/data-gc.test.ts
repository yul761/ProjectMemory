import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-22T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("deletes job logs older than the retention window by completedAt", async () => {
    const deleteMany = vi.fn(async (_: { where: { completedAt: { lt: Date } } }) => ({ count: 5 }));
    const prisma = { digestJobLog: { deleteMany } };
    const result = await runGcJobLogsJob(prisma as any, 30);
    expect(result).toEqual({ count: 5 });
    const arg = deleteMany.mock.calls[0][0];
    expect(arg.where.completedAt.lt).toBeInstanceOf(Date);
    const expected = Date.now() - 30 * 24 * 60 * 60 * 1000;
    expect(Math.abs(arg.where.completedAt.lt.getTime() - expected)).toBeLessThan(1000);
  });
});

describe("runGcRemindersJob", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-22T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("deletes terminal (sent/cancelled) reminders older than the window, keeping scheduled", async () => {
    const deleteMany = vi.fn(async (_: { where: { status: { in: string[] }; createdAt: { lt: Date } } }) => ({ count: 2 }));
    const prisma = { reminder: { deleteMany } };
    const result = await runGcRemindersJob(prisma as any, 30);
    expect(result).toEqual({ count: 2 });
    const arg = deleteMany.mock.calls[0][0];
    expect(arg.where.status.in).toEqual(["sent", "cancelled"]);
    expect(arg.where.createdAt.lt).toBeInstanceOf(Date);
    const expected = Date.now() - 30 * 24 * 60 * 60 * 1000;
    expect(Math.abs(arg.where.createdAt.lt.getTime() - expected)).toBeLessThan(1000);
  });
});
