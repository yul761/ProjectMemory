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
});
