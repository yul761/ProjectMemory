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

// A template-heavy corpus: every record shares "favorite sport", only the
// person token distinguishes them. Uniform overlap scoring ties everything;
// IDF weighting must let the rare person token dominate.
const STATS = {
  totalEvents: 200,
  df: { favorite: 180, sport: 180, person42: 1, person7: 1 } as Record<string, number>
};

function mockRepos(events: MemoryEvent[], withStats: boolean) {
  return {
    digestRepo: { findLatest: vi.fn().mockResolvedValue(null), listRecent: vi.fn() } as any,
    memoryRepo: {
      listRecent: vi.fn().mockResolvedValue({ items: events, nextCursor: null }),
      findByIds: vi.fn().mockResolvedValue([]),
      ...(withStats
        ? {
            tokenStats: vi.fn(async (_scope: string, tokens: string[]) => ({
              totalEvents: STATS.totalEvents,
              df: Object.fromEntries(tokens.filter((t) => t in STATS.df).map((t) => [t, STATS.df[t]]))
            }))
          }
        : {})
    } as any
  };
}

describe("IDF-weighted retrieval scoring", () => {
  it("ranks the event matching the rare entity token first, despite equal overlap counts", async () => {
    // Both events match exactly two query tokens; e-common matches the two
    // template words, e-rare matches a template word plus the entity.
    const events = [
      event({ id: "e-common", content: "favorite sport rankings updated", createdAt: new Date("2026-01-02T10:00:00Z") }),
      event({ id: "e-rare", content: "Person42 tennis sport update", createdAt: new Date("2026-01-01T10:00:00Z") })
    ];
    const { digestRepo, memoryRepo } = mockRepos(events, true);
    const service = new RetrieveService(digestRepo, memoryRepo, {});

    const result = await service.retrieve("sc", 2, "favorite sport of person42");

    expect(result.events[0].id).toBe("e-rare");
  });

  it("makeScorer weights fact scoring by the same corpus statistics", async () => {
    const { digestRepo, memoryRepo } = mockRepos([], true);
    const service = new RetrieveService(digestRepo, memoryRepo, {});

    const score = await service.makeScorer("sc", "favorite sport of person42");
    const rare = score("Person42 plays tennis as a sport");
    const common = score("their favorite sport is unknown");
    expect(rare).toBeGreaterThan(common);
  });

  it("falls back to the legacy uniform scorer when the repo has no token stats", async () => {
    const { digestRepo, memoryRepo } = mockRepos([], false);
    const service = new RetrieveService(digestRepo, memoryRepo, {});

    const score = await service.makeScorer("sc", "favorite sport of person42");
    const legacy = (content: string) => service.scoreText("favorite sport of person42", content);
    for (const content of ["Person42 plays tennis", "their favorite sport is unknown", "nothing related"]) {
      expect(score(content)).toBeCloseTo(legacy(content), 10);
    }
  });

  it("degrades to uniform weights when the stats call throws, and still returns results", async () => {
    const events = [event({ id: "e1", content: "favorite sport notes" })];
    const { digestRepo, memoryRepo } = mockRepos(events, true);
    memoryRepo.tokenStats = vi.fn().mockRejectedValue(new Error("stats table missing"));
    const service = new RetrieveService(digestRepo, memoryRepo, {});

    const result = await service.retrieve("sc", 2, "favorite sport");
    expect(result.events).toHaveLength(1);
  });
});
