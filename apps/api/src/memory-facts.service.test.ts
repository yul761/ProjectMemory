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
