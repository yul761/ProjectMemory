import type { EvalScenario } from "../types";
import type { MemoryEvent } from "../../index";

function ev(id: string, content: string): MemoryEvent {
  return { id, scopeId: "sc", userId: "u", type: "stream", source: "api", content, createdAt: new Date("2026-01-01T10:00:00Z") };
}

export const goalStability: EvalScenario = {
  name: "goal_stability_under_noise",
  description: "Goal survives 15 noise events including ones with unrelated goal mentions",
  events: [
    { id: "doc-goal", scopeId: "sc", userId: "u", type: "document", key: "doc:goal", source: "api",
      content: "goal: ship self-hosted memory runtime", createdAt: new Date("2026-01-01T10:00:00Z") },
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
