import { describe, it, expect } from "vitest";
import { RetrieveService, createModelProvider } from "./index";
import type { MemoryEvent } from "./index";

// Run manually with a real API key (PowerShell):
//   $env:MODEL_EMBEDDING_NAME="text-embedding-3-small"
//   $env:OPENAI_API_KEY="sk-..."
//   pnpm --filter @statecore/core test -- retrieve-embedding.integration --run

function event(partial: Partial<MemoryEvent> & Pick<MemoryEvent, "id" | "content">): MemoryEvent {
  return {
    scopeId: "sc", userId: "u", type: "stream", source: "api",
    createdAt: new Date("2026-01-01T10:00:00Z"),
    ...partial
  };
}

describe("RetrieveService — real embedding integration", () => {
  it.skip("requires OPENAI_API_KEY + MODEL_EMBEDDING_NAME: semantic query ranks relevant event above unrelated event", async () => {
    const apiKey = process.env.OPENAI_API_KEY;
    const modelName = process.env.MODEL_EMBEDDING_NAME ?? "text-embedding-3-small";
    if (!apiKey) throw new Error("Set OPENAI_API_KEY to run this test");

    const provider = createModelProvider({
      provider: "openai-compatible",
      apiKey,
      baseUrl: "https://api.openai.com/v1",
      model: modelName,
      embeddingModel: modelName,
      embeddingApiKey: apiKey,
      embeddingBaseUrl: "https://api.openai.com/v1"
    });

    const relevant = event({ id: "relevant", content: "We decide to use Postgres for the database" });
    const noise = event({ id: "noise", content: "The weather outside is quite nice today" });

    const service = new RetrieveService(
      { findLatest: async () => null, listRecent: async () => ({ items: [], nextCursor: null }) } as any,
      { listRecent: async () => ({ items: [noise, relevant], nextCursor: null }) } as any,
      {
        useEmbeddingRerank: true,
        embeddingModel: provider?.embedding ?? undefined,
        embeddingCandidateLimit: 10
      }
    );

    const result = await service.retrieve("sc", 2, "what persistence layer did we choose?");

    expect(result.events[0].id).toBe("relevant");
    expect(result.retrieval.reranked).toBe(true);

    const relevantMatch = result.retrieval.matches.find((m) => m.id === "relevant");
    const noiseMatch = result.retrieval.matches.find((m) => m.id === "noise");
    expect(relevantMatch?.embeddingScore).toBeGreaterThan(noiseMatch?.embeddingScore ?? 0);
  });
});
