import { describe, it, expect, vi } from "vitest";

const baseScope = { id: "sc-1", template: "personal" };

function makeEvent(overrides: {
  id: string;
  content: string;
  classifiedType?: string | null;
  createdAt?: Date;
}) {
  return {
    id: overrides.id,
    content: overrides.content,
    classifiedType: overrides.classifiedType ?? null,
    createdAt: overrides.createdAt ?? new Date("2026-06-01T10:00:00Z"),
    scopeId: "sc-1"
  };
}

describe("buildRelationshipContext", () => {
  it("returns durationDays=0 and empty arrays when scope has no events", async () => {
    const mockDb = {
      projectScope: { findUnique: vi.fn().mockResolvedValue(baseScope) },
      memoryEvent: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) },
      digestStateSnapshot: { findFirst: vi.fn().mockResolvedValue(null) }
    } as any;

    const { buildRelationshipContext } = await import("./relationship-context");
    const result = await buildRelationshipContext("sc-1", mockDb);

    expect(result.durationDays).toBe(0);
    expect(result.personalDetails).toEqual([]);
    expect(result.activeGoals).toEqual([]);
    expect(result.currentFeeling).toBeNull();
    expect(result.pendingFollowUps).toEqual([]);
    expect(result.personaPrompt).toBeTruthy();
  });

  it("extracts personalDetails and computes durationDays", async () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000);
    const firstEvent = makeEvent({ id: "e1", content: "name: 小明", classifiedType: "personal_detail", createdAt: thirtyDaysAgo });
    const secondEvent = makeEvent({ id: "e2", content: "has a cat named Luna", classifiedType: "personal_detail" });

    const mockDb = {
      projectScope: { findUnique: vi.fn().mockResolvedValue(baseScope) },
      memoryEvent: {
        findFirst: vi.fn().mockResolvedValue(firstEvent),
        findMany: vi.fn()
          .mockResolvedValueOnce([firstEvent, secondEvent])
          .mockResolvedValueOnce([])
      },
      digestStateSnapshot: { findFirst: vi.fn().mockResolvedValue(null) }
    } as any;

    const { buildRelationshipContext } = await import("./relationship-context");
    const result = await buildRelationshipContext("sc-1", mockDb);

    expect(result.durationDays).toBeGreaterThanOrEqual(29);
    expect(result.personalDetails).toEqual(["name: 小明", "has a cat named Luna"]);
  });

  it("returns currentFeeling from recent feeling event", async () => {
    const recentFeeling = makeEvent({
      id: "f1",
      content: "feeling anxious about the presentation",
      classifiedType: "feeling",
      createdAt: new Date(Date.now() - 2 * 86_400_000)
    });

    const mockDb = {
      projectScope: { findUnique: vi.fn().mockResolvedValue(baseScope) },
      memoryEvent: {
        findFirst: vi.fn()
          .mockResolvedValueOnce(null)          // oldest event
          .mockResolvedValueOnce(recentFeeling), // most recent feeling
        findMany: vi.fn()
          .mockResolvedValueOnce([])   // personal_detail
          .mockResolvedValueOnce([])   // old commitments
      },
      digestStateSnapshot: { findFirst: vi.fn().mockResolvedValue(null) }
    } as any;

    const { buildRelationshipContext } = await import("./relationship-context");
    const result = await buildRelationshipContext("sc-1", mockDb);

    expect(result.currentFeeling).toBe("feeling anxious about the presentation");
  });

  it("returns pendingFollowUps for old commitment events", async () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000);
    const oldCommitment = makeEvent({
      id: "c1",
      content: "promised to call mom this weekend",
      classifiedType: "commitment",
      createdAt: tenDaysAgo
    });

    const mockDb = {
      projectScope: { findUnique: vi.fn().mockResolvedValue(baseScope) },
      memoryEvent: {
        findFirst: vi.fn()
          .mockResolvedValueOnce(null)  // oldest event
          .mockResolvedValueOnce(null), // most recent feeling
        findMany: vi.fn()
          .mockResolvedValueOnce([])              // personal_detail
          .mockResolvedValueOnce([oldCommitment]) // old commitments
      },
      digestStateSnapshot: { findFirst: vi.fn().mockResolvedValue(null) }
    } as any;

    const { buildRelationshipContext } = await import("./relationship-context");
    const result = await buildRelationshipContext("sc-1", mockDb);

    expect(result.pendingFollowUps).toHaveLength(1);
    expect(result.pendingFollowUps[0]).toContain("promised to call mom");
    expect(result.pendingFollowUps[0]).toContain("days ago");
  });
});
