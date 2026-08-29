import { describe, it, expect, vi } from "vitest";
import { RetrieveService, PERSONAL_PROFILE_PACK, facetAuthority } from "./index";
import type { MemoryEvent } from "./index";
import { rankFacts, packWithinBudget } from "./retrieve-budget";

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

const fact = (id: string, content: string, confidence = 0.8, facet?: string) => ({
  id,
  content,
  confidence,
  addedAt: "2026-01-01T00:00:00Z",
  ...(facet ? { facet } : {})
});

describe("facetAuthority", () => {
  it("write-protected facets get a bounded boost", () => {
    expect(facetAuthority(PERSONAL_PROFILE_PACK, "goals")).toBeCloseTo(1.25);
  });

  it("write-protected + document-authority facets stack, still bounded", () => {
    expect(facetAuthority(PERSONAL_PROFILE_PACK, "identity")).toBeCloseTo(1.4);
  });

  it("ordinary, unknown, and absent facets carry no boost", () => {
    expect(facetAuthority(PERSONAL_PROFILE_PACK, "notes")).toBe(1);
    expect(facetAuthority(PERSONAL_PROFILE_PACK, "no-such-facet")).toBe(1);
    expect(facetAuthority(PERSONAL_PROFILE_PACK, undefined)).toBe(1);
  });
});

describe("rankFacts — bounded authority", () => {
  it("authority breaks a confidence tie when there is no query", () => {
    const plain = fact("plain", "ordinary note");
    const protectedFact = fact("prot", "core goal");
    const ranked = rankFacts([plain, protectedFact], undefined, (f) => (f.id === "prot" ? 1.25 : 1));
    expect(ranked.map((f) => f.id)).toEqual(["prot", "plain"]);
  });

  it("authority lifts a close-scoring protected fact above an ordinary one", () => {
    const scores: Record<string, number> = { "ordinary match": 0.7, "protected match": 0.6 };
    const ranked = rankFacts(
      [fact("ord", "ordinary match"), fact("prot", "protected match")],
      (content) => scores[content],
      (f) => (f.id === "prot" ? 1.25 : 1)
    );
    // 0.6 * 1.25 = 0.75 > 0.7
    expect(ranked.map((f) => f.id)).toEqual(["prot", "ord"]);
  });

  it("authority is clamped: it adjusts ranking, it never overrides relevance outright", () => {
    const scores: Record<string, number> = { "ordinary match": 0.7, "barely related": 0.4 };
    const ranked = rankFacts(
      [fact("ord", "ordinary match"), fact("prot", "barely related")],
      (content) => scores[content],
      (f) => (f.id === "prot" ? 99 : 1)
    );
    // clamp(99) = 1.5; 0.4 * 1.5 = 0.6 < 0.7 — a runaway multiplier cannot win
    expect(ranked.map((f) => f.id)).toEqual(["ord", "prot"]);
    expect(ranked).toHaveLength(2); // boost, never a filter
  });
});

describe("packWithinBudget — factAuthority plumbs through", () => {
  it("under a binding budget the protected fact is the one kept", () => {
    const ord = fact("ord", "aaaaaaaaaa");
    const prot = fact("prot", "bbbbbbbbbb");
    const packed = packWithinBudget({
      digest: null,
      facts: [ord, prot],
      events: [],
      maxChars: 25, // fact share cap = 10: exactly one 10-char fact fits
      factAuthority: (f) => (f.id === "prot" ? 1.25 : 1)
    });
    expect(packed.facts.map((f) => f.id)).toEqual(["prot"]);
    expect(packed.budget.droppedCounts.fact).toBe(1);
  });
});

describe("retrieve — pinned events get a bounded ranking boost", () => {
  it("an older pinned event outranks an equally relevant newer event", async () => {
    const pinnedOld = event({ id: "p1", content: "xyzzy code alpha", pinned: true, createdAt: new Date("2026-01-01T10:00:00Z") });
    const plainNew = event({ id: "n1", content: "xyzzy code beta", createdAt: new Date("2026-01-01T10:01:00Z") });
    const { digestRepo, memoryRepo } = mockRepos([plainNew, pinnedOld]);
    const service = new RetrieveService(digestRepo, memoryRepo, {});

    const result = await service.retrieve("sc", 2, "xyzzy code");

    expect(result.events[0].id).toBe("p1");
    expect(result.retrieval.matches[0].rankingReason).toContain("pinned");
  });

  it("a pinned but irrelevant event does not outrank a relevant one", async () => {
    const pinnedIrrelevant = event({ id: "p1", content: "nothing here", pinned: true, createdAt: new Date("2026-01-01T10:00:00Z") });
    const relevant = event({ id: "n1", content: "xyzzy code beta", createdAt: new Date("2026-01-01T10:01:00Z") });
    const { digestRepo, memoryRepo } = mockRepos([relevant, pinnedIrrelevant]);
    const service = new RetrieveService(digestRepo, memoryRepo, {});

    const result = await service.retrieve("sc", 2, "xyzzy code");

    expect(result.events[0].id).toBe("n1");
  });
});
