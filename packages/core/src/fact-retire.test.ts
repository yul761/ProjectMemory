import { describe, it, expect } from "vitest";
import {
  getActiveFactRegistry,
  retireFact,
  addNoteFact,
  type DigestState,
  type FactRegistryEntry
} from "./digest-control";

const NOW = () => "2026-08-05T00:00:00.000Z";

function entry(overrides: Partial<FactRegistryEntry> = {}): FactRegistryEntry {
  return {
    id: "f1",
    content: "旧事实",
    type: "profile",
    confidence: 0.7,
    addedAt: "2026-01-01T00:00:00.000Z",
    evidenceId: "e1",
    evidenceType: "event",
    facet: "notes",
    ...overrides
  };
}

function stateWith(entries: FactRegistryEntry[]): DigestState {
  return { stableFacts: {}, factRegistry: entries } as unknown as DigestState;
}

describe("fact retirement", () => {
  it("keeps a retired fact on the record but out of the active set", () => {
    const state = stateWith([entry()]);

    retireFact(state, "旧事实", "cap_evicted", NOW);

    expect(state.factRegistry).toHaveLength(1);
    expect(state.factRegistry![0].retiredAt).toBe("2026-08-05T00:00:00.000Z");
    expect(state.factRegistry![0].retiredReason).toBe("cap_evicted");
    expect(getActiveFactRegistry(state)).toHaveLength(0);
  });

  it("does not retire an already-superseded entry", () => {
    const state = stateWith([entry({ supersededBy: "f2" }), entry({ id: "f2", content: "新事实" })]);

    retireFact(state, "旧事实", "cap_evicted", NOW);

    expect(state.factRegistry![0].retiredAt).toBeUndefined();
  });

  it("is a no-op when the fact is not in the registry", () => {
    const state = stateWith([entry()]);

    expect(() => retireFact(state, "从未存在的事实", "cap_evicted", NOW)).not.toThrow();
    expect(getActiveFactRegistry(state)).toHaveLength(1);
  });

  it("capacity eviction retires the registry record rather than deleting it", () => {
    const state = { stableFacts: {}, factRegistry: [], profile: { notes: [] } } as unknown as DigestState;
    let n = 0;
    const cap = 30;

    for (let i = 0; i < cap + 1; i++) {
      addNoteFact(state, `第 ${i} 条互不相同的长期笔记内容`, () => `id-${n++}`, NOW);
    }

    const retired = state.factRegistry!.filter((e) => e.retiredAt);
    expect(retired).toHaveLength(1);
    expect(retired[0].retiredReason).toBe("cap_evicted");
    // The audit chain survives: the record is still there, just inactive.
    expect(state.factRegistry).toHaveLength(cap + 1);
    expect(getActiveFactRegistry(state)).toHaveLength(cap);
  });
});
