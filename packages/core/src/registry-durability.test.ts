import { describe, it, expect } from "vitest";
import { protectedStateMerge, type DigestState, type FactRegistryEntry } from "./digest-control";

function entry(over: Partial<FactRegistryEntry> = {}): FactRegistryEntry {
  return {
    id: "f1",
    content: "工作经历: 字节跳动 后端工程师",
    type: "profile",
    confidence: 0.85,
    addedAt: "2026-01-01T00:00:00.000Z",
    evidenceId: "doc-1",
    evidenceType: "document",
    facet: "identity",
    ...over
  };
}

describe("the audit chain survives the next digest", () => {
  it("keeps superseded entries when the previous state is loaded", () => {
    // protectedStateMerge normalises the incoming state. If normalisation drops
    // superseded entries, the provenance API works only until the next digest
    // runs — which is to say, not at all.
    const prevState = {
      stableFacts: {},
      todos: [],
      factRegistry: [
        entry({ id: "v1", content: "后端工程师", supersededBy: "v2" }),
        entry({ id: "v2", content: "资深后端工程师" })
      ],
      profile: { identity: ["资深后端工程师"] }
    } as unknown as DigestState;

    const merged = protectedStateMerge({ prevState, deltaCandidates: [], documents: [] });

    const ids = (merged.factRegistry ?? []).map((e) => e.id);
    expect(ids).toContain("v1");
    expect(ids).toContain("v2");
  });

  it("keeps retired entries when the previous state is loaded", () => {
    const prevState = {
      stableFacts: {},
      todos: [],
      factRegistry: [
        entry({ id: "r1", content: "被淘汰的笔记", retiredAt: "2026-08-01T00:00:00.000Z", retiredReason: "cap_evicted" })
      ],
      profile: {}
    } as unknown as DigestState;

    const merged = protectedStateMerge({ prevState, deltaCandidates: [], documents: [] });

    expect((merged.factRegistry ?? []).map((e) => e.id)).toContain("r1");
  });

  it("never drops an active fact, however many there are", () => {
    const many = Array.from({ length: 600 }, (_, i) => entry({ id: `a${i}`, content: `事实 ${i}` }));
    const merged = protectedStateMerge({
      prevState: { stableFacts: {}, todos: [], factRegistry: many, profile: {} } as unknown as DigestState,
      deltaCandidates: [],
      documents: []
    });

    expect(merged.factRegistry).toHaveLength(600);
  });

  it("bounds history but keeps the most recent, and keeps every active fact alongside it", () => {
    const history = Array.from({ length: 700 }, (_, i) =>
      entry({ id: `h${i}`, content: `旧事实 ${i}`, supersededBy: `h${i + 1}` })
    );
    const active = Array.from({ length: 20 }, (_, i) => entry({ id: `a${i}`, content: `现行事实 ${i}` }));
    const merged = protectedStateMerge({
      prevState: {
        stableFacts: {},
        todos: [],
        factRegistry: [...history, ...active],
        profile: {}
      } as unknown as DigestState,
      deltaCandidates: [],
      documents: []
    });

    const ids = (merged.factRegistry ?? []).map((e) => e.id);
    // All 20 active facts survive.
    expect(ids.filter((id) => id.startsWith("a"))).toHaveLength(20);
    // History is capped at the most recent 500, oldest trimmed first.
    expect(ids.filter((id) => id.startsWith("h"))).toHaveLength(500);
    expect(ids).toContain("h699");
    expect(ids).not.toContain("h0");
  });
});
