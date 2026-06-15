import { describe, it, expect } from "vitest";
import { normalizeDigestState, type DigestState } from "./digest-control";

// Simulates the Prisma JSON → unknown → DigestState cast that happens in the worker.
function simulateDbRoundTrip(state: DigestState): DigestState {
  const json = JSON.parse(JSON.stringify(state)) as unknown;
  return normalizeDigestState(json as DigestState);
}

describe("DigestState DB serialization round-trip", () => {
  it("survives a full-state round-trip without data loss", () => {
    const state: DigestState = {
      stableFacts: {
        goal: "ship beta runtime",
        constraints: ["self-hosted first", "keep api stable"],
        decisions: ["use postgres", "use ONNX for inference"]
      },
      workingNotes: {
        openQuestions: ["should we support ollama first?"],
        risks: ["blocked by provider setup"],
        context: "actively optimizing digest latency"
      },
      todos: ["ship runtime docs", "add p95 benchmark"],
      volatileContext: ["queue is stable now"],
      evidenceRefs: [
        { id: "evt-1", sourceType: "event", kind: "decision" },
        { id: "doc-1", sourceType: "document", key: "doc:plan" }
      ],
      provenance: {
        goal: [{ id: "doc-1", sourceType: "document", key: "doc:plan" }],
        decisions: [
          { value: "use postgres", refs: [{ id: "evt-1", sourceType: "event", kind: "decision" }] }
        ]
      },
      confidence: {
        goal: 1,
        decisions: [{ value: "use postgres", score: 0.7 }]
      },
      recentChanges: [
        { field: "decisions", action: "add", value: "use postgres", evidence: { id: "evt-1", sourceType: "event", kind: "decision" } }
      ],
      transitionSummary: { "decisions:add": 1 },
      factRegistry: [
        {
          id: "fact-1",
          content: "use ONNX for inference",
          type: "decision",
          confidence: 0.9,
          addedAt: "2026-01-01T00:00:00.000Z",
          evidenceId: "evt-onnx",
          evidenceType: "event"
        }
      ]
    };

    const result = simulateDbRoundTrip(state);

    expect(result.stableFacts.goal).toBe("ship beta runtime");
    expect(result.stableFacts.constraints).toEqual(["self-hosted first", "keep api stable"]);
    expect(result.stableFacts.decisions).toEqual(["use postgres", "use ONNX for inference"]);
    expect(result.workingNotes.openQuestions).toEqual(["should we support ollama first?"]);
    expect(result.workingNotes.risks).toEqual(["blocked by provider setup"]);
    expect(result.todos).toEqual(["ship runtime docs", "add p95 benchmark"]);
    expect(result.volatileContext).toEqual(["queue is stable now"]);
    expect(result.evidenceRefs).toHaveLength(2);
    expect(result.provenance?.decisions?.[0].value).toBe("use postgres");
    expect(result.confidence?.goal).toBe(1);
    expect(result.recentChanges).toHaveLength(1);
    expect(result.transitionSummary?.["decisions:add"]).toBe(1);
    expect(result.factRegistry).toHaveLength(1);
    expect(result.factRegistry![0].id).toBe("fact-1");
  });

  it("survives null/undefined fields gracefully after DB round-trip", () => {
    const minimal = { stableFacts: { decisions: [] }, workingNotes: {}, todos: [] };
    const result = simulateDbRoundTrip(minimal as DigestState);
    expect(result.stableFacts.decisions).toEqual([]);
    expect(result.todos).toEqual([]);
    expect(result.volatileContext).toEqual([]);
    expect(result.factRegistry).toEqual([]);
    expect(result.evidenceRefs).toEqual([]);
  });

  it("preserves array types after JSON round-trip", () => {
    const withArrays: DigestState = {
      stableFacts: { decisions: ["d1", "d2"], constraints: ["c1"] },
      workingNotes: { openQuestions: ["q1"], risks: ["r1"] },
      todos: ["t1"],
      volatileContext: ["v1"],
      evidenceRefs: []
    };
    const result = simulateDbRoundTrip(withArrays);
    expect(Array.isArray(result.stableFacts.decisions)).toBe(true);
    expect(Array.isArray(result.stableFacts.constraints)).toBe(true);
    expect(Array.isArray(result.workingNotes.openQuestions)).toBe(true);
    expect(Array.isArray(result.todos)).toBe(true);
    expect(Array.isArray(result.volatileContext)).toBe(true);
  });

  it("filters superseded factRegistry entries during round-trip", () => {
    const state: DigestState = {
      stableFacts: { decisions: ["use TensorRT"] },
      workingNotes: {},
      todos: [],
      factRegistry: [
        {
          id: "fact-old",
          content: "use ONNX",
          type: "decision",
          confidence: 0.9,
          addedAt: "2026-01-01T00:00:00.000Z",
          evidenceId: "e1",
          evidenceType: "event",
          supersededBy: "fact-new"
        },
        {
          id: "fact-new",
          content: "use TensorRT",
          type: "decision",
          confidence: 0.9,
          addedAt: "2026-01-02T00:00:00.000Z",
          evidenceId: "e2",
          evidenceType: "event"
        }
      ]
    };
    const result = simulateDbRoundTrip(state);
    expect(result.factRegistry).toHaveLength(1);
    expect(result.factRegistry![0].id).toBe("fact-new");
  });
});
