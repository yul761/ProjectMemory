import type { EvalScenario } from "../types";
import type { MemoryEvent } from "../../index";

function ev(id: string, content: string): MemoryEvent {
  return { id, scopeId: "sc", userId: "u", type: "stream", source: "api", content, createdAt: new Date("2026-01-01T10:00:00Z") };
}

export const retrievalQuality: EvalScenario = {
  name: "retrieval_quality",
  description: "Relevant events rank in top-3 for database query; MRR >= 0.5",
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
    { query: "what database did we choose?", relevantEventIds: ["rel1", "rel2", "rel3"] }
  ]
};
