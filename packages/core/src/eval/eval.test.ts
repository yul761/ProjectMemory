import { describe, it, expect } from "vitest";
import { runAllScenarios, runScenario } from "./runner";
import { scenarios } from "./scenarios";
import { longRunningProject } from "./scenarios/long-running-project";
import { decisionRevision } from "./scenarios/decision-revision";
import { goalStability } from "./scenarios/goal-stability";
import { retrievalQuality } from "./scenarios/retrieval-quality";

describe("memory engine benchmark", () => {
  it("long_running_project: retains goal, constraints, and decisions after noise", async () => {
    const r = await runScenario(longRunningProject);

    console.log("\n=== long_running_project ===");
    console.log("Survived decisions:", r.details.survivedDecisions);
    console.log("Missing decisions:", r.details.missingDecisions);
    console.log("Goal survived:", r.details.goalSurvived, `(${r.details.goalActual})`);
    console.log("Metrics:", r.metrics);

    expect(r.metrics.factRetentionRate).toBeGreaterThanOrEqual(0.75);
    expect(r.metrics.goalStabilityRate).toBe(1);
    expect(r.metrics.decisionContinuityRate).toBeGreaterThanOrEqual(0.75);
    expect(r.metrics.overallScore).toBeGreaterThanOrEqual(0.75);
  });

  it("decision_revision: replaces conflicting decision and preserves unrelated one", async () => {
    const r = await runScenario(decisionRevision);

    console.log("\n=== decision_revision ===");
    console.log("Missing decisions (should be empty):", r.details.missingDecisions);
    console.log("Absent decisions wrongly present:", r.details.absentDecisionsPresent);
    console.log("Metrics:", r.metrics);

    expect(r.metrics.conflictResolutionAccuracy).toBe(1);
    expect(r.metrics.decisionContinuityRate).toBeGreaterThanOrEqual(0.8);
  });

  it("goal_stability: goal unchanged after 15 noise events with unrelated goal mentions", async () => {
    const r = await runScenario(goalStability);

    console.log("\n=== goal_stability ===");
    console.log("Goal expected:", r.details.goalExpected);
    console.log("Goal actual:", r.details.goalActual);
    console.log("Goal survived:", r.details.goalSurvived);

    expect(r.metrics.goalStabilityRate).toBe(1);
  });

  it("retrieval_quality: relevant events rank in top-3 for database query", async () => {
    const r = await runScenario(retrievalQuality);

    console.log("\n=== retrieval_quality ===");
    console.log("Query results:", r.details.queryResults);
    console.log("MRR:", r.metrics.retrievalMRR);

    expect(r.metrics.retrievalMRR).toBeGreaterThanOrEqual(0.5);
    const firstRank = r.details.queryResults[0]?.firstRelevantRank;
    expect(firstRank).not.toBeNull();
    expect(firstRank!).toBeLessThanOrEqual(3);
  });

  it("overall benchmark score >= 0.75 across all scenarios", async () => {
    const results = await runAllScenarios(scenarios);
    const avgScore = results.reduce((sum, r) => sum + r.metrics.overallScore, 0) / results.length;

    console.log("\n=== OVERALL BENCHMARK ===");
    for (const r of results) {
      console.log(`${r.scenario}: ${r.metrics.overallScore.toFixed(3)} (retention=${r.metrics.factRetentionRate}, goal=${r.metrics.goalStabilityRate}, conflict=${r.metrics.conflictResolutionAccuracy}, MRR=${r.metrics.retrievalMRR})`);
    }
    console.log(`Average score: ${avgScore.toFixed(3)}`);

    expect(avgScore).toBeGreaterThanOrEqual(0.75);
  });
});
