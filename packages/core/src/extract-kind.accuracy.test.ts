import { describe, it, expect } from "vitest";
import { protectedStateMerge, extractKind, importanceForKind } from "./digest-control";
import type { MemoryEvent } from "./index";

function mkDelta(id: string, content: string) {
  const event: MemoryEvent = {
    id, scopeId: "sc", userId: "u", type: "stream",
    source: "api", content, createdAt: new Date()
  };
  const kind = extractKind(content);
  return {
    eventId: id,
    reason: "novel_event" as const,
    features: { kind, importanceScore: importanceForKind(kind, content), noveltyScore: 0.9 },
    event
  };
}

describe("extractKind routing accuracy", () => {
  const decisionInputs = [
    "We decide to use Postgres for persistence",
    "We will ship CLI first before the API",
    "Agreed: keep the assistant runtime as a product boundary",
    "Decision: no GPU required for V1 inference",
    "We approved the migration to UUIDv7"
  ];

  it.each(decisionInputs)("routes decision input to stableFacts.decisions: %s", (content) => {
    const merged = protectedStateMerge({
      prevState: null,
      documents: [],
      deltaCandidates: [mkDelta("d1", content)]
    });
    expect(merged.stableFacts.decisions).toContain(content);
    expect(merged.stableFacts.constraints).toHaveLength(0);
  });

  const constraintInputs = [
    "constraint: no paid third-party APIs in V1",
    "We cannot use cloud storage in the first release",
    "Limitation: must support arm64",
    "Must not store user PII outside the local machine"
  ];

  it.each(constraintInputs)("routes constraint input to stableFacts.constraints: %s", (content) => {
    const merged = protectedStateMerge({
      prevState: null,
      documents: [],
      deltaCandidates: [mkDelta("c1", content)]
    });
    expect(merged.stableFacts.constraints.length).toBeGreaterThan(0);
    expect(merged.stableFacts.decisions).toHaveLength(0);
  });

  const noiseInputs = [
    "ok",
    "thanks",
    "noted",
    "Assistant reply: We decided to keep postgres.",
    "What are the current decisions?",
    "What is the state?"
  ];

  it.each(noiseInputs)("does not write noise to any stable field: %s", (content) => {
    const merged = protectedStateMerge({
      prevState: null,
      documents: [],
      deltaCandidates: [mkDelta("n1", content)]
    });
    expect(merged.stableFacts.decisions).toHaveLength(0);
    expect(merged.stableFacts.constraints).toHaveLength(0);
    expect(merged.todos).toHaveLength(0);
  });

  const todoInputs = [
    "TODO: add benchmark assertion for p95 latency",
    "Next step: write queue latency notes",
    "Action item: document the API surface",
    "Follow up: review the digest control logic"
  ];

  it.each(todoInputs)("routes todo input to todos: %s", (content) => {
    const merged = protectedStateMerge({
      prevState: null,
      documents: [],
      deltaCandidates: [mkDelta("t1", content)]
    });
    expect(merged.todos.length).toBeGreaterThan(0);
    expect(merged.stableFacts.decisions).toHaveLength(0);
  });
});
