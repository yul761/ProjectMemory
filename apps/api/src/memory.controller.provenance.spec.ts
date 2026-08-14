import { describe, it, expect } from "vitest";
import { buildFactProvenance, normalizeSelectionLog, type DigestState, type FactRegistryEntry } from "@statecore/core";

function entry(over: Partial<FactRegistryEntry> = {}): FactRegistryEntry {
  return {
    id: "v1",
    content: "后端工程师",
    type: "profile",
    confidence: 0.7,
    addedAt: "t1",
    evidenceId: "doc1",
    evidenceType: "document",
    facet: "identity",
    ...over
  };
}

function stateWith(entries: FactRegistryEntry[]): DigestState {
  return { stableFacts: {}, factRegistry: entries } as unknown as DigestState;
}

describe("buildFactProvenance", () => {
  it("returns the supersession chain oldest-first", () => {
    const state = stateWith([
      entry({ id: "v1", content: "后端工程师", supersededBy: "v2" }),
      entry({ id: "v2", content: "资深后端工程师", addedAt: "t2", confidence: 0.85 })
    ]);

    const result = buildFactProvenance(state, "v2");

    expect(result).not.toBeNull();
    expect(result!.chain.map((c) => c.id)).toEqual(["v1", "v2"]);
    expect(result!.fact.content).toBe("资深后端工程师");
  });

  it("finds the whole chain when asked about the oldest version, not just the newest", () => {
    const state = stateWith([
      entry({ id: "v1", supersededBy: "v2" }),
      entry({ id: "v2", content: "中级", supersededBy: "v3" }),
      entry({ id: "v3", content: "资深" })
    ]);

    const result = buildFactProvenance(state, "v1");

    expect(result!.chain.map((c) => c.id)).toEqual(["v1", "v2", "v3"]);
  });

  it("reports a retired fact with its reason", () => {
    const state = stateWith([entry({ retiredAt: "t9", retiredReason: "cap_evicted" })]);

    const result = buildFactProvenance(state, "v1");

    expect(result!.fact.retiredAt).toBe("t9");
    expect(result!.fact.retiredReason).toBe("cap_evicted");
    expect(result!.chain).toHaveLength(1);
  });

  it("returns null for an unknown fact id", () => {
    expect(buildFactProvenance(stateWith([]), "nope")).toBeNull();
  });

  it("does not loop forever on a self-referential chain", () => {
    const state = stateWith([entry({ id: "v1", supersededBy: "v1" })]);

    const result = buildFactProvenance(state, "v1");

    expect(result!.chain.map((c) => c.id)).toEqual(["v1"]);
  });
});

describe("normalizeSelectionLog", () => {
  it("returns empty arrays when the digest predates the feature", () => {
    expect(normalizeSelectionLog(null)).toEqual({ rationale: [], drops: [] });
  });

  it("passes through a recorded log", () => {
    const log = {
      rationale: ["selected_docs:2"],
      drops: [{ reason: "cap_evicted", detail: { facet: "notes" } }]
    };
    expect(normalizeSelectionLog(log)).toEqual(log);
  });

  it("discards non-string rationale entries rather than trusting stored JSON", () => {
    expect(normalizeSelectionLog({ rationale: ["ok", 42, null], drops: "not-an-array" })).toEqual({
      rationale: ["ok"],
      drops: []
    });
  });
});
