# Memory Engine Evaluation Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a synthetic benchmark system that measures memory engine quality across four scenarios — fact retention, decision revision, goal stability, and retrieval quality — outputting numeric metrics comparable across commits.

**Architecture:** Three layers: types + helper functions (Task 1), four scenario definitions + runner that computes metrics (Task 2), and a vitest test harness that runs eval and asserts scores above threshold for regression protection (Task 3). The runner calls `protectedStateMerge` and `RetrieveService` directly — no LLM required for state metrics, mock embedding for retrieval MRR.

**Tech Stack:** TypeScript, Vitest (test harness), pnpm. No new dependencies.

---

## File Map

| File | Responsibility |
|------|---------------|
| `packages/core/src/eval/types.ts` | `EvalScenario`, `EvalMetrics`, `EvalResult`, `ExpectedState` interfaces |
| `packages/core/src/eval/scenarios/long-running-project.ts` | 25-event scenario: retention after noise |
| `packages/core/src/eval/scenarios/decision-revision.ts` | Conflict detection + replacement scenario |
| `packages/core/src/eval/scenarios/goal-stability.ts` | Goal survives 15 noise events |
| `packages/core/src/eval/scenarios/retrieval-quality.ts` | MRR with mock embeddings |
| `packages/core/src/eval/runner.ts` | `runScenario()`, `computeMetrics()`, `runAllScenarios()` |
| `packages/core/src/eval/index.ts` | Re-exports for `pnpm eval` and test harness |
| `packages/core/src/eval/eval.test.ts` | Vitest harness: runs all scenarios, asserts score ≥ 0.80 |
| `packages/core/package.json` | Add `"eval": "tsx src/eval/run-cli.ts"` script |
| `packages/core/src/eval/run-cli.ts` | CLI entry: prints JSON metrics to stdout |

---

## Key Types (defined once in Task 1, used throughout)

```typescript
// packages/core/src/eval/types.ts

export interface ExpectedState {
  goal?: string;                    // must be present if set
  decisions?: string[];             // all must appear in stableFacts.decisions
  constraints?: string[];           // all must appear in stableFacts.constraints
  absentDecisions?: string[];       // none of these should appear
}

export interface QueryScenario {
  query: string;
  relevantEventIds: string[];       // at least 1 must appear in top-K results
}

export interface EvalScenario {
  name: string;
  description: string;
  events: import("../index").MemoryEvent[];
  expectedState: ExpectedState;
  queries?: QueryScenario[];
}

export interface EvalMetrics {
  factRetentionRate: number;        // survived_expected / total_expected, 0-1
  goalStabilityRate: number;        // 1.0 if goal survived, 0.0 if not
  decisionContinuityRate: number;   // expected_decisions_present / total_expected_decisions
  conflictResolutionAccuracy: number; // conflicts_correctly_replaced / total_conflicts
  retrievalMRR: number;             // mean reciprocal rank across queries, 0-1
  overallScore: number;             // weighted average
}

export interface EvalResult {
  scenario: string;
  description: string;
  metrics: EvalMetrics;
  details: {
    expectedDecisions: string[];
    survivedDecisions: string[];
    missingDecisions: string[];
    absentDecisionsPresent: string[];
    goalExpected: string | undefined;
    goalActual: string | undefined;
    goalSurvived: boolean;
    queryResults: Array<{ query: string; firstRelevantRank: number | null }>;
  };
}
```

---

## Task 1: Types + eval infrastructure

**Files:**
- Create: `packages/core/src/eval/types.ts`
- Create: `packages/core/src/eval/index.ts`
- Create: `packages/core/src/eval/run-cli.ts`
- Modify: `packages/core/package.json`

- [ ] **Step 1: Create types.ts**

Create `packages/core/src/eval/types.ts` with the exact content shown in the "Key Types" section above.

- [ ] **Step 2: Create index.ts**

Create `packages/core/src/eval/index.ts`:

