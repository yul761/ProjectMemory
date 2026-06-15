import { describe, it, expect } from "vitest";
import { runDigestControlPipeline, normalizeDigestState } from "./index";
import type { MemoryEvent } from "./index";

function event(partial: Partial<MemoryEvent> & Pick<MemoryEvent, "id" | "type" | "content">): MemoryEvent {
  return {
    scopeId: "sc",
    userId: "u",
    source: "api",
    createdAt: new Date("2026-01-01T10:00:00Z"),
    ...partial
  };
}

const FIXED_EVENTS: MemoryEvent[] = [
  event({
    id: "doc-1",
    type: "document",
    key: "doc:plan",
    content: "goal: ship self-hosted memory runtime\nconstraint: no paid APIs\ndecision: use postgres"
  }),
  event({ id: "s-1", type: "stream", content: "We decide to use Postgres for storage", createdAt: new Date("2026-01-01T10:01:00Z") }),
  event({ id: "s-2", type: "stream", content: "constraint: keep api stable", createdAt: new Date("2026-01-01T10:02:00Z") }),
  event({ id: "s-3", type: "stream", content: "TODO: write benchmark script", createdAt: new Date("2026-01-01T10:03:00Z") })
];

const FIXED_SCOPE = {
  id: "sc", userId: "u", name: "Replay Test Scope",
  goal: "ship self-hosted memory runtime",
  stage: "build" as const,
  createdAt: new Date("2026-01-01T00:00:00Z")
};

const MOCK_LLM = {
  chat: async () => JSON.stringify({
    summary: "Goal: ship self-hosted memory runtime. Constraints: no paid APIs; keep api stable. Decision: use postgres.",
    changes: ["Decision: use postgres", "Constraint: keep api stable", "Constraint: no paid APIs"],
    nextSteps: ["Write benchmark script"]
  })
};

const PIPELINE_CONFIG = {
  eventBudgetTotal: 10, eventBudgetDocs: 3, eventBudgetStream: 7,
  noveltyThreshold: 0.3, maxRetries: 0, useLlmClassifier: false, debug: false
};

const PROMPTS = {
  digestStage2SystemPrompt: "system",
  digestStage2UserPrompt: "{{scopeName}} {{lastDigest}} {{protectedState}} {{deltaCandidates}} {{documents}}"
};

describe("digest pipeline determinism", () => {
  it("produces identical DigestState.stableFacts when run twice with same inputs", async () => {
    const [run1, run2] = await Promise.all([
      runDigestControlPipeline({ scope: FIXED_SCOPE, lastDigest: null, prevState: null, recentEvents: FIXED_EVENTS, llm: MOCK_LLM, prompts: PROMPTS, config: PIPELINE_CONFIG }),
      runDigestControlPipeline({ scope: FIXED_SCOPE, lastDigest: null, prevState: null, recentEvents: FIXED_EVENTS, llm: MOCK_LLM, prompts: PROMPTS, config: PIPELINE_CONFIG })
    ]);
    const s1 = normalizeDigestState(run1.state);
    const s2 = normalizeDigestState(run2.state);
    expect(s1.stableFacts).toEqual(s2.stableFacts);
    expect(s1.todos).toEqual(s2.todos);
  });

  it("incremental digest from prior state preserves established stableFacts", async () => {
    // First run: establish baseline state
    const firstRun = await runDigestControlPipeline({
      scope: FIXED_SCOPE,
      lastDigest: null,
      prevState: null,
      recentEvents: FIXED_EVENTS,
      llm: MOCK_LLM,
      prompts: PROMPTS,
      config: PIPELINE_CONFIG
    });

    // Second run: build on prior state (simulates incremental digest, no new events)
    const secondRun = await runDigestControlPipeline({
      scope: FIXED_SCOPE,
      lastDigest: {
        id: "d-prev",
        scopeId: "sc",
        summary: firstRun.digest.summary,
        changes: firstRun.digest.changes.map((c) => `- ${c}`).join("\n"),
        nextSteps: firstRun.digest.nextSteps,
        createdAt: new Date("2026-01-01T11:00:00Z")
      },
      prevState: firstRun.state,
      recentEvents: FIXED_EVENTS,
      llm: MOCK_LLM,
      prompts: PROMPTS,
      config: PIPELINE_CONFIG
    });

    // Decisions established in first run must survive into second run
    const first = normalizeDigestState(firstRun.state);
    const second = normalizeDigestState(secondRun.state);
    expect(second.stableFacts.goal).toBe(first.stableFacts.goal);
    for (const decision of first.stableFacts.decisions) {
      expect(second.stableFacts.decisions).toContain(decision);
    }
  });

  it("pipeline includes goal from document events", async () => {
    const result = await runDigestControlPipeline({ scope: FIXED_SCOPE, lastDigest: null, prevState: null, recentEvents: FIXED_EVENTS, llm: MOCK_LLM, prompts: PROMPTS, config: PIPELINE_CONFIG });
    expect(result.state.stableFacts.goal).toBe("ship self-hosted memory runtime");
  });
});
