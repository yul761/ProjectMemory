import { describe, it, expect, vi } from "vitest";
import { MemoryFactsService } from "./memory-facts.service";

const snapshotState = {
  stableFacts: { decisions: [] },
  workingNotes: {},
  todos: [],
  factRegistry: [
    { id: "f1", content: "Launching Remi in July", type: "profile", confidence: 0.85, addedAt: "2026-06-20T00:00:00.000Z", evidenceId: "ev1", evidenceType: "event", facet: "goals" }
  ],
  profile: {
    identity: ["Name is Yuchen"],
    relationships: ["Call the supplier about Q3"]
  }
};

describe("MemoryFactsService.getFacts", () => {
  it("returns grouped facts and excludes forgotten ones", async () => {
    const forgottenKey = (await import("@statecore/core")).computeFactKey("People", "Call the supplier about Q3");
    const mockPrisma = {
      digestStateSnapshot: { findFirst: vi.fn().mockResolvedValue({ state: snapshotState }) },
      forgottenFact: { findMany: vi.fn().mockResolvedValue([{ factKey: forgottenKey }]) }
    } as any;

    const service = new MemoryFactsService(mockPrisma);
    const groups = await service.getFacts("scope-1");

    // "Call the supplier" (People) was forgotten -> only Projects/"Launching Remi" remains
    expect(groups.map((g) => g.group)).toEqual(["Projects"]);
    expect(groups[0].items.map((i) => i.text)).toEqual(["Launching Remi in July"]);
    expect(mockPrisma.forgottenFact.findMany).toHaveBeenCalledWith({ where: { scopeId: "scope-1" } });
  });

  it("returns empty array when there is no digest snapshot yet", async () => {
    const mockPrisma = {
      digestStateSnapshot: { findFirst: vi.fn().mockResolvedValue(null) },
      forgottenFact: { findMany: vi.fn().mockResolvedValue([]) }
    } as any;
    const service = new MemoryFactsService(mockPrisma);
    expect(await service.getFacts("scope-empty")).toEqual([]);
  });
});

describe("MemoryFactsService.forgetFact", () => {
  it("upserts a ForgottenFact and suppresses the evidence event when present", async () => {
    const { computeFactKey } = await import("@statecore/core");
    const goalKey = computeFactKey("Projects", "Launching Remi in July");
    const mockPrisma = {
      digestStateSnapshot: { findFirst: vi.fn().mockResolvedValue({ state: snapshotState }) },
      forgottenFact: { upsert: vi.fn().mockResolvedValue({}) },
      memoryEvent: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) }
    } as any;

    const service = new MemoryFactsService(mockPrisma);
    const result = await service.forgetFact("user-1", "scope-1", goalKey);

    expect(result).toEqual({ ok: true });
    expect(mockPrisma.forgottenFact.upsert).toHaveBeenCalledWith({
      where: { scopeId_factKey: { scopeId: "scope-1", factKey: goalKey } },
      create: { userId: "user-1", scopeId: "scope-1", factKey: goalKey, contentSnapshot: "Launching Remi in July" },
      update: {}
    });
    // factRegistry entry f1 has evidenceId "ev1" -> event gets suppressed
    expect(mockPrisma.memoryEvent.updateMany).toHaveBeenCalledWith({
      where: { id: "ev1" },
      data: { suppressedAt: expect.any(Date) }
    });
  });

  it("forgets a bare profile fact (no evidence event) without touching memoryEvent", async () => {
    const { computeFactKey } = await import("@statecore/core");
    const peopleKey = computeFactKey("People", "Call the supplier about Q3");
    const mockPrisma = {
      digestStateSnapshot: { findFirst: vi.fn().mockResolvedValue({ state: snapshotState }) },
      forgottenFact: { upsert: vi.fn().mockResolvedValue({}) },
      memoryEvent: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) }
    } as any;

    const service = new MemoryFactsService(mockPrisma);
    await service.forgetFact("user-1", "scope-1", peopleKey);

    expect(mockPrisma.forgottenFact.upsert).toHaveBeenCalledOnce();
    expect(mockPrisma.memoryEvent.updateMany).not.toHaveBeenCalled();
  });

  it("forgets a note fact whose evidenceId has no backing MemoryEvent (regression: no P2025 throw)", async () => {
    const { computeFactKey } = await import("@statecore/core");
    const noteText = "Remember to call dentist";
    const noteKey = computeFactKey("Notes", noteText);
    const noteEvidenceId = "note-ev-uuid-no-backing-row";
    const stateWithNote = {
      stableFacts: { decisions: [] },
      workingNotes: {},
      todos: [],
      factRegistry: [
        {
          id: "note-f1",
          content: noteText,
          type: "profile",
          confidence: 1,
          addedAt: "2026-06-27T00:00:00.000Z",
          evidenceId: noteEvidenceId,
          evidenceType: "event",
          facet: "notes"
        }
      ],
      profile: {}
    };
    const mockPrisma = {
      digestStateSnapshot: { findFirst: vi.fn().mockResolvedValue({ state: stateWithNote }) },
      forgottenFact: { upsert: vi.fn().mockResolvedValue({}) },
      // updateMany matches 0 rows harmlessly — no throw (unlike update which throws P2025)
      memoryEvent: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) }
    } as any;

    const service = new MemoryFactsService(mockPrisma);
    const result = await service.forgetFact("user-1", "scope-1", noteKey);

    expect(result).toEqual({ ok: true });
    expect(mockPrisma.forgottenFact.upsert).toHaveBeenCalledWith({
      where: { scopeId_factKey: { scopeId: "scope-1", factKey: noteKey } },
      create: { userId: "user-1", scopeId: "scope-1", factKey: noteKey, contentSnapshot: noteText },
      update: {}
    });
    expect(mockPrisma.memoryEvent.updateMany).toHaveBeenCalledWith({
      where: { id: noteEvidenceId },
      data: { suppressedAt: expect.any(Date) }
    });
  });
});