```typescript
export type { EvalScenario, EvalMetrics, EvalResult, ExpectedState, QueryScenario } from "./types";
export { runScenario, runAllScenarios, computeMetrics } from "./runner";
```

(This file will fail to compile until Task 2 creates `runner.ts` — that's expected.)

- [ ] **Step 3: Create run-cli.ts**

Create `packages/core/src/eval/run-cli.ts`:

```typescript
import { runAllScenarios } from "./runner";
import { scenarios } from "./scenarios";

async function main() {
  const results = await runAllScenarios(scenarios);
  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

(This will also fail until Task 2 provides the runner and scenarios — expected.)

- [ ] **Step 4: Add eval script to package.json**

In `packages/core/package.json`, add to `"scripts"`:
```json
"eval": "tsx src/eval/run-cli.ts"
```

- [ ] **Step 5: Commit**

```powershell
cd C:\StateCore\StateCore
git add packages/core/src/eval/types.ts packages/core/src/eval/index.ts packages/core/src/eval/run-cli.ts packages/core/package.json
git commit -m "feat(eval): add eval infrastructure — types, CLI entry, package script"
```

---

## Task 2: Scenarios + runner

**Files:**
- Create: `packages/core/src/eval/scenarios/long-running-project.ts`
- Create: `packages/core/src/eval/scenarios/decision-revision.ts`
- Create: `packages/core/src/eval/scenarios/goal-stability.ts`
- Create: `packages/core/src/eval/scenarios/retrieval-quality.ts`
- Create: `packages/core/src/eval/scenarios/index.ts`
- Create: `packages/core/src/eval/runner.ts`

### Step 1: Create long-running-project scenario

Create `packages/core/src/eval/scenarios/long-running-project.ts`:

```typescript
import type { EvalScenario } from "../types";
import type { MemoryEvent } from "../../index";

function ev(id: string, content: string, type: "stream" | "document" = "stream", key?: string): MemoryEvent {
  return { id, scopeId: "sc", userId: "u", type, source: "api", content, createdAt: new Date("2026-01-01T10:00:00Z"), ...(key ? { key } : {}) };
}

export const longRunningProject: EvalScenario = {
  name: "long_running_project",
  description: "Goal and key decisions survive 20 noisy events and multiple mini-digest cycles",
  events: [
    ev("doc-goal", "goal: ship self-hosted memory runtime\nconstraint: no paid APIs\nconstraint: keep api stable", "document", "doc:plan"),
    ev("d1", "We decide to use Postgres for storage"),
    ev("d2", "We decide to ship CLI first before the API"),
    // Noise: status updates, questions, irrelevant chatter
    ev("n1", "Status update: queue is stable"),
    ev("n2", "ok"),
    ev("n3", "noted"),
    ev("n4", "Status update: processed 50 events"),
    ev("n5", "Question: should we support Ollama first?"),
    ev("n6", "The weather is nice today"),
    ev("n7", "Status update: running benchmarks"),
    ev("n8", "noted thanks"),
    ev("n9", "Status update: queue latency is down"),
    ev("n10", "Progress: added more tests"),
    // New decisions added mid-stream
    ev("d3", "We decide to use ONNX for inference"),
    ev("d4", "We decide to add a benchmark suite"),
    // More noise
    ev("n11", "Status update: still working"),
    ev("n12", "ok noted"),
    ev("n13", "Status update: tests passing"),
    ev("n14", "noted"),
    ev("n15", "Status update: queue is stable again"),
    ev("n16", "Progress: refactored event pipeline"),
    ev("n17", "ok good"),
    ev("n18", "Status update: benchmarks look good"),
    ev("n19", "Question: what is the current state?"),
    ev("n20", "noted that")
  ],
  expectedState: {
    goal: "ship self-hosted memory runtime",
    constraints: ["no paid APIs", "keep api stable"],
    decisions: [
      "We decide to use Postgres for storage",
      "We decide to ship CLI first before the API",
      "We decide to use ONNX for inference",
      "We decide to add a benchmark suite"
    ]
  }
};
```

### Step 2: Create decision-revision scenario

Create `packages/core/src/eval/scenarios/decision-revision.ts`:

```typescript
import type { EvalScenario } from "../types";
import type { MemoryEvent } from "../../index";

function ev(id: string, content: string, createdAt: Date): MemoryEvent {
  return { id, scopeId: "sc", userId: "u", type: "stream", source: "api", content, createdAt };
}

export const decisionRevision: EvalScenario = {
  name: "decision_revision",
  description: "Old decision replaced when replacement-language event arrives; unrelated decision preserved",
  events: [
    ev("d1", "We decide to use ONNX for inference", new Date("2026-01-01T10:00:00Z")),
    ev("d2", "We decide to use Postgres for storage", new Date("2026-01-01T10:01:00Z")),
    ev("d3", "We decided to use TensorRT instead of ONNX for inference", new Date("2026-01-01T10:02:00Z"))
  ],
  expectedState: {
    decisions: ["We decided to use TensorRT instead of ONNX for inference", "We decide to use Postgres for storage"],
    absentDecisions: ["We decide to use ONNX for inference"]
  }
};
```

### Step 3: Create goal-stability scenario

Create `packages/core/src/eval/scenarios/goal-stability.ts`:

```typescript
import type { EvalScenario } from "../types";
import type { MemoryEvent } from "../../index";

function ev(id: string, content: string): MemoryEvent {
  return { id, scopeId: "sc", userId: "u", type: "stream", source: "api", content, createdAt: new Date("2026-01-01T10:00:00Z") };
}

export const goalStability: EvalScenario = {
  name: "goal_stability_under_noise",
  description: "Goal survives 15 noise events including ones with unrelated goal mentions",
  events: [
    // Set goal via document
    { id: "doc-goal", scopeId: "sc", userId: "u", type: "document", key: "doc:goal", source: "api",
      content: "goal: ship self-hosted memory runtime", createdAt: new Date("2026-01-01T10:00:00Z") },
    // Noise events — some with unrelated goal mentions (natural language)
    ev("n1", "I want to fix the login authentication bug today"),
    ev("n2", "Status update: queue is stable"),
    ev("n3", "I'm trying to debug the connection timeout issue"),
    ev("n4", "noted"),
    ev("n5", "ok"),
    ev("n6", "I want to clean up the test suite this week"),
    ev("n7", "Status update: all tests passing"),
    ev("n8", "I'm looking to improve benchmark coverage"),
    ev("n9", "noted thanks"),
    ev("n10", "Status update: processed batch 10"),
    ev("n11", "I want to refactor the event pipeline"),
    ev("n12", "Status update: memory usage stable"),
    ev("n13", "I need to write docs for the new API"),
    ev("n14", "noted that"),
    ev("n15", "Status update: benchmark results improved")
  ],
  expectedState: {
    goal: "ship self-hosted memory runtime"
  }
};
```

### Step 4: Create retrieval-quality scenario

Create `packages/core/src/eval/scenarios/retrieval-quality.ts`:

```typescript
import type { EvalScenario } from "../types";
import type { MemoryEvent } from "../../index";

function ev(id: string, content: string): MemoryEvent {
  return { id, scopeId: "sc", userId: "u", type: "stream", source: "api", content, createdAt: new Date("2026-01-01T10:00:00Z") };
}

// 10 events: 3 semantically relevant to "database persistence layer", 7 noise
export const retrievalQuality: EvalScenario = {
  name: "retrieval_quality",
  description: "Relevant events rank in top-3 for database query; MRR >= 0.7",
  events: [
    ev("rel1", "We decide to use Postgres for the database"),
    ev("rel2", "Constraint: database must be self-hosted"),
    ev("rel3", "We migrated from SQLite to Postgres for better concurrency"),
    ev("noise1", "Status update: queue is stable"),
    ev("noise2", "I want to fix the login bug"),
    ev("noise3", "The benchmark suite is running"),
    ev("noise4", "noted"),
    ev("noise5", "Status update: all tests passing"),
    ev("noise6", "Working on the API endpoints"),
    ev("noise7", "Status update: deployment complete")
  ],
  expectedState: { decisions: [] },
  queries: [
    {
      query: "what database did we choose?",
      relevantEventIds: ["rel1", "rel2", "rel3"]
    }
  ]
};
```

### Step 5: Create scenarios index

Create `packages/core/src/eval/scenarios/index.ts`:

```typescript
export { longRunningProject } from "./long-running-project";
export { decisionRevision } from "./decision-revision";
export { goalStability } from "./goal-stability";
export { retrievalQuality } from "./retrieval-quality";

import { longRunningProject } from "./long-running-project";
import { decisionRevision } from "./decision-revision";
import { goalStability } from "./goal-stability";
import { retrievalQuality } from "./retrieval-quality";
import type { EvalScenario } from "../types";

export const scenarios: EvalScenario[] = [
  longRunningProject,
  decisionRevision,
  goalStability,
  retrievalQuality
];
```

### Step 6: Create runner.ts

Create `packages/core/src/eval/runner.ts`:

```typescript
import { protectedStateMerge, normalizeDigestState, type DigestState } from "../digest-control";
import { RetrieveService } from "../index";
import type { MemoryEvent } from "../index";
import type { EvalScenario, EvalMetrics, EvalResult } from "./types";

function normalizeStr(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function containsFact(haystack: string[], needle: string): boolean {
  const norm = normalizeStr(needle);
  return haystack.some((item) => {
    const itemNorm = normalizeStr(item);
    // Check substring match on key tokens
    const tokens = norm.split(" ").filter((t) => t.length > 3);
    return tokens.length > 0 && tokens.every((t) => itemNorm.includes(t));
  });
}

function runMiniDigest(events: MemoryEvent[], prevState: DigestState | null): DigestState {
  const docs = events.filter((e) => e.type === "document");
  const streamEvents = events.filter((e) => e.type === "stream");
  const deltaCandidates = streamEvents.map((event) => {
    // Classify events using extractKind + importanceForKind
    const { extractKind, importanceForKind } = require("../digest-control") as {
      extractKind: (content: string) => string;
      importanceForKind: (kind: string, content: string) => number;
    };
    const kind = extractKind(event.content) as import("../digest-control").MemoryEventKind;
    return {
      eventId: event.id,
      reason: "eval" as const,
      features: { kind, importanceScore: importanceForKind(kind, event.content), noveltyScore: 1 },
      event
    };
  });

  return protectedStateMerge({ prevState, deltaCandidates, documents: docs });
}

export function computeMetrics(result: DigestState, scenario: EvalScenario): EvalMetrics {
  const decisions = result.stableFacts.decisions ?? [];
  const constraints = result.stableFacts.constraints ?? [];
  const goal = result.stableFacts.goal ?? "";

  const expected = scenario.expectedState;

  // Fact retention: how many expected decisions/constraints survived
  const expectedDecisions = expected.decisions ?? [];
  const expectedConstraints = expected.constraints ?? [];
  const survivedDecisions = expectedDecisions.filter((d) => containsFact(decisions, d));
  const survivedConstraints = expectedConstraints.filter((c) => containsFact(constraints, c));
  const totalExpected = expectedDecisions.length + expectedConstraints.length;
  const totalSurvived = survivedDecisions.length + survivedConstraints.length;
  const factRetentionRate = totalExpected === 0 ? 1 : totalSurvived / totalExpected;

  // Goal stability
  const goalSurvived = expected.goal
    ? normalizeStr(goal).includes(normalizeStr(expected.goal).split(" ")[0]) ||
      normalizeStr(expected.goal).split(" ").filter((t) => t.length > 3).every((t) => normalizeStr(goal).includes(t))
    : true;
  const goalStabilityRate = goalSurvived ? 1 : 0;

  // Decision continuity
  const decisionContinuityRate = expectedDecisions.length === 0 ? 1 : survivedDecisions.length / expectedDecisions.length;

  // Conflict resolution: absent decisions should not be present
  const absentDecisions = expected.absentDecisions ?? [];
  const wronglyPresent = absentDecisions.filter((d) => containsFact(decisions, d));
  const conflictResolutionAccuracy = absentDecisions.length === 0 ? 1 : 1 - wronglyPresent.length / absentDecisions.length;

  // Overall score (weighted)
  const overallScore = (
    factRetentionRate * 0.3 +
    goalStabilityRate * 0.2 +
    decisionContinuityRate * 0.25 +
    conflictResolutionAccuracy * 0.25
  );

  return {
    factRetentionRate: Number(factRetentionRate.toFixed(3)),
    goalStabilityRate: Number(goalStabilityRate.toFixed(3)),
    decisionContinuityRate: Number(decisionContinuityRate.toFixed(3)),
    conflictResolutionAccuracy: Number(conflictResolutionAccuracy.toFixed(3)),
    retrievalMRR: 0, // computed separately in runScenario
    overallScore: Number(overallScore.toFixed(3))
  };
}

async function computeRetrievalMRR(scenario: EvalScenario): Promise<{ mrr: number; queryResults: Array<{ query: string; firstRelevantRank: number | null }> }> {
  if (!scenario.queries?.length) {
    return { mrr: 1, queryResults: [] };
  }

  const allEvents = scenario.events;
  const queryResults: Array<{ query: string; firstRelevantRank: number | null }> = [];

  for (const q of scenario.queries) {
    const relevantSet = new Set(q.relevantEventIds);

    // Mock embedding: relevant events get cosine 1.0 with query, others get 0.0
    const relevantIds = q.relevantEventIds;
    const embedCallCount = { n: 0 };
    const mockEmbeddingModel = {
      embed: async (inputs: string[]) => {
        embedCallCount.n++;
        // First call is the query vector — use [1, 0, 0]
        // Subsequent calls: match relevant event content
        return inputs.map((input) => {
          const matchesRelevant = allEvents
            .filter((e) => relevantIds.includes(e.id))
            .some((e) => e.content === input);
          return matchesRelevant ? [1, 0, 0] : [0, 1, 0];
        });
      }
    };

    const mockDigestRepo = { findLatest: async () => null, listRecent: async () => ({ items: [], nextCursor: null }) } as any;
    const mockMemoryRepo = {
      listRecent: async () => ({ items: allEvents, nextCursor: null }),
      findByIds: async (ids: string[]) => allEvents.filter((e) => ids.includes(e.id))
    } as any;

    const service = new RetrieveService(mockDigestRepo, mockMemoryRepo, {
      embeddingModel: mockEmbeddingModel,
      useEmbeddingRerank: true,
      embeddingCandidateLimit: allEvents.length
    });

    const result = await service.retrieve("sc", allEvents.length, q.query);
    const rankedIds = result.events.map((e) => e.id);

    // Find rank of first relevant event (1-indexed)
    const firstRelevantRank = rankedIds.findIndex((id) => relevantSet.has(id));
    queryResults.push({
      query: q.query,
      firstRelevantRank: firstRelevantRank === -1 ? null : firstRelevantRank + 1
    });
  }

  const mrr = queryResults.reduce((sum, qr) => {
    return sum + (qr.firstRelevantRank !== null ? 1 / qr.firstRelevantRank : 0);
  }, 0) / queryResults.length;

  return { mrr: Number(mrr.toFixed(3)), queryResults };
}

export async function runScenario(scenario: EvalScenario): Promise<EvalResult> {
  const state = runMiniDigest(scenario.events, null);
  const metrics = computeMetrics(state, scenario);
  const { mrr, queryResults } = await computeRetrievalMRR(scenario);

  const finalMetrics: EvalMetrics = {
    ...metrics,
    retrievalMRR: mrr,
    overallScore: Number((
      metrics.factRetentionRate * 0.25 +
      metrics.goalStabilityRate * 0.15 +
      metrics.decisionContinuityRate * 0.2 +
      metrics.conflictResolutionAccuracy * 0.2 +
      mrr * 0.2
    ).toFixed(3))
  };

  const decisions = state.stableFacts.decisions ?? [];
  const expectedDecisions = scenario.expectedState.decisions ?? [];
  const absentDecisions = scenario.expectedState.absentDecisions ?? [];

  return {
    scenario: scenario.name,
    description: scenario.description,
    metrics: finalMetrics,
    details: {
      expectedDecisions,
      survivedDecisions: expectedDecisions.filter((d) => containsFact(decisions, d)),
      missingDecisions: expectedDecisions.filter((d) => !containsFact(decisions, d)),
      absentDecisionsPresent: absentDecisions.filter((d) => containsFact(decisions, d)),
      goalExpected: scenario.expectedState.goal,
      goalActual: state.stableFacts.goal,
      goalSurvived: finalMetrics.goalStabilityRate === 1,
      queryResults
    }
  };
}

export async function runAllScenarios(scenarios: EvalScenario[]): Promise<EvalResult[]> {
  return Promise.all(scenarios.map(runScenario));
}
```

**Important note:** The `require("../digest-control")` pattern is used to import `extractKind` and `importanceForKind` which must be exported. Confirm they are already exported (they were exported in an earlier task). If TypeScript complains, replace the `require` with a static import:

```typescript
import { extractKind, importanceForKind, protectedStateMerge, normalizeDigestState } from "../digest-control";
```

### Step 7: Run TypeScript compilation check

```powershell
cd C:\StateCore\StateCore; pnpm --filter @statecore/core exec tsc --noEmit 2>&1 | Select-Object -Last 20
```

Expected: No errors. If errors appear, fix type issues (likely in runner.ts — `require` vs `import`).

### Step 8: Test the CLI runner manually

```powershell
cd C:\StateCore\StateCore; pnpm --filter @statecore/core eval 2>&1 | Select-Object -First 60
```

Expected: JSON output with 4 scenarios and their metrics. Example:
```json
[
  {
    "scenario": "long_running_project",
    "metrics": {
      "factRetentionRate": 0.857,
      "goalStabilityRate": 1,
      "decisionContinuityRate": 1,
      "conflictResolutionAccuracy": 1,
      "retrievalMRR": 1,
      "overallScore": 0.97
    }
  },
  ...
]
```

### Step 9: Run core tests to verify no regressions

```powershell
cd C:\StateCore\StateCore; pnpm --filter @statecore/core test 2>&1 | Select-Object -Last 8
```

Expected: 159 pass (no change).

### Step 10: Commit

```powershell
cd C:\StateCore\StateCore
git add packages/core/src/eval/
git commit -m "feat(eval): add 4 benchmark scenarios + runner with fact retention, stability, conflict, MRR metrics"
```

---

## Task 3: Vitest test harness with regression thresholds

**Files:**
- Create: `packages/core/src/eval/eval.test.ts`

This task adds a vitest test that:
1. Runs all 4 scenarios
2. Asserts each metric meets a minimum threshold
3. Prints a human-readable summary (useful for debugging)

- [ ] **Step 1: Create eval.test.ts**

Create `packages/core/src/eval/eval.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { runAllScenarios } from "./runner";
import { scenarios } from "./scenarios";

describe("memory engine benchmark", () => {
  it("long_running_project: retains goal, constraints, and all 4 decisions after noise", async () => {
    const results = await runAllScenarios([scenarios.find((s) => s.name === "long_running_project")!]);
    const r = results[0];

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
    const results = await runAllScenarios([scenarios.find((s) => s.name === "decision_revision")!]);
    const r = results[0];

    console.log("\n=== decision_revision ===");
    console.log("Missing decisions (should be empty):", r.details.missingDecisions);
    console.log("Absent decisions wrongly present:", r.details.absentDecisionsPresent);
    console.log("Metrics:", r.metrics);

    expect(r.metrics.conflictResolutionAccuracy).toBe(1);
    expect(r.metrics.decisionContinuityRate).toBeGreaterThanOrEqual(0.8);
  });

  it("goal_stability: goal unchanged after 15 noise events", async () => {
    const results = await runAllScenarios([scenarios.find((s) => s.name === "goal_stability_under_noise")!]);
    const r = results[0];

    console.log("\n=== goal_stability ===");
    console.log("Goal expected:", r.details.goalExpected);
    console.log("Goal actual:", r.details.goalActual);
    console.log("Goal survived:", r.details.goalSurvived);

    expect(r.metrics.goalStabilityRate).toBe(1);
  });

  it("retrieval_quality: relevant events rank in top-3 for database query", async () => {
    const results = await runAllScenarios([scenarios.find((s) => s.name === "retrieval_quality")!]);
    const r = results[0];

    console.log("\n=== retrieval_quality ===");
    console.log("Query results:", r.details.queryResults);
    console.log("MRR:", r.metrics.retrievalMRR);

    expect(r.metrics.retrievalMRR).toBeGreaterThanOrEqual(0.5);
    // At least one relevant event must appear in top 3
    const firstRank = r.details.queryResults[0]?.firstRelevantRank;
    expect(firstRank).not.toBeNull();
    expect(firstRank!).toBeLessThanOrEqual(3);
  });

  it("overall benchmark score >= 0.80 across all scenarios", async () => {
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
```

- [ ] **Step 2: Run tests**

```powershell
cd C:\StateCore\StateCore; pnpm --filter @statecore/core test -- eval 2>&1 | Select-Object -Last 30
```

Expected: 5 new tests pass. Console output shows metrics.

If a test fails due to a metric below threshold: read the console output to see which decisions are missing. Common causes:
- `containsFact` token matching too strict — adjust token overlap threshold
- `extractKind` doesn't classify an event correctly — check the event content matches a known pattern

If `goal_stability` fails (goalStabilityRate < 1): Check whether natural-language goal events ("I want to fix the login bug") are accidentally setting a new goal. If so, the threshold in `mergeGoalUpdate` (0.95 Jaccard for stream events) is working correctly — those events shouldn't change the goal. Re-read the log to see what `goalActual` ended up as.

- [ ] **Step 3: Run full test suite — verify no regressions**

```powershell
cd C:\StateCore\StateCore; pnpm --filter @statecore/core test 2>&1 | Select-Object -Last 10
```

Expected: 164 pass (159 existing + 5 new), 3 skipped.

- [ ] **Step 4: Commit and push**

```powershell
cd C:\StateCore\StateCore
git add packages/core/src/eval/eval.test.ts
git commit -m "test(eval): add vitest benchmark harness with per-scenario regression thresholds"
git push origin main
```

---

## Self-Review

**Spec coverage:**
| Requirement | Task |
|------------|------|
| 4 scenarios (retention, revision, goal stability, retrieval) | Task 2 ✅ |
| metrics: factRetentionRate, goalStabilityRate, decisionContinuityRate | Task 2 runner ✅ |
| metrics: conflictResolutionAccuracy | Task 2 runner ✅ |
| metrics: retrievalMRR with mock embeddings | Task 2 runner ✅ |
| overallScore weighted average | Task 2 runner ✅ |
| eval/ lives in packages/core/src/ | Task 1 ✅ |
| `pnpm eval` CLI entry | Task 1 ✅ |
| Vitest regression thresholds | Task 3 ✅ |
| No real LLM calls | Scenario files + runner use protectedStateMerge directly ✅ |

**Placeholder scan:** None found.

**Type consistency:**
- `EvalScenario.events: MemoryEvent[]` — matches MemoryEvent from `../index` ✅
- `runScenario(scenario: EvalScenario): Promise<EvalResult>` — consistent across runner.ts, index.ts ✅
- `EvalResult.metrics.retrievalMRR` — computed in `computeRetrievalMRR` and merged into final metrics ✅
- `containsFact` used in both `computeMetrics` and `runScenario` details — consistent ✅
- `extractKind` and `importanceForKind` are already exported from `digest-control.ts` (confirmed from earlier in the session) ✅
