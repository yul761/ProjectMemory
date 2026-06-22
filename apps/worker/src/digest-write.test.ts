import { describe, it, expect, vi } from "vitest";
import { createDigestWithSnapshot, type DigestWritePrisma, type DigestWriteTx } from "./digest-write";

function makePrismaStub(snapshotShouldReject = false): {
  prisma: DigestWritePrisma;
  calls: string[];
  digestCreateArgs: any[];
  snapshotCreateArgs: any[];
} {
  const calls: string[] = [];
  const digestCreateArgs: any[] = [];
  const snapshotCreateArgs: any[] = [];

  const prisma: DigestWritePrisma = {
    $transaction: async (fn) => {
      const tx: DigestWriteTx = {
        digest: {
          create: vi.fn(async (args) => {
            calls.push("digest.create");
            digestCreateArgs.push(args);
            return { id: "digest-uuid-1" };
          })
        },
        digestStateSnapshot: {
          create: vi.fn(async (args) => {
            calls.push("snapshot.create");
            snapshotCreateArgs.push(args);
            if (snapshotShouldReject) throw new Error("snapshot write failed");
            return {};
          })
        }
      };
      return fn(tx);
    }
  };

  return { prisma, calls, digestCreateArgs, snapshotCreateArgs };
}

describe("createDigestWithSnapshot", () => {
  it("calls digest.create before digestStateSnapshot.create inside $transaction (atomic)", async () => {
    const { prisma, calls } = makePrismaStub();

    await createDigestWithSnapshot(prisma, {
      scopeId: "scope-1",
      summary: "test summary",
      changes: "- change A\n- change B",
      nextSteps: ["step 1"],
      state: { profile: {} },
      consistency: { score: 1 }
    });

    expect(calls).toEqual(["digest.create", "snapshot.create"]);
  });

  it("passes the created digest's id as digestId on the snapshot", async () => {
    const { prisma, snapshotCreateArgs } = makePrismaStub();

    await createDigestWithSnapshot(prisma, {
      scopeId: "scope-1",
      summary: "summary",
      changes: "- c",
      nextSteps: [],
      state: {},
      consistency: {}
    });

    expect(snapshotCreateArgs[0].data.digestId).toBe("digest-uuid-1");
  });

  it("includes rebuildGroupId in digest data when provided", async () => {
    const { prisma, digestCreateArgs } = makePrismaStub();

    await createDigestWithSnapshot(prisma, {
      scopeId: "scope-1",
      summary: "s",
      changes: "- c",
      nextSteps: [],
      state: {},
      consistency: {},
      rebuildGroupId: "rebuild-group-abc"
    });

    expect(digestCreateArgs[0].data.rebuildGroupId).toBe("rebuild-group-abc");
  });

  it("omits rebuildGroupId from digest data when not provided", async () => {
    const { prisma, digestCreateArgs } = makePrismaStub();

    await createDigestWithSnapshot(prisma, {
      scopeId: "scope-1",
      summary: "s",
      changes: "- c",
      nextSteps: [],
      state: {},
      consistency: {}
    });

    expect(digestCreateArgs[0].data).not.toHaveProperty("rebuildGroupId");
  });

  it("rejects and propagates error when digestStateSnapshot.create fails", async () => {
    const { prisma } = makePrismaStub(true);

    await expect(
      createDigestWithSnapshot(prisma, {
        scopeId: "scope-1",
        summary: "s",
        changes: "- c",
        nextSteps: [],
        state: {},
        consistency: {}
      })
    ).rejects.toThrow("snapshot write failed");
  });

  it("returns the created digest object", async () => {
    const { prisma } = makePrismaStub();

    const result = await createDigestWithSnapshot(prisma, {
      scopeId: "scope-1",
      summary: "s",
      changes: "- c",
      nextSteps: [],
      state: {},
      consistency: {}
    });

    expect(result).toEqual({ id: "digest-uuid-1" });
  });
});
