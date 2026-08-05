import { describe, it, expect } from "vitest";
import { selectEventsForDigest } from "./digest-control";
import type { MemoryEvent } from "./index";

function evt(
  id: string,
  type: "document" | "stream",
  chars: number,
  daysAgo: number,
  extra: Partial<MemoryEvent> = {}
): MemoryEvent {
  return {
    id,
    userId: "u",
    scopeId: "s",
    type,
    source: "api",
    key: type === "document" ? id : null,
    content: `${id}:` + "x".repeat(chars),
    createdAt: new Date(Date.UTC(2026, 0, 1) - daysAgo * 86400000),
    classifiedType: null,
    ...extra
  } as MemoryEvent;
}

const budgets = { eventBudgetTotal: 40, eventBudgetDocs: 10, eventBudgetStream: 30 };

function select(events: MemoryEvent[], charBudgetTotal: number) {
  return selectEventsForDigest({ recentEvents: events, ...budgets, charBudgetTotal });
}

describe("pinned events survive the char budget", () => {
  it("keeps a pinned document that would otherwise be dropped for being oldest", () => {
    // 10 documents x 30k = 300k against a 240k budget. The resume is the oldest,
    // so recency ordering drops it entirely — this is the real failure mode:
    // documents compete with documents, and the durable one is always the oldest.
    const events = [
      evt("resume", "document", 30_000, 200, { pinned: true }),
      ...Array.from({ length: 9 }, (_, i) => evt(`doc-${i}`, "document", 30_000, i))
    ];

    const result = select(events, 240_000);
    const resume = result.selectedEvents.find((s) => s.event.id === "resume");

    expect(resume).toBeDefined();
    expect(resume!.event.content).not.toContain("truncated");
  });

  it("drops the same document when it is not pinned (regression baseline)", () => {
    const events = [
      evt("resume", "document", 30_000, 200),
      ...Array.from({ length: 9 }, (_, i) => evt(`doc-${i}`, "document", 30_000, i))
    ];

    const result = select(events, 240_000);

    expect(result.selectedEvents.find((s) => s.event.id === "resume")).toBeUndefined();
  });

  it("orders pinned events ahead of unpinned ones only when the budget binds", () => {
    const events = [
      evt("doc-new", "document", 30_000, 0),
      evt("resume", "document", 30_000, 200, { pinned: true })
    ];

    // Everything fits: original ordering is preserved, no reshuffling.
    const fits = select(events, 240_000);
    expect(fits.selectedEvents.map((s) => s.event.id)).toEqual(["doc-new", "resume"]);

    // Budget binds: pinned goes first so it cannot lose the race.
    const tight = select(events, 35_000);
    expect(tight.selectedEvents[0].event.id).toBe("resume");
  });

  it("pins stream events too — the engine does not decide what matters, the caller does", () => {
    const events = [
      ...Array.from({ length: 8 }, (_, i) => evt(`doc-${i}`, "document", 30_000, i)),
      evt("vow", "stream", 1_000, 300, { pinned: true })
    ];

    const result = select(events, 240_000);

    expect(result.selectedEvents.find((s) => s.event.id === "vow")).toBeDefined();
  });

  it("records loudly when pinned content alone cannot fit", () => {
    const events = [
      evt("pin-a", "document", 200_000, 1, { pinned: true }),
      evt("pin-b", "document", 200_000, 2, { pinned: true })
    ];

    const result = select(events, 240_000);

    expect(result.rationale.some((r) => r.startsWith("pinned_budget_exceeded"))).toBe(true);
  });

  it("does not claim a pinned overflow when everything pinned fits", () => {
    const events = [
      evt("resume", "document", 30_000, 200, { pinned: true }),
      ...Array.from({ length: 9 }, (_, i) => evt(`doc-${i}`, "document", 30_000, i))
    ];

    const result = select(events, 240_000);

    expect(result.rationale.some((r) => r.startsWith("pinned_budget_exceeded"))).toBe(false);
  });
});
