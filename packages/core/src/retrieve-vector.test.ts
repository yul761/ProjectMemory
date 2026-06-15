import { describe, it, expect, vi } from "vitest";
import { RetrieveService } from "./index";
import type { MemoryEvent } from "./index";

function event(partial: Partial<MemoryEvent> & Pick<MemoryEvent, "id" | "content">): MemoryEvent {
  return {
    scopeId: "sc", userId: "u", type: "stream", source: "api",
    createdAt: new Date("2026-01-01T10:00:00Z"),
    ...partial
  };
}

function mockRepos(keywordEvents: MemoryEvent[], vectorOnlyEvents: MemoryEvent[] = []) {
  const allById = new Map([...keywordEvents, ...vectorOnlyEvents].map(e => [e.id, e]));
  return {
    digestRepo: { findLatest: vi.fn().mockResolvedValue(null), listRecent: vi.fn() } as any,
    memoryRepo: {
      listRecent: vi.fn().mockResolvedValue({ items: keywordEvents, nextCursor: null }),
      findByIds: vi.fn().mockImplementation(async (ids: string[]) =>
        ids.map(id => allById.get(id)).filter((e): e is MemoryEvent => e !== undefined)
      )
    } as any
  };
}

describe("RetrieveService — vector search path", () => {
  it("includes vector search results that keyword search misses", async () => {
    const kwEvent = event({ id: "kw", content: "database postgres storage" });
    const vecEvent = event({ id: "vec", content: "We decided to use Postgres" });
    const { digestRepo, memoryRepo } = mockRepos([kwEvent], [vecEvent]);

    const vectorSearchFn = vi.fn().mockResolvedValue(["vec", "kw"]);
    const embeddingModel = { embed: vi.fn().mockResolvedValue([[1, 0, 0]]) };

    const service = new RetrieveService(digestRepo, memoryRepo, {
      useVectorSearch: true,
      vectorSearchFn,
      embeddingModel,
      useEmbeddingRerank: true,
      embeddingCandidateLimit: 10
    });

    const result = await service.retrieve("sc", 5, "persistence layer");

    const ids = result.events.map(e => e.id);
    expect(ids).toContain("vec");
    expect(ids).toContain("kw");
    expect(vectorSearchFn).toHaveBeenCalledWith(expect.any(Array), expect.any(Number));
    expect(memoryRepo.findByIds).toHaveBeenCalled();
  });

  it("deduplicates events appearing in both vector and keyword results", async () => {
    const shared = event({ id: "shared", content: "database postgres" });
    const { digestRepo, memoryRepo } = mockRepos([shared], [shared]);

    const vectorSearchFn = vi.fn().mockResolvedValue(["shared"]);
    const embeddingModel = { embed: vi.fn().mockResolvedValue([[1, 0, 0]]) };

    const service = new RetrieveService(digestRepo, memoryRepo, {
      useVectorSearch: true,
      vectorSearchFn,
      embeddingModel
    });

    const result = await service.retrieve("sc", 5, "database");
    expect(result.events.filter(e => e.id === "shared")).toHaveLength(1);
  });

  it("does not call vectorSearchFn when useVectorSearch is false", async () => {
    const e = event({ id: "e1", content: "postgres database" });
    const { digestRepo, memoryRepo } = mockRepos([e]);
    const vectorSearchFn = vi.fn();

    const service = new RetrieveService(digestRepo, memoryRepo, {
      useVectorSearch: false,
      vectorSearchFn
    });

    await service.retrieve("sc", 5, "database");
    expect(vectorSearchFn).not.toHaveBeenCalled();
    expect(memoryRepo.findByIds).not.toHaveBeenCalled();
  });

  it("falls back to keyword results when vectorSearchFn throws", async () => {
    const e = event({ id: "e1", content: "postgres" });
    const { digestRepo, memoryRepo } = mockRepos([e]);

    const vectorSearchFn = vi.fn().mockRejectedValue(new Error("DB error"));
    const embeddingModel = { embed: vi.fn().mockResolvedValue([[1, 0, 0]]) };

    const service = new RetrieveService(digestRepo, memoryRepo, {
      useVectorSearch: true,
      vectorSearchFn,
      embeddingModel
    });

    const result = await service.retrieve("sc", 5, "postgres");
    expect(result.events[0].id).toBe("e1");
  });
});
