import { describe, it, expect } from "vitest";
import { applyFacetConsolidation } from "./facet-consolidation";
import { getActiveFactRegistry, type DigestState, type FactRegistryEntry } from "./digest-control";

function entry(id: string, content: string): FactRegistryEntry {
  return {
    id,
    content,
    type: "profile",
    confidence: 0.85,
    addedAt: `2026-01-0${id.slice(-1)}T00:00:00.000Z`,
    evidenceId: `doc-${id}`,
    evidenceType: "document",
    facet: "identity"
  };
}

function stateWith(contents: string[]): DigestState {
  return {
    stableFacts: {},
    factRegistry: contents.map((c, i) => entry(`f${i + 1}`, c)),
    profile: { identity: [...contents] }
  } as unknown as DigestState;
}

const ids = () => {
  let n = 0;
  return () => `new-${++n}`;
};
const NOW = () => "2026-08-05T00:00:00.000Z";

describe("consolidation preserves the audit chain", () => {
  it("supersedes merged sources instead of deleting their records", () => {
    // Consolidation runs on every digest that touched a facet — far more often
    // than capacity eviction — so deleting records here silently broke the chain
    // on the common path, not the rare one.
    const state = stateWith(["技能: TypeScript, Go", "技能: PostgreSQL"]);

    const ok = applyFacetConsolidation(
      state,
      "identity",
      ["技能: TypeScript, Go", "技能: PostgreSQL"],
      [{ text: "技能: TypeScript, Go, PostgreSQL", mergedFrom: [0, 1] }],
      ids(),
      NOW
    );

    expect(ok).toBe(true);
    // Both originals still on the record, both pointing at the merged entry.
    const originals = state.factRegistry!.filter((e) => e.id === "f1" || e.id === "f2");
    expect(originals).toHaveLength(2);
    expect(originals.every((e) => e.supersededBy === "new-1")).toBe(true);
    // Only the consolidated entry is active.
    const active = getActiveFactRegistry(state);
    expect(active.map((e) => e.content)).toEqual(["技能: TypeScript, Go, PostgreSQL"]);
  });

  it("retires a source that consolidation dropped entirely", () => {
    const state = stateWith(["保留这条", "被丢弃这条"]);

    applyFacetConsolidation(
      state,
      "identity",
      ["保留这条", "被丢弃这条"],
      [{ text: "保留这条", mergedFrom: [0] }],
      ids(),
      NOW
    );

    const dropped = state.factRegistry!.find((e) => e.id === "f2");
    expect(dropped).toBeDefined();
    expect(dropped!.retiredAt).toBe("2026-08-05T00:00:00.000Z");
    expect(dropped!.retiredReason).toBe("consolidation_dropped");
    expect(getActiveFactRegistry(state)).toHaveLength(1);
  });

  it("leaves other facets' records untouched", () => {
    const state = stateWith(["技能: Go"]);
    state.factRegistry!.push({ ...entry("other", "妈妈住在上海"), facet: "relationships" });

    applyFacetConsolidation(
      state,
      "identity",
      ["技能: Go"],
      [{ text: "技能: Golang", mergedFrom: [0] }],
      ids(),
      NOW
    );

    const other = state.factRegistry!.find((e) => e.id === "other");
    expect(other!.supersededBy).toBeUndefined();
    expect(other!.retiredAt).toBeUndefined();
  });
});
