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
