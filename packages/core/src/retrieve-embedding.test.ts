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

// listRecent returns events newest-first (the API contract the code relies on for recency calculation)
function mockRepos(events: MemoryEvent[]) {
  return {
    digestRepo: { findLatest: vi.fn().mockResolvedValue(null), listRecent: vi.fn() } as any,
    memoryRepo: { listRecent: vi.fn().mockResolvedValue({ items: events, nextCursor: null }) } as any
  };
}

describe("RetrieveService — embedding reranking", () => {
  it("promotes semantically similar event above keyword-ranked event", async () => {
    const e1 = event({ id: "e1", content: "unrelated alpha", createdAt: new Date("2026-01-01T10:00:00Z") });
    const e2 = event({ id: "e2", content: "unrelated beta",  createdAt: new Date("2026-01-01T10:01:00Z") });
    // listRecent returns newest-first; e2 is newer so it comes first
    const { digestRepo, memoryRepo } = mockRepos([e2, e1]);

    const embeddingModel = {
      embed: vi.fn().mockResolvedValue([
        [1, 0, 0],       // query vector
        [0.1, 0.9, 0],   // e2 vector (low cosine — e2 is first in keyword order)
        [0.9, 0.1, 0]    // e1 vector (high cosine — e1 is second in keyword order)
      ])
    };

    const service = new RetrieveService(digestRepo, memoryRepo, {
      useEmbeddingRerank: true,
      embeddingModel,
      embeddingCandidateLimit: 5
    });

    const result = await service.retrieve("sc", 2, "xyzzy");

    expect(result.events[0].id).toBe("e1");
    expect(result.retrieval.mode).toBe("hybrid");
    expect(result.retrieval.reranked).toBe(true);
    const e1Match = result.retrieval.matches.find((m) => m.id === "e1");
    expect(e1Match?.embeddingScore).toBeDefined();
    expect(e1Match?.rankingReason).toContain("embedding_rerank");
  });

  it("falls back to keyword ranking when embedding model throws", async () => {
    const e1 = event({ id: "e1", content: "unrelated alpha", createdAt: new Date("2026-01-01T10:00:00Z") });
    const e2 = event({ id: "e2", content: "unrelated beta",  createdAt: new Date("2026-01-01T10:01:00Z") });
    // listRecent returns newest-first; e2 is newer so it comes first
    const { digestRepo, memoryRepo } = mockRepos([e2, e1]);

    const embeddingModel = {
      embed: vi.fn().mockRejectedValue(new Error("API timeout"))
    };

    const service = new RetrieveService(digestRepo, memoryRepo, {
      useEmbeddingRerank: true,
      embeddingModel,
      embeddingCandidateLimit: 5
    });

    const result = await service.retrieve("sc", 2, "xyzzy");

    expect(result.events[0].id).toBe("e2");
    expect(result.retrieval.matches[0].embeddingScore).toBeUndefined();
    expect(result.retrieval.matches[0].rankingReason).toContain("heuristic_rank");
    // The rerank never ran, so the run was heuristic — mode used to claim
    // "hybrid" here because it was derived from configuration, not outcome.
    expect(result.retrieval.mode).toBe("heuristic");
    expect(result.retrieval.degraded).toEqual([{ stage: "rerank", error: expect.stringContaining("API timeout") }]);
    expect(result.retrieval.reranked).toBe(false);
  });

  it("embeddingScore reflects cosine similarity — perfect match scores 1.0 and drives finalScore", async () => {
    const e1 = event({ id: "e1", content: "anything here" });
    const { digestRepo, memoryRepo } = mockRepos([e1]);

    const embeddingModel = {
      embed: vi.fn().mockResolvedValue([
        [1, 0, 0],
        [1, 0, 0]
      ])
    };

    const service = new RetrieveService(digestRepo, memoryRepo, {
      useEmbeddingRerank: true,
      embeddingModel,
      embeddingCandidateLimit: 5
    });

    const result = await service.retrieve("sc", 1, "xyzzy");
    const match = result.retrieval.matches[0];

    expect(match.embeddingScore).toBeCloseTo(1.0, 2);
    expect(match.finalScore).toBeCloseTo(0.55, 1);
  });
});
