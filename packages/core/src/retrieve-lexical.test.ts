import { describe, it, expect, vi } from "vitest";
import { MemoryService, RetrieveService } from "./index";
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

describe("RetrieveService — lexical candidate stream", () => {
  it("finds a relevant event that recency alone would never surface", async () => {
    // The recency window holds only chatter; the relevant event is old.
    const recent = [
      event({ id: "r1", content: "morning standup notes", createdAt: new Date("2026-06-01T10:00:00Z") }),
      event({ id: "r2", content: "lunch plans", createdAt: new Date("2026-06-01T09:00:00Z") })
    ];
    const oldRelevant = event({
      id: "old1",
      content: "we chose pgvector for the embedding store",
      createdAt: new Date("2026-01-01T10:00:00Z")
    });

    const digestRepo = { findLatest: vi.fn().mockResolvedValue(null), listRecent: vi.fn() } as any;
    const memoryRepo = {
      listRecent: vi.fn().mockResolvedValue({ items: recent, nextCursor: null }),
      findByIds: vi.fn().mockResolvedValue([oldRelevant]),
      searchByTokens: vi.fn().mockResolvedValue(["old1"])
    } as any;

    const service = new RetrieveService(digestRepo, memoryRepo, {});
    const result = await service.retrieve("sc", 3, "pgvector embedding store");

    expect(memoryRepo.searchByTokens).toHaveBeenCalledWith(
      "sc",
      expect.arrayContaining(["pgvector", "embedding", "store"]),
      expect.any(Number)
    );
    expect(result.events[0].id).toBe("old1");
    expect(result.retrieval.degraded).toBeUndefined();
  });

  it("reports a lexical_search degradation and still serves recency results when the index query throws", async () => {
    const recent = [event({ id: "r1", content: "pgvector notes" })];
    const digestRepo = { findLatest: vi.fn().mockResolvedValue(null), listRecent: vi.fn() } as any;
    const memoryRepo = {
      listRecent: vi.fn().mockResolvedValue({ items: recent, nextCursor: null }),
      findByIds: vi.fn().mockResolvedValue([]),
      searchByTokens: vi.fn().mockRejectedValue(new Error("index table missing"))
    } as any;

    const service = new RetrieveService(digestRepo, memoryRepo, {});
    const result = await service.retrieve("sc", 3, "pgvector");

    expect(result.events).toHaveLength(1);
    expect(result.retrieval.degraded).toEqual([
      { stage: "lexical_search", error: expect.stringContaining("index table missing") }
    ]);
  });

  it("works unchanged when the repo has no token index", async () => {
    const recent = [event({ id: "r1", content: "pgvector notes" })];
    const digestRepo = { findLatest: vi.fn().mockResolvedValue(null), listRecent: vi.fn() } as any;
    const memoryRepo = {
      listRecent: vi.fn().mockResolvedValue({ items: recent, nextCursor: null }),
      findByIds: vi.fn().mockResolvedValue([])
    } as any;

    const service = new RetrieveService(digestRepo, memoryRepo, {});
    const result = await service.retrieve("sc", 3, "pgvector");

    expect(result.events).toHaveLength(1);
    expect(result.retrieval.degraded).toBeUndefined();
  });
});

describe("MemoryService — writes the token index", () => {
  const base = { userId: "u", scopeId: "sc", source: "api" as const };

  it("indexes a stream event's tokens after create", async () => {
    const created = event({ id: "e1", content: "we chose pgvector 数据库" });
    const repo = {
      create: vi.fn().mockResolvedValue(created),
      replaceTokens: vi.fn().mockResolvedValue(undefined)
    } as any;

    await new MemoryService(repo).ingestEvent({ ...base, type: "stream", content: "we chose pgvector 数据库" });

    expect(repo.replaceTokens).toHaveBeenCalledWith(
      "e1",
      "sc",
      expect.arrayContaining(["chose", "pgvector", "数据", "据库"])
    );
  });

  it("re-indexes a document on upsert", async () => {
    const upserted = event({ id: "d1", content: "updated body", type: "document", key: "doc" });
    const repo = {
      upsertDocument: vi.fn().mockResolvedValue(upserted),
      replaceTokens: vi.fn().mockResolvedValue(undefined)
    } as any;

    await new MemoryService(repo).ingestEvent({ ...base, type: "document", key: "doc", content: "updated body" });

    expect(repo.replaceTokens).toHaveBeenCalledWith("d1", "sc", expect.arrayContaining(["updated", "body"]));
  });

  it("still ingests when the repo has no token index", async () => {
    const created = event({ id: "e1", content: "plain" });
    const repo = { create: vi.fn().mockResolvedValue(created) } as any;

    const result = await new MemoryService(repo).ingestEvent({ ...base, type: "stream", content: "plain" });

    expect(result.id).toBe("e1");
  });
});
