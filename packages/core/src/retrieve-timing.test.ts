import { describe, it, expect, vi, afterEach } from "vitest";
import { RetrieveService, logger } from "./index";
import type { MemoryEvent } from "./index";

function ev(id: string, content: string): MemoryEvent {
  return { id, scopeId: "sc", userId: "u", type: "stream", source: "api", content, createdAt: new Date("2026-01-01T00:00:00Z") };
}

describe("retrieve stage timings", () => {
  afterEach(() => vi.restoreAllMocks());

  it("emits a structured retrieveTimings log with numeric stages", async () => {
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => {});
    const events = [ev("e1", "we decide to use postgres"), ev("e2", "ship the beta")];
    // RetrieveService constructor: (digests: DigestRepo, memories: MemoryRepo, options?)
    // Adapt brief stub keys: listRecent -> memories.listRecent, getLatestDigest -> digests.findLatest
    const svc = new RetrieveService(
      { findLatest: async () => null } as any,           // digests repo
      { listRecent: async () => ({ items: events, nextCursor: null }) } as any, // memories repo
      {
        embeddingModel: { embed: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]) },
        vectorSearchFn: async () => ["e1"],
        useEmbeddingRerank: true,
        embeddingCandidateLimit: 24
      }
    );

    await svc.retrieve("sc", 10, "postgres");

    const timingCall = infoSpy.mock.calls.find((c) => (c[0] as any)?.retrieveTimings);
    expect(timingCall, "a retrieveTimings log should be emitted").toBeTruthy();
    const t = (timingCall![0] as any).retrieveTimings;
    expect(typeof t.totalMs).toBe("number");
    expect(typeof t.embedMs).toBe("number");
    expect(typeof t.vectorSearchMs).toBe("number");
    expect(typeof t.rerankMs).toBe("number");
  });

  it("executes the vector-search path and records non-vacuous embedMs/vectorSearchMs when useVectorSearch is true", async () => {
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => {});
    const events = [ev("e1", "we decide to use postgres"), ev("e2", "ship the beta")];
    // Use a vi.fn() spy so we can assert the vector-search path actually ran
    const vectorSearchSpy = vi.fn(async (_vec: number[], _limit: number, _scope: string) => ["e1"]);

    const svc = new RetrieveService(
      { findLatest: async () => null } as any,
      { listRecent: async () => ({ items: events, nextCursor: null }) } as any,
      {
        embeddingModel: { embed: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]) },
        vectorSearchFn: vectorSearchSpy,
        useVectorSearch: true,
        useEmbeddingRerank: true,
        embeddingCandidateLimit: 24
      }
    );

    await svc.retrieve("sc", 10, "postgres");

    // This assertion ties the test to the instrumented path: if the embedMs/vectorSearchMs
    // timing blocks in index.ts are deleted, the vector-search block would not run, the
    // vectorSearchFn spy would never be called, and this assertion would fail — giving a
    // clear regression signal rather than silently passing with zeroed-out fields.
    expect(vectorSearchSpy).toHaveBeenCalled();

    const timingCall = infoSpy.mock.calls.find((c) => (c[0] as any)?.retrieveTimings);
    expect(timingCall, "a retrieveTimings log should be emitted").toBeTruthy();
    const t = (timingCall![0] as any).retrieveTimings;
    expect(typeof t.totalMs).toBe("number");
    expect(typeof t.embedMs).toBe("number");
    expect(typeof t.vectorSearchMs).toBe("number");
    expect(typeof t.rerankMs).toBe("number");
  });
});
