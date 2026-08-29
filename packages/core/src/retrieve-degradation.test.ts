import { describe, it, expect, vi } from "vitest";
import { RetrieveService } from "./index";
import type { MemoryEvent } from "./index";

function event(partial: Partial<MemoryEvent> & Pick<MemoryEvent, "id" | "content">): MemoryEvent {
  return {
    scopeId: "sc",
    userId: "u",
    type: "stream",
    source: "api",
    createdAt: new Date("2026-01-01T10:00:00Z"),
    ...partial
  };
}

function mockRepos(events: MemoryEvent[]) {
  return {
    digestRepo: { findLatest: vi.fn().mockResolvedValue(null), listRecent: vi.fn() } as any,
    memoryRepo: {
      listRecent: vi.fn().mockResolvedValue({ items: events, nextCursor: null }),
      findByIds: vi.fn().mockResolvedValue([])
    } as any
  };
}

const twoEvents = () => [
  event({ id: "e2", content: "unrelated beta", createdAt: new Date("2026-01-01T10:01:00Z") }),
  event({ id: "e1", content: "unrelated alpha", createdAt: new Date("2026-01-01T10:00:00Z") })
];

describe("RetrieveService — degradation is reported, never silent", () => {
  it("reports mode heuristic and a rerank degradation when the embedding model throws", async () => {
    const { digestRepo, memoryRepo } = mockRepos(twoEvents());
    const embeddingModel = { embed: vi.fn().mockRejectedValue(new Error("API timeout")) };

    const service = new RetrieveService(digestRepo, memoryRepo, {
      useEmbeddingRerank: true,
      embeddingModel,
      embeddingCandidateLimit: 5
    });

    const result = await service.retrieve("sc", 2, "xyzzy");

    // Embeddings were configured and requested but contributed nothing: the
    // response must say heuristic, not advertise a hybrid that never ran.
    expect(result.retrieval.mode).toBe("heuristic");
    expect(result.retrieval.degraded).toEqual([
      { stage: "rerank", error: expect.stringContaining("API timeout") }
    ]);
  });

  it("reports a vector_search degradation when the vector search path throws", async () => {
    const { digestRepo, memoryRepo } = mockRepos(twoEvents());
    const embeddingModel = { embed: vi.fn().mockRejectedValue(new Error("embed down")) };

    const service = new RetrieveService(digestRepo, memoryRepo, {
      useVectorSearch: true,
      embeddingModel,
      vectorSearchFn: vi.fn()
    });

    const result = await service.retrieve("sc", 2, "xyzzy");

    expect(result.events.length).toBeGreaterThan(0); // still serves heuristic results
    expect(result.retrieval.mode).toBe("heuristic");
    expect(result.retrieval.degraded).toEqual([
      { stage: "vector_search", error: expect.stringContaining("embed down") }
    ]);
  });

  it("reports both degradations when vector search and rerank both fail", async () => {
    const { digestRepo, memoryRepo } = mockRepos(twoEvents());
    const embeddingModel = { embed: vi.fn().mockRejectedValue(new Error("provider outage")) };

    const service = new RetrieveService(digestRepo, memoryRepo, {
      useEmbeddingRerank: true,
      useVectorSearch: true,
      embeddingModel,
      vectorSearchFn: vi.fn(),
      embeddingCandidateLimit: 5
    });

    const result = await service.retrieve("sc", 2, "xyzzy");

    expect(result.retrieval.mode).toBe("heuristic");
    expect(result.retrieval.degraded?.map((d) => d.stage).sort()).toEqual(["rerank", "vector_search"]);
  });

  it("omits degraded and reports hybrid when embeddings succeed", async () => {
    const { digestRepo, memoryRepo } = mockRepos(twoEvents());
    const embeddingModel = {
      embed: vi.fn().mockResolvedValue([
        [1, 0, 0],
        [0.1, 0.9, 0],
        [0.9, 0.1, 0]
      ])
    };

    const service = new RetrieveService(digestRepo, memoryRepo, {
      useEmbeddingRerank: true,
      embeddingModel,
      embeddingCandidateLimit: 5
    });

    const result = await service.retrieve("sc", 2, "xyzzy");

    expect(result.retrieval.mode).toBe("hybrid");
    expect(result.retrieval.degraded).toBeUndefined();
  });

  it("reports hybrid when vector search succeeds even without rerank", async () => {
    const { digestRepo, memoryRepo } = mockRepos(twoEvents());
    const embeddingModel = { embed: vi.fn().mockResolvedValue([[1, 0, 0]]) };
    const vectorSearchFn = vi.fn().mockResolvedValue(["e1"]);

    const service = new RetrieveService(digestRepo, memoryRepo, {
      useVectorSearch: true,
      embeddingModel,
      vectorSearchFn
    });

    const result = await service.retrieve("sc", 2, "xyzzy");

    // Vector candidates entered the pool: this run genuinely was hybrid, and
    // before this field mode said "heuristic" here — a lie in the other direction.
    expect(result.retrieval.mode).toBe("hybrid");
    expect(result.retrieval.degraded).toBeUndefined();
  });
});
