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

describe("extractKind recall — realistic conversation inputs", () => {
  const decisionCases = [
    "we should use Postgres for the database",
    "let's go with Ollama for local model inference",
    "going forward, use UUIDv7 for all new IDs"
  ];

  it.each(decisionCases)("routes realistic decision to stableFacts.decisions: %s", (content) => {
    const merged = protectedStateMerge({
      prevState: null,
      documents: [],
      deltaCandidates: [mkDelta("d1", content)]
    });
    expect(merged.stableFacts.decisions.length).toBeGreaterThan(0);
    expect(merged.stableFacts.constraints).toHaveLength(0);
  });

  const constraintCases = [
    "the API must stay backward compatible",
    "no cloud storage allowed in V1",
    "we need to keep this self-hosted"
  ];

  it.each(constraintCases)("routes realistic constraint to stableFacts.constraints: %s", (content) => {
    const merged = protectedStateMerge({
      prevState: null,
      documents: [],
      deltaCandidates: [mkDelta("c1", content)]
    });
    expect(merged.stableFacts.constraints.length).toBeGreaterThan(0);
    expect(merged.stableFacts.decisions).toHaveLength(0);
  });

  const todoCases = [
    "let's add a benchmark script for p95 latency",
    "make sure to test the edge cases before shipping",
    "we need to write docs for the new API surface"
  ];

  it.each(todoCases)("routes realistic todo to todos: %s", (content) => {
    const merged = protectedStateMerge({
      prevState: null,
      documents: [],
      deltaCandidates: [mkDelta("t1", content)]
    });
    expect(merged.todos.length).toBeGreaterThan(0);
    expect(merged.stableFacts.decisions).toHaveLength(0);
  });

  it.skip("known limitation: 'I think X might be better' is ambiguous opinion, not a decision", () => {
    // "I think Postgres might be better" — no clear decision intent, could be exploration.
    // Adding this pattern would cause false positives on opinion statements.
    const merged = protectedStateMerge({
      prevState: null,
      documents: [],
      deltaCandidates: [mkDelta("skip1", "I think Postgres might be better than SQLite")]
    });
    expect(merged.stableFacts.decisions.length).toBeGreaterThan(0);
  });

  it.skip("known limitation: 'X would probably work' is uncertain framing, not a decision", () => {
    // Speculative phrasing — not confirmed intent. Risk of false positives too high.
    const merged = protectedStateMerge({
      prevState: null,
      documents: [],
      deltaCandidates: [mkDelta("skip2", "ONNX would probably work for inference")]
    });
    expect(merged.stableFacts.decisions.length).toBeGreaterThan(0);
  });
});
