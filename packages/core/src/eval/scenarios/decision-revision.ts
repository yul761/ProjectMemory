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
