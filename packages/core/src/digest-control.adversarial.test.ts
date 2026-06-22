import { describe, it, expect } from "vitest";
import {
  protectedStateMerge,
  selectEventsForDigest,
  type DeltaCandidate
} from "./digest-control";
import type { MemoryEvent } from "./index";

let seq = 0;
function ev(over: Partial<MemoryEvent> & Pick<MemoryEvent, "content" | "type">): MemoryEvent {
  seq += 1;
  return {
    id: over.id ?? `e${seq}`,
    scopeId: "sc",
    userId: "u",
    source: "api",
    createdAt: over.createdAt ?? new Date(Date.UTC(2026, 0, 1, 0, 0, seq % 60, seq)),
    ...over
  };
}
function idFactory(): () => string {
  let n = 0;
  return () => `fact-adv-${(n += 1)}`;
}
function decision(content: string): DeltaCandidate {
  const event = ev({ type: "stream", content });
  return { eventId: event.id, reason: "stable_fact_signal", features: { kind: "decision", importanceScore: 0.9, noveltyScore: 1 }, event };
}
describe("adversarial: contradiction storm", () => {
  it("keeps the last decision stable under repeated contradictory decisions", () => {
    // Bombard with alternating DB choices; the final merged decision set should reflect
    // the latest non-conflicting state, not accumulate every contradictory option.
    const deltas = [
      decision("we decide to use postgres for storage"),
      decision("we decide to use mysql instead of postgres for storage"),
      decision("we decide to use postgres instead of mysql for storage")
    ];
    const merged = protectedStateMerge({ prevState: null, deltaCandidates: deltas, documents: [], idFactory: idFactory() });
    expect(merged.stableFacts.decisions).toContain("we decide to use postgres instead of mysql for storage");
    expect(merged.stableFacts.decisions).not.toContain("we decide to use mysql instead of postgres for storage");
    // Decision 1 ("...postgres for storage") was removed by decision 2's conflict detection:
    // extractReplacementTarget finds "postgres" from "instead of postgres", and
    // findConflictingDecisions matches it against decision 1's tokens — removing it before
    // decision 2 is added. It does NOT survive as a near-duplicate of decision 3 (Jaccard ≈ 0.71,
    // below the 0.8 merge threshold). The chain fully converges to decision 3 only.
    expect(merged.stableFacts.decisions).not.toContain("we decide to use postgres for storage");
  });
});

describe("adversarial: goal flip-flop", () => {
  it("keeps the document goal stable against alternating stream goals", () => {
    const seed = protectedStateMerge({
      prevState: null,
      deltaCandidates: [],
      documents: [ev({ type: "document", key: "doc:plan", content: "goal: launch the beta" })],
      idFactory: idFactory()
    });
    const flip = protectedStateMerge({
      prevState: seed,
      deltaCandidates: [
        decision("i want to build a mobile game"),
        decision("i want to write a novel"),
        decision("i want to start a restaurant")
      ],
      documents: [],
      idFactory: idFactory()
    });
    expect(flip.stableFacts.goal).toBe("launch the beta");
  });
});

describe("adversarial: noise flood", () => {
  it("preserves a durable decision buried under heavy noise", () => {
    // 30 DISTINCT noise strings: using (i+1)*100 for the index means each string contains a
    // unique ≥3-digit token (100, 200, …, 3000) that passes the length-2 filter in
    // tokenize(). Pairwise Jaccard ≈ 4/6 ≈ 0.67 < 0.92, so dedupeNearDuplicateEvents keeps
    // all 30 — they genuinely compete for budget.
    const events = [
      ev({ type: "stream", content: "we decide to ship api v1" }),
      ...Array.from({ length: 30 }, (_, i) =>
        ev({ type: "stream", content: `random chatter item number ${(i + 1) * 100}` })
      )
    ];
    const result = selectEventsForDigest({
      recentEvents: events,
      lastDigest: null,
      eventBudgetTotal: 3,
      eventBudgetDocs: 0,
      eventBudgetStream: 2
    });
    // (a) The durable decision survives: kind="decision" puts it in durableStreamCandidates,
    // which is NOT bounded by eventBudgetStream and is prepended before contextual noise in
    // the merged array — it is never displaced by the total-budget slice.
    expect(result.selectedEvents.map((s) => s.event.content)).toContain("we decide to ship api v1");
    // (b) Budget genuinely bit: 31 events in, only ≤ 3 selected (28 noise events dropped).
    expect(result.selectedEvents.length).toBe(3);
  });
});

describe("adversarial: document version churn", () => {
  it("reflects the latest document version, dropping a constraint removed in the new version", () => {
    const v1 = protectedStateMerge({
      prevState: null,
      deltaCandidates: [],
      documents: [ev({ type: "document", key: "doc:reqs", content: "constraint: support ie11\nconstraint: ship by friday" })],
      idFactory: idFactory()
    });
    expect(v1.stableFacts.constraints).toContain("support ie11");
    const v2 = protectedStateMerge({
      prevState: v1,
      deltaCandidates: [],
      documents: [ev({ type: "document", key: "doc:reqs", content: "constraint: ship by friday" })],
      idFactory: idFactory()
    });
    // The constraint that was backed only by doc:reqs and dropped in v2 should be removed.
    expect(v2.stableFacts.constraints).not.toContain("support ie11");
    expect(v2.stableFacts.constraints).toContain("ship by friday");
  });
});

describe("adversarial: multilingual mix", () => {
  it("keeps divergent CJK decisions distinct and does not over-merge with English", () => {
    // End-to-end anchor: a multilingual mix does not collapse CJK decisions into one.
    // The two CJK decisions share only 3 CJK bigrams ("我决","决定","定用") out of 5 total
    // tokens (Jaccard ≈ 0.6), which is below the 0.8 decision merge threshold — they stay
    // distinct because the THRESHOLD is not met, not because asciiContentDiverges fires.
    // Non-vacuous coverage of the asciiContentDiverges guard (which prevents over-merge when
    // Jaccard ≥ threshold but ASCII token sets are disjoint) lives in
    // digest-control.property.test.ts.
    const merged = protectedStateMerge({
      prevState: null,
      deltaCandidates: [
        decision("我决定用 PostgreSQL"),
        decision("我决定用 MySQL"),
        decision("we decide to use redis for caching")
      ],
      documents: [],
      idFactory: idFactory()
    });
    expect(merged.stableFacts.decisions).toContain("我决定用 PostgreSQL");
    expect(merged.stableFacts.decisions).toContain("我决定用 MySQL");
    expect(merged.stableFacts.decisions).toContain("we decide to use redis for caching");
  });
});
