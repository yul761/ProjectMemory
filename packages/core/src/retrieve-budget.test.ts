import { describe, it, expect } from "vitest";
import {
  packWithinBudget,
  rankFacts,
  FACT_BUDGET_SHARE,
  MAX_DROP_DETAIL_ITEMS,
  type BudgetFact,
  type BudgetEvent
} from "./retrieve-budget";

function fact(id: string, content: string, confidence = 0.5, addedAt = "2026-01-01T00:00:00.000Z"): BudgetFact {
  return { id, content, confidence, addedAt };
}
function event(id: string, chars: number): BudgetEvent {
  // Distinguishable content so a test can tell which event a result carried.
  return { id, content: `${id}:${"x".repeat(Math.max(0, chars - id.length - 1))}` };
}
/** Counts the word "camera" — a stand-in for the real heuristic scorer. */
const cameraScorer = (content: string) => (content.match(/camera/g) ?? []).length;

describe("the budget packs whole items and says what it refused", () => {
  it("never cuts a fact in half", () => {
    // Half a fact is not a shortened fact, it is a false one: "Allergic to
    // penicillin" truncated at 12 chars reads "Allergic to". The rule is whole
    // items only, at every layer.
    const long = fact("f1", "x".repeat(400));
    const out = packWithinBudget({ digest: null, facts: [long], events: [], maxChars: 200 });
    expect(out.facts).toHaveLength(0);
    expect(out.budget.droppedCounts.fact).toBe(1);
  });

  it("never cuts an event in half", () => {
    const out = packWithinBudget({ digest: null, facts: [], events: [event("e1", 400)], maxChars: 200 });
    expect(out.events).toHaveLength(0);
    expect(out.budget.droppedCounts.event).toBe(1);
  });

  it("keeps looking after an item that does not fit", () => {
    // The defect this covers: the harness's build_prompt used `break`, so one
    // oversized item hid every smaller item ranked below it. That made the score
    // a function of item size rather than retrieval quality — measured at 70%
    // budget fill for StateCore while mem0, which returns short items, never hit
    // the wall at all.
    const out = packWithinBudget({
      digest: null,
      facts: [],
      events: [event("huge", 5000), event("small", 100)],
      maxChars: 1000
    });
    expect(out.events.map((e) => e.id)).toEqual(["small"]);
    expect(out.budget.droppedCounts.event).toBe(1);
  });

  it("drops the digest whole rather than truncating it", () => {
    // Half a summary is not a summary.
    const out = packWithinBudget({ digest: "d".repeat(500), facts: [], events: [], maxChars: 100 });
    expect(out.digest).toBeNull();
    expect(out.budget.dropped.map((d) => d.reason)).toContain("digest_too_large");
    expect(out.budget.droppedCounts.digest).toBe(1);
  });

  it("caps facts at the declared share so events always have room", () => {
    // A scope used for a year holds hundreds of facts. Without the cap they eat
    // the whole budget and the caller gets no raw evidence at all — the mirror
    // image of the 4k result, and just as bad.
    const facts = Array.from({ length: 300 }, (_, i) => fact(`f${i}`, "y".repeat(86)));
    const out = packWithinBudget({
      digest: null,
      facts,
      events: [event("e1", 1000)],
      maxChars: 16000
    });
    expect(out.budget.factChars).toBeLessThanOrEqual(Math.floor(16000 * FACT_BUDGET_SHARE));
    expect(out.events).toHaveLength(1);
    expect(out.budget.droppedCounts.fact).toBeGreaterThan(0);
    expect(out.budget.dropped.some((d) => d.reason === "fact_share_cap")).toBe(true);
  });

  it("does not invoke the cap when the facts already fit", () => {
    const facts = Array.from({ length: 5 }, (_, i) => fact(`f${i}`, "y".repeat(50)));
    const out = packWithinBudget({ digest: null, facts, events: [], maxChars: 16000 });
    expect(out.facts).toHaveLength(5);
    expect(out.budget.droppedCounts.fact).toBe(0);
  });

  it("accounts for every candidate: included plus dropped equals offered", () => {
    // The invariant that makes the report trustworthy. Anything that is neither
    // returned nor recorded has vanished silently, which is the exact defect
    // class this feature must not reintroduce.
    const facts = Array.from({ length: 40 }, (_, i) => fact(`f${i}`, "y".repeat(200)));
    const events = Array.from({ length: 40 }, (_, i) => event(`e${i}`, 500));
    const out = packWithinBudget({ digest: "d".repeat(100), facts, events, maxChars: 6000 });

    expect(out.facts.length + out.budget.droppedCounts.fact).toBe(40);
    expect(out.events.length + out.budget.droppedCounts.event).toBe(40);
    expect((out.digest ? 1 : 0) + out.budget.droppedCounts.digest).toBe(1);
  });

  it("never reports using more than the budget", () => {
    const facts = Array.from({ length: 40 }, (_, i) => fact(`f${i}`, "y".repeat(200)));
    const events = Array.from({ length: 40 }, (_, i) => event(`e${i}`, 500));
    const out = packWithinBudget({ digest: "d".repeat(100), facts, events, maxChars: 6000 });
    expect(out.budget.usedChars).toBeLessThanOrEqual(6000);
  });

  it("bounds the drop detail but says how much it bounded", () => {
    // A bounded report is not a silent one. The counts stay exact; only the
    // itemised list is capped, and the cap is stated.
    const facts = Array.from({ length: 400 }, (_, i) => fact(`f${i}`, "y".repeat(200)));
    const out = packWithinBudget({ digest: null, facts, events: [], maxChars: 1000 });
    expect(out.budget.dropped.length).toBe(MAX_DROP_DETAIL_ITEMS);
    expect(out.budget.droppedCounts.fact).toBe(400 - out.facts.length);
    expect(out.budget.itemsOmitted).toBe(out.budget.droppedCounts.fact - MAX_DROP_DETAIL_ITEMS);
  });

  it("reports zero omitted when every drop is itemised", () => {
    const out = packWithinBudget({ digest: null, facts: [], events: [event("e1", 5000)], maxChars: 100 });
    expect(out.budget.itemsOmitted).toBe(0);
    expect(out.budget.dropped).toHaveLength(1);
  });

  it("handles a scope with nothing in it", () => {
    // A new scope has no digest, no facts and no events. Empty is a legitimate
    // answer, not an error, and the report must still reconcile.
    const out = packWithinBudget({ digest: null, facts: [], events: [], maxChars: 4000 });
    expect(out.budget.usedChars).toBe(0);
    expect(out.budget.droppedCounts).toEqual({ digest: 0, fact: 0, event: 0 });
    expect(out.budget.dropped).toHaveLength(0);
    expect(out.budget.itemsOmitted).toBe(0);
  });

  it("never returns more events than it was offered", () => {
    // `limit` binds upstream: retrieve() already sliced its ranked events to
    // `limit` before the packer sees them, so the packer can only ever shrink
    // that list. This is the concrete meaning of "whichever binds first wins".
    const events = [event("e1", 10), event("e2", 10)];
    const out = packWithinBudget({ digest: null, facts: [], events, maxChars: 1_000_000 });
    expect(out.events).toHaveLength(2);
  });
});

