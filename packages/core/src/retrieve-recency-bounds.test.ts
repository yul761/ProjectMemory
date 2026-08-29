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

describe("RetrieveService — recency normalization over the merged pool", () => {
  // Reproduces the review finding: oldestTs was read from the LAST element of
  // the merged array — the oldest of the most recently appended batch, not of
  // the pool. A lexical hit older than every vector hit then got a large
  // negative recency and sank below the cutoff, in exactly the flagship
  // (embeddings-on) configuration the lexical index was built for.
  it("an old lexical hit is not buried below zero recency when vector results are newer", async () => {
    const recent = [
      event({ id: "r1", content: "morning chatter", createdAt: new Date("2026-06-10T10:00:00Z") }),
      event({ id: "r2", content: "lunch chatter", createdAt: new Date("2026-06-10T09:00:00Z") })
    ];
    const oldLexical = event({
      id: "old1",
      content: "we chose pgvector for the embedding store",
      createdAt: new Date("2025-08-01T10:00:00Z")
    });
    const midVector = event({
      id: "vec1",
      content: "unrelated deploy note",
      createdAt: new Date("2026-06-07T10:00:00Z")
    });

    const digestRepo = { findLatest: vi.fn().mockResolvedValue(null), listRecent: vi.fn() } as any;
    const memoryRepo = {
      listRecent: vi.fn().mockResolvedValue({ items: recent, nextCursor: null }),
      searchByTokens: vi.fn().mockResolvedValue(["old1"]),
      findByIds: vi.fn().mockImplementation(async (ids: string[]) =>
        [oldLexical, midVector].filter((e) => ids.includes(e.id))
      )
    } as any;
    const embeddingModel = { embed: vi.fn().mockResolvedValue([[1, 0, 0]]) };
    const vectorSearchFn = vi.fn().mockResolvedValue(["vec1"]);

    const service = new RetrieveService(digestRepo, memoryRepo, {
      useVectorSearch: true,
      embeddingModel,
      vectorSearchFn
    });

    const result = await service.retrieve("sc", 3, "pgvector embedding store");

    const oldMatch = result.retrieval.matches.find((m) => m.id === "old1");
    expect(oldMatch).toBeDefined();
    expect(oldMatch!.recencyScore).toBeGreaterThanOrEqual(0);
    expect(oldMatch!.recencyScore).toBeLessThanOrEqual(1);
    expect(result.events[0].id).toBe("old1"); // relevance wins once recency is sane
  });
});
