import { describe, expect, it } from "vitest";
import {
  consistencyCheck,
  detectDeltas,
  generateDigestStage2,
  protectedStateMerge,
  selectEventsForDigest,
  type DigestState,
  type SelectedEvent
} from "./digest-control";
import type { MemoryEvent } from "./index";

function event(partial: Partial<MemoryEvent> & Pick<MemoryEvent, "id" | "scopeId" | "userId" | "content" | "type">): MemoryEvent {
  return {
    source: "api",
    createdAt: new Date(),
    ...partial
  };
}

describe("selectEventsForDigest", () => {
  it("dedups near-identical stream events and includes latest docs within budget", () => {
    const events: MemoryEvent[] = [
      event({ id: "s1", scopeId: "sc", userId: "u", type: "stream", content: "We decide to ship API v1", createdAt: new Date("2026-02-01T10:00:00Z") }),
      event({ id: "s2", scopeId: "sc", userId: "u", type: "stream", content: "We decide to ship API v1!", createdAt: new Date("2026-02-01T09:59:00Z") }),
      event({ id: "d1", scopeId: "sc", userId: "u", type: "document", key: "note:plan", content: "goal: launch beta", createdAt: new Date("2026-02-01T09:58:00Z") }),
      event({ id: "d2", scopeId: "sc", userId: "u", type: "document", key: "note:plan", content: "goal: launch beta soon", createdAt: new Date("2026-02-01T10:01:00Z") })
    ];

    const result = selectEventsForDigest({
      recentEvents: events,
      lastDigest: null,
      eventBudgetTotal: 3,
      eventBudgetDocs: 1,
      eventBudgetStream: 2
    });

    const ids = result.selectedEvents.map((item) => item.event.id);
    expect(ids).toContain("d2");
    expect(ids).not.toContain("d1");
    expect(ids).toContain("s1");
    expect(ids).not.toContain("s2");
  });
});

describe("detectDeltas", () => {
  it("keeps decisions even when novelty is low", () => {
    const selected: SelectedEvent[] = [
      {
        event: event({ id: "e1", scopeId: "sc", userId: "u", type: "stream", content: "we decide to keep postgres" }),
        features: { kind: "decision", importanceScore: 0.9, noveltyScore: 0 }
      },
      {
        event: event({ id: "e2", scopeId: "sc", userId: "u", type: "stream", content: "daily status update" }),
        features: { kind: "status", importanceScore: 0.4, noveltyScore: 0 }
      }
    ];

    const deltas = detectDeltas({
      lastDigestText: "we decide to keep postgres; daily status update",
      selectedEvents: selected,
      noveltyThreshold: 0.5
    });

    expect(deltas.map((item) => item.eventId)).toContain("e1");
  });
});

describe("protectedStateMerge", () => {
  it("does not overwrite goal without explicit goal marker", () => {
    const prevState: DigestState = {
      stableFacts: { goal: "ship alpha", constraints: ["no paid infra"], decisions: ["use postgres"] },
      workingNotes: {},
      todos: []
    };

    const merged = protectedStateMerge({
      prevState,
      documents: [event({ id: "doc1", scopeId: "sc", userId: "u", type: "document", key: "note:1", content: "regular update text" })],
      deltaCandidates: []
    });

    expect(merged.stableFacts.goal).toBe("ship alpha");
    expect(merged.stableFacts.decisions).toContain("use postgres");
  });
});

describe("consistencyCheck", () => {
  it("catches contradictions and vague next steps", () => {
    const result = consistencyCheck({
      output: {
        summary: "goal: rewrite everything now",
        changes: ["same change"],
        nextSteps: ["clarify"]
      },
      previousDigest: {
        id: "d1",
        scopeId: "sc",
        summary: "old",
        changes: "- same change",
        nextSteps: ["test api"],
        createdAt: new Date()
      },
      protectedState: {
        stableFacts: { goal: "ship alpha", constraints: [], decisions: [] },
        workingNotes: {},
        todos: []
      }
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("goal_contradiction");
    expect(result.errors).toContain("changes_repeated_from_previous_digest");
    expect(result.errors).toContain("vague_next_step");
  });
});

describe("generateDigestStage2", () => {
  it("retries after invalid output and succeeds with mocked llm", async () => {
    const responses = [
      "{\"summary\":\"too short\",\"changes\":[\"same\"],\"nextSteps\":[\"clarify\"]}",
      "{\"summary\":\"Shipped API endpoints and investigated queue performance.\",\"changes\":[\"Added endpoint tests\"],\"nextSteps\":[\"Write benchmark script for queue latency\"]}"
    ];
    const llm = {
      chat: async () => responses.shift() as string
    };

    const result = await generateDigestStage2({
      scope: { id: "s", userId: "u", name: "Demo", goal: "ship alpha", stage: "build", createdAt: new Date() },
      lastDigest: null,
      protectedState: { stableFacts: { goal: "ship alpha", constraints: [], decisions: [] }, workingNotes: {}, todos: [] },
      deltaCandidates: [],
      documents: [],
      llm,
      systemPrompt: "system",
      userPromptTemplate: "{{scopeName}} {{lastDigest}} {{protectedState}} {{deltaCandidates}} {{documents}}",
      maxRetries: 1
    });

    expect(result.nextSteps[0]).toContain("Write benchmark script");
  });
});