describe("facts are ranked before they compete for the budget", () => {
  it("ranks by relevance when a scorer is given", () => {
    const facts = [
      fact("irrelevant", "Prefers oat milk"),
      fact("relevant", "Researching a trail camera, cellular and solar capable")
    ];
    expect(rankFacts(facts, cameraScorer).map((f) => f.id)).toEqual(["relevant", "irrelevant"]);
  });

  it("falls back to confidence then recency when there is no query", () => {
    // retrieve()'s query is optional. Without one there is no relevance signal,
    // and inventing one would be worse than admitting the fallback.
    const facts = [
      fact("old-sure", "a", 0.9, "2026-01-01T00:00:00.000Z"),
      fact("new-unsure", "b", 0.2, "2026-06-01T00:00:00.000Z"),
      fact("new-sure", "c", 0.9, "2026-06-01T00:00:00.000Z")
    ];
    expect(rankFacts(facts).map((f) => f.id)).toEqual(["new-sure", "old-sure", "new-unsure"]);
  });

  it("keeps the highest scoring facts when the cap binds", () => {
    const facts = [
      ...Array.from({ length: 50 }, (_, i) => fact(`dull${i}`, "y".repeat(86))),
      fact("hit", "camera ".repeat(12))
    ];
    const out = packWithinBudget({
      digest: null,
      facts,
      events: [],
      maxChars: 1000,
      scoreFact: cameraScorer
    });
    expect(out.facts.map((f) => f.id)).toContain("hit");
  });

  it("records the score on a drop so the refusal can be explained", () => {
    const facts = [
      fact("hit", "camera camera"),
      ...Array.from({ length: 50 }, (_, i) => fact(`dull${i}`, "y".repeat(200)))
    ];
    const out = packWithinBudget({ digest: null, facts, events: [], maxChars: 500, scoreFact: cameraScorer });
    const drop = out.budget.dropped.find((d) => d.kind === "fact");
    expect(drop?.score).toBe(0);
  });
});
