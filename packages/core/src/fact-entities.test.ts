import { describe, it, expect } from "vitest";
import { applyProfileFactsFromDigest, type DigestState } from "./digest-control";
import { DigestOutputSchema } from "./digest/types";
import { rankFacts } from "./retrieve-budget";
import { buildDigestStage2SystemPrompt } from "@statecore/prompts";

function emptyState(): DigestState {
  return { stableFacts: { decisions: [] }, workingNotes: {}, todos: [], factRegistry: [], profile: {} };
}

let counter = 0;
const makeId = () => `id-${++counter}`;
const makeNow = () => "2026-08-29T12:00:00.000Z";
const streamEvidence = { id: "ev-1", sourceType: "event" as const };

describe("fact entities", () => {
  it("DigestOutputSchema accepts entities on a profile fact", () => {
    const parsed = DigestOutputSchema.safeParse({
      summary: "s",
      changes: [],
      nextSteps: [],
      profileFacts: [{ facet: "notes", value: "prefers pnpm", entities: ["pnpm", "corepack"] }]
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.profileFacts?.[0].entities).toEqual(["pnpm", "corepack"]);
  });

  it("applyProfileFactsFromDigest stores entities on the registry entry", () => {
    const state = emptyState();
    applyProfileFactsFromDigest(
      state,
      [{ facet: "notes", value: "包管理统一用 pnpm", entities: ["pnpm", "corepack"] }],
      [],
      streamEvidence,
      makeId,
      makeNow
    );

    const entry = state.factRegistry!.find((f) => f.content.includes("pnpm"));
    expect(entry).toBeDefined();
    expect(entry!.entities).toEqual(["pnpm", "corepack"]);
  });

  it("a superseding fact carries its own entities", () => {
    const state = emptyState();
    applyProfileFactsFromDigest(
      state,
      [{ facet: "notes", value: "database is postgres with pgvector", entities: ["postgres"] }],
      [],
      streamEvidence,
      makeId,
      makeNow
    );
    applyProfileFactsFromDigest(
      state,
      [{ facet: "notes", value: "database is postgres with pgvector and pgbouncer", entities: ["postgres", "pgbouncer"] }],
      [],
      { id: "ev-2", sourceType: "event" as const },
      makeId,
      makeNow
    );

    const active = state.factRegistry!.filter((f) => !f.supersededBy);
    expect(active).toHaveLength(1);
    expect(active[0].entities).toEqual(["postgres", "pgbouncer"]);
  });

  it("rankFacts matches a query against entities the distilled text lost", () => {
    const facts = [
      { id: "plain", content: "uses a modern package manager", confidence: 0.8, addedAt: "2026-01-02T00:00:00Z" },
      {
        id: "entity",
        content: "包管理已统一",
        confidence: 0.8,
        addedAt: "2026-01-01T00:00:00Z",
        entities: ["corepack"]
      }
    ];
    const scoreFact = (text: string) => (text.includes("corepack") ? 1 : 0);
    const ranked = rankFacts(facts, scoreFact);
    expect(ranked[0].id).toBe("entity");
  });

  it("the stage-2 prompt tells the model to emit entities", () => {
    const p = buildDigestStage2SystemPrompt("- notes: things worth keeping");
    expect(p).toMatch(/entities/);
    expect(p).toMatch(/concrete nouns|specific nouns/i);
  });
});
