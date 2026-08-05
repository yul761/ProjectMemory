import { describe, it, expect } from "vitest";
import { computeDriftMetrics } from "./drift-metrics";
import type { DigestState } from "./digest-control";

const base: DigestState = {
  stableFacts: {
    goal: "ship beta runtime",
    decisions: ["use postgres", "ship cli first"],
    constraints: ["self-hosted first"]
  },
  workingNotes: {},
  todos: []
};

describe("computeDriftMetrics", () => {
  it("returns stabilityScore 1.0 when nothing changes", () => {
    const result = computeDriftMetrics(base, base);
    expect(result.goalChanged).toBe(false);
    expect(result.decisionsAdded).toBe(0);
    expect(result.decisionsRemoved).toBe(0);
    expect(result.constraintsAdded).toBe(0);
    expect(result.constraintsRemoved).toBe(0);
    expect(result.todosAdded).toBe(0);
    expect(result.todosRemoved).toBe(0);
    expect(result.stabilityScore).toBe(1);
  });

  it("detects goal change", () => {
    const after: DigestState = { ...base, stableFacts: { ...base.stableFacts, goal: "ship alpha" } };
    const result = computeDriftMetrics(base, after);
    expect(result.goalChanged).toBe(true);
    expect(result.stabilityScore).toBeLessThan(1);
  });

  it("counts decisions added and removed", () => {
    const after: DigestState = {
      ...base,
      stableFacts: { ...base.stableFacts, decisions: ["use postgres", "use onnx for inference"] }
    };
    const result = computeDriftMetrics(base, after);
    expect(result.decisionsAdded).toBe(1);
    expect(result.decisionsRemoved).toBe(1);
  });

  it("counts constraints added and removed", () => {
    const after: DigestState = {
      ...base,
      stableFacts: { ...base.stableFacts, constraints: ["keep api stable"] }
    };
    const result = computeDriftMetrics(base, after);
    expect(result.constraintsAdded).toBe(1);
    expect(result.constraintsRemoved).toBe(1);
  });

  it("counts todos added and removed", () => {
    const before: DigestState = { ...base, todos: ["write docs"] };
    const after: DigestState = { ...base, todos: ["write tests"] };
    const result = computeDriftMetrics(before, after);
    expect(result.todosAdded).toBe(1);
    expect(result.todosRemoved).toBe(1);
  });

  it("returns stabilityScore 1.0 when before is null", () => {
    const result = computeDriftMetrics(null, base);
    expect(result.stabilityScore).toBe(1);
    expect(result.goalChanged).toBe(false);
    expect(result.decisionsAdded).toBe(0);
  });

  it("stabilityScore reflects proportion of changed tracked items", () => {
    // before: 2 decisions + 1 constraint + 1 goal = 4 tracked
    // after: remove 1 decision → 1 changed → stabilityScore = 1 - 1/4 = 0.75
    const after: DigestState = {
      ...base,
      stableFacts: { ...base.stableFacts, decisions: ["use postgres"] }
    };
    const result = computeDriftMetrics(base, after);
    expect(result.decisionsRemoved).toBe(1);
    expect(result.stabilityScore).toBeCloseTo(0.75);
  });
});

describe("computeDriftMetrics — fact registry observation", () => {
  // The profile facets are where user facts actually live. Drift measured only
  // over stableFacts could not see them at all, so "no drift" was a claim about
  // a data model the facts were not in.
  function withFacts(entries: Array<Record<string, unknown>>): DigestState {
    return { stableFacts: {}, workingNotes: {}, todos: [], factRegistry: entries } as unknown as DigestState;
  }

  const fact = (over: Record<string, unknown> = {}) => ({
    id: "a",
    content: "旧",
    type: "profile",
    confidence: 0.7,
    addedAt: "t0",
    evidenceId: "e",
    evidenceType: "event",
    ...over
  });

  it("counts added, retired and superseded facts", () => {
    const before = withFacts([fact()]);
    const after = withFacts([
      fact({ retiredAt: "t1", retiredReason: "cap_evicted" }),
      fact({ id: "b", content: "新", addedAt: "t1" })
    ]);

    const m = computeDriftMetrics(before, after);
    expect(m.factsAdded).toBe(1);
    expect(m.factsRetired).toBe(1);
    expect(m.factsSuperseded).toBe(0);
  });

  it("counts a supersession without counting it as a retirement", () => {
    const before = withFacts([fact()]);
    const after = withFacts([fact({ supersededBy: "b" }), fact({ id: "b", content: "修正后", addedAt: "t1" })]);

    const m = computeDriftMetrics(before, after);
    expect(m.factsSuperseded).toBe(1);
    expect(m.factsRetired).toBe(0);
    expect(m.factsAdded).toBe(1);
  });

  it("does not re-count a fact that was already retired before this run", () => {
    const before = withFacts([fact({ retiredAt: "t1", retiredReason: "cap_evicted" })]);
    const after = withFacts([fact({ retiredAt: "t1", retiredReason: "cap_evicted" })]);

    expect(computeDriftMetrics(before, after).factsRetired).toBe(0);
  });

  it("treats every fact as added when there is no previous state", () => {
    const m = computeDriftMetrics(null, withFacts([fact(), fact({ id: "b" })]));
    expect(m.factsAdded).toBe(2);
    expect(m.factsRetired).toBe(0);
    expect(m.factsSuperseded).toBe(0);
  });

  it("reports zeros for a state with no fact registry at all", () => {
    const m = computeDriftMetrics(base, base);
    expect(m.factsAdded).toBe(0);
    expect(m.factsRetired).toBe(0);
    expect(m.factsSuperseded).toBe(0);
  });
});
