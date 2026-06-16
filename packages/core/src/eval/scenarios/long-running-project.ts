import type { EvalScenario } from "../types";
import type { MemoryEvent } from "../../index";

function ev(id: string, content: string, type: "stream" | "document" = "stream", key?: string): MemoryEvent {
  return { id, scopeId: "sc", userId: "u", type, source: "api", content, createdAt: new Date("2026-01-01T10:00:00Z"), ...(key ? { key } : {}) };
}

export const longRunningProject: EvalScenario = {
  name: "long_running_project",
  description: "Goal and key decisions survive 20 noisy events",
  events: [
    ev("doc-goal", "goal: ship self-hosted memory runtime\nconstraint: no paid APIs\nconstraint: keep api stable", "document", "doc:plan"),
    ev("d1", "We decide to use Postgres for storage"),
    ev("d2", "We decide to ship CLI first before the API"),
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
    ev("d3", "We decide to use ONNX for inference"),
    ev("d4", "We decide to add a benchmark suite"),
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
