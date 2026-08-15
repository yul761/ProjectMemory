import { describe, it, expect } from "vitest";
import {
  computeFactKey,
  factToGroup,
  flattenScopeFacts,
  groupFactsForDisplay,
  pruneForgottenFacts
} from "./memory-facts";
import type { DigestState } from "./digest-control";
import type { FacetPack } from "./facet-registry";

describe("computeFactKey", () => {
  it("is stable across case and whitespace differences", () => {
    expect(computeFactKey("People", "Call the supplier")).toBe(
      computeFactKey("people", "  call   the   supplier ")
    );
  });
  it("differs when content or group differs", () => {
    expect(computeFactKey("People", "Call the supplier")).not.toBe(
      computeFactKey("People", "Call the dentist")
    );
    expect(computeFactKey("People", "x")).not.toBe(computeFactKey("Projects", "x"));
  });
  it("returns a 16-char hex string", () => {
    expect(computeFactKey("People", "x")).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("factToGroup", () => {
  it("maps engine facets to display groups", () => {
    expect(factToGroup("relationships")).toBe("People");
    expect(factToGroup("style")).toBe("Style");
    expect(factToGroup("goals")).toBe("Projects");
    expect(factToGroup("ongoing")).toBe("Projects");
    expect(factToGroup("followUps")).toBe("Schedule");
  });
  it("returns null for identity and unknown facets", () => {
    expect(factToGroup("identity")).toBeNull();
    expect(factToGroup("nope")).toBeNull();
  });
});

describe("flattenScopeFacts", () => {
  it("includes profile facets and profile-type factRegistry, skips identity and non-profile factRegistry", () => {
    const state: DigestState = {
      stableFacts: { decisions: [] },
      workingNotes: {},
      todos: [],
      factRegistry: [
        { id: "f1", content: "Launching Remi in July", type: "profile", confidence: 0.85, addedAt: "2026-06-20T00:00:00.000Z", evidenceId: "ev1", evidenceType: "event", facet: "goals" },
        { id: "f2", content: "internal decision", type: "decision", confidence: 0.7, addedAt: "2026-06-20T00:00:00.000Z", evidenceId: "ev2", evidenceType: "event" }
      ],
      profile: {
        identity: ["Name is Yuchen"],
        relationships: ["Call the supplier about Q3"],
        style: ["Prefers meetings after 2pm"]
      }
    };
    const facts = flattenScopeFacts(state);
    const texts = facts.map((f) => f.text).sort();
    expect(texts).toEqual([
      "Call the supplier about Q3",
      "Launching Remi in July",
      "Prefers meetings after 2pm"
    ]);
    expect(facts.find((f) => f.text === "internal decision")).toBeUndefined();
    expect(facts.find((f) => f.text === "Name is Yuchen")).toBeUndefined();
    const goal = facts.find((f) => f.text === "Launching Remi in July")!;
    expect(goal.group).toBe("Projects");
    expect(goal.evidenceId).toBe("ev1");
    expect(goal.createdAt).toBe("2026-06-20T00:00:00.000Z");
    const supplier = facts.find((f) => f.text === "Call the supplier about Q3")!;
    expect(supplier.group).toBe("People");
    expect(supplier.createdAt).toBeNull();
  });

  // Regression: source 1 (factRegistry entries, above) resolved a facet's
  // display group against the `pack` argument; source 2 (bare `state.profile`
  // strings) called `factToGroup(facet)` with no pack, silently defaulting to
  // `getDefaultFacetPack()`. Invisible while every deployment used the
  // default pack (facet lookup landed in the same pack either way); apps/mcp
  // selects a non-default "project" pack, so a bare profile-facet fact whose
  // facet exists only in that pack was silently dropped — `factToGroup`
  // found no such facet in the default pack and returned null, and the
  // `!group` branch discards with no drop-log entry. Fixed by passing `pack`
  // through, matching source 1.
  it("resolves bare profile-facet strings against a non-default pack, not the default pack", () => {
    const projectPack: FacetPack = {
      name: "project",
      facets: [
        { name: "milestone", cap: 8, writeProtected: false, displayGroup: "Milestones", description: "Project milestones" }
      ]
    };
    const state: DigestState = {
      stableFacts: { decisions: [] },
      workingNotes: {},
      todos: [],
      factRegistry: [],
      profile: { milestone: ["Ship v1 by end of quarter"] }
    };

    // "milestone" has no group in the default pack — the pre-fix behavior
    // silently dropped it.
    expect(factToGroup("milestone")).toBeNull();
    expect(flattenScopeFacts(state)).toEqual([]);

    // Resolved against the pack it actually belongs to, the fact survives and
    // lands in the pack's own display group.
    const facts = flattenScopeFacts(state, undefined, projectPack);
    expect(facts).toHaveLength(1);
    expect(facts[0].text).toBe("Ship v1 by end of quarter");
    expect(facts[0].group).toBe("Milestones");
  });

  it("dedups a fact present in both factRegistry and profile, preferring the factRegistry entry", () => {
    const state: DigestState = {
      stableFacts: { decisions: [] },
      workingNotes: {},
      todos: [],
      factRegistry: [
        { id: "f1", content: "Launching Remi in July", type: "profile", confidence: 0.85, addedAt: "2026-06-20T00:00:00.000Z", evidenceId: "ev1", evidenceType: "event", facet: "goals" }
      ],
      profile: { goals: ["Launching Remi in July"] }
    };
    const facts = flattenScopeFacts(state);
    expect(facts).toHaveLength(1);
    expect(facts[0].evidenceId).toBe("ev1");
  });
});

describe("groupFactsForDisplay", () => {
  it("orders groups and omits empty ones", () => {
    const facts = [
      { factKey: "a", text: "Prefers meetings after 2pm", group: "Style" as const, createdAt: null },
      { factKey: "b", text: "Call the supplier", group: "People" as const, createdAt: null }
    ];
    const groups = groupFactsForDisplay(facts);
    expect(groups.map((g) => g.group)).toEqual(["People", "Style"]);
    expect(groups[0].items[0]).toEqual({ factKey: "b", text: "Call the supplier", createdAt: null });
  });
});

describe("pruneForgottenFacts", () => {
  function baseState(): DigestState {
    return {
      stableFacts: { decisions: [] },
      workingNotes: {},
      todos: [],
      factRegistry: [
        { id: "f1", content: "Launching Remi in July", type: "profile", confidence: 0.85, addedAt: "2026-06-20T00:00:00.000Z", evidenceId: "ev1", evidenceType: "event", facet: "goals" },
        { id: "f2", content: "internal decision", type: "decision", confidence: 0.7, addedAt: "2026-06-20T00:00:00.000Z", evidenceId: "ev2", evidenceType: "event" }
      ],
      profile: {
        identity: ["Name is Yuchen"],
        relationships: ["Call the supplier about Q3"],
        style: ["Prefers meetings after 2pm"]
      }
    };
  }

  it("removes a bare profile-facet value whose key is forgotten", () => {
    const state = baseState();
    const key = computeFactKey("People", "Call the supplier about Q3"); // relationships → People
    pruneForgottenFacts(state, new Set([key]));
    expect(state.profile!.relationships).toEqual([]);
    expect(state.profile!.style).toEqual(["Prefers meetings after 2pm"]); // untouched
  });

  it("removes a profile-type factRegistry entry whose key is forgotten", () => {
    const state = baseState();
    const key = computeFactKey("Projects", "Launching Remi in July"); // goals → Projects
    pruneForgottenFacts(state, new Set([key]));
    expect(state.factRegistry!.find((e) => e.id === "f1")).toBeUndefined();
    expect(state.factRegistry!.find((e) => e.id === "f2")).toBeDefined(); // non-profile decision kept
  });

  it("never prunes identity (factToGroup → null) and is a no-op for an empty set", () => {
    const state = baseState();
    const idKey = computeFactKey("identity", "Name is Yuchen");
    pruneForgottenFacts(state, new Set([idKey])); // identity isn't a display group → no match
    expect(state.profile!.identity).toEqual(["Name is Yuchen"]);
    const before = JSON.stringify(baseState());
    const s2 = baseState();
    pruneForgottenFacts(s2, new Set());
    expect(JSON.stringify(s2)).toEqual(before); // empty set = no change
  });

  it("leaves non-matching content untouched", () => {
    const state = baseState();
    pruneForgottenFacts(state, new Set([computeFactKey("People", "someone else")]));
    expect(state.profile!.relationships).toEqual(["Call the supplier about Q3"]);
  });
});
