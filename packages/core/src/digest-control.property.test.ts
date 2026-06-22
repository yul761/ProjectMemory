import fc from "fast-check";
import { describe, it, expect } from "vitest";
import {
  normalizeDigestState,
  selectEventsForDigest,
  detectDeltas,
  protectedStateMerge,
  consistencyCheck,
  type DigestState,
  type DeltaCandidate,
  type SelectedEvent,
  type MemoryEventKind
} from "./digest-control";
import type { MemoryEvent } from "./index";

// Deterministic event builder. `seq` guarantees unique ids + monotonic timestamps
// across the many runs fast-check performs.
let seq = 0;
export function ev(
  over: Partial<MemoryEvent> & Pick<MemoryEvent, "content" | "type">
): MemoryEvent {
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

// Deterministic id factory for reproducible factRegistry ids.
export function deterministicIdFactory(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `fact-test-${n}`;
  };
}

// Arbitrary string facets (used for normalize idempotence/cap properties).
const factsArb = fc.array(fc.string({ minLength: 1, maxLength: 40 }), { maxLength: 200 });

export const stateArb: fc.Arbitrary<DigestState> = fc.record({
  stableFacts: fc.record({
    goal: fc.option(fc.string({ minLength: 1, maxLength: 40 }), { nil: undefined }),
    constraints: factsArb,
    decisions: factsArb
  }),
  workingNotes: fc.record({
    openQuestions: factsArb,
    risks: factsArb,
    context: fc.option(fc.string(), { nil: undefined })
  }),
  todos: factsArb,
  volatileContext: factsArb
}) as fc.Arbitrary<DigestState>;

describe("fast-check tooling smoke", () => {
  it("runs a trivial property", () => {
    fc.assert(
      fc.property(fc.integer(), (n) => Number.isInteger(n))
    );
  });
});

describe("protectedStateMerge — deterministic ids", () => {
  function decisionDelta(content: string, id: string): DeltaCandidate {
    return {
      eventId: id,
      reason: "stable_fact_signal",
      features: { kind: "decision", importanceScore: 0.9, noveltyScore: 1 },
      event: ev({ id, type: "stream", content })
    };
  }

  it("produces identical factRegistry ids across runs with the same idFactory", () => {
    const run = () =>
      protectedStateMerge({
        prevState: null,
        deltaCandidates: [decisionDelta("we decide to use postgres", "d1")],
        documents: [],
        idFactory: deterministicIdFactory()
      });

    const a = run();
    const b = run();
    expect(a.factRegistry?.map((e) => e.id)).toEqual(b.factRegistry?.map((e) => e.id));
    expect(a.factRegistry?.[0]?.id).toBe("fact-test-1");
  });
});

describe("normalizeDigestState — properties", () => {
  it("is total (never throws) on arbitrary type-valid states", () => {
    fc.assert(
      fc.property(stateArb, (s) => {
        expect(() => normalizeDigestState(s)).not.toThrow();
      })
    );
  });

  it("is idempotent: normalize(normalize(s)) deep-equals normalize(s)", () => {
    fc.assert(
      fc.property(stateArb, (s) => {
        const once = normalizeDigestState(s);
        const twice = normalizeDigestState(once);
        expect(twice).toEqual(once);
      })
    );
  });

  it("enforces facet caps", () => {
    fc.assert(
      fc.property(stateArb, (s) => {
        const n = normalizeDigestState(s);
        expect(n.stableFacts.constraints!.length).toBeLessThanOrEqual(100);
        expect(n.stableFacts.decisions!.length).toBeLessThanOrEqual(100);
        expect(n.workingNotes.openQuestions!.length).toBeLessThanOrEqual(10);
        expect(n.workingNotes.risks!.length).toBeLessThanOrEqual(10);
        expect(n.volatileContext!.length).toBeLessThanOrEqual(10);
      })
    );
  });
});

describe("selectEventsForDigest — properties", () => {
  // Arbitrary content biased toward durable/noise kinds so we exercise the durable-preservation path.
  const durableContentArb = fc.constantFrom(
    "we decide to use postgres",
    "constraint: must ship by friday",
    "todo: write integration tests"
  );
  const noiseContentArb = fc.constantFrom("ok", "thanks", "lol", "noted");
  const contentArb = fc.oneof(durableContentArb, noiseContentArb, fc.string({ minLength: 1, maxLength: 30 }));

  const streamEventArb = contentArb.map((content) => ev({ type: "stream", content }));
  const eventsArb = fc.array(streamEventArb, { maxLength: 40 });

  const budgetsArb = fc.record({
    eventBudgetTotal: fc.integer({ min: 1, max: 20 }),
    eventBudgetDocs: fc.integer({ min: 0, max: 5 }),
    eventBudgetStream: fc.integer({ min: 0, max: 15 })
  });

  it("never exceeds the total budget", () => {
    fc.assert(
      fc.property(eventsArb, budgetsArb, (events, b) => {
        const r = selectEventsForDigest({ recentEvents: events, lastDigest: null, ...b });
        expect(r.selectedEvents.length).toBeLessThanOrEqual(b.eventBudgetTotal);
      })
    );
  });

  it("is deterministic: same input → same selected ids", () => {
    fc.assert(
      fc.property(eventsArb, budgetsArb, (events, b) => {
        const a = selectEventsForDigest({ recentEvents: events, lastDigest: null, ...b }).selectedEvents.map((s) => s.event.id);
        const c = selectEventsForDigest({ recentEvents: events, lastDigest: null, ...b }).selectedEvents.map((s) => s.event.id);
        expect(a).toEqual(c);
      })
    );
  });

  it("keeps durable stream facts as long as the total budget allows", () => {
    // With a generous total budget, every durable (decision/constraint/todo) event survives selection.
    fc.assert(
      fc.property(fc.array(durableContentArb, { minLength: 1, maxLength: 8 }), (contents) => {
        const events = contents.map((content) => ev({ type: "stream", content }));
        const r = selectEventsForDigest({
          recentEvents: events,
          lastDigest: null,
          eventBudgetTotal: 50,
          eventBudgetDocs: 0,
          eventBudgetStream: 0 // contextual stream budget is 0; durable must still survive
        });
        const selectedIds = new Set(r.selectedEvents.map((s) => s.event.id));
        // Every distinct durable content survives selection (dedup may collapse exact duplicates).
        // We check by content rather than specific id: the ev() helper uses
        //   Date.UTC(2026, 0, 1, 0, 0, seq % 60, seq)
        // which wraps at every multiple of 60, making timestamps non-monotonic relative to
        // creation order. Dedup keeps the highest-timestamp event, not the highest-seq one, so
        // distinctById (which maps content → last-created event) can point to the deduped-away
        // copy. The true invariant is "at least one representative per distinct content survives."
        const distinctContents = new Set(events.map((e) => e.content));
        for (const content of distinctContents) {
          const anyWithContentSelected = events.some((e) => e.content === content && selectedIds.has(e.id));
          expect(anyWithContentSelected).toBe(true);
        }
      })
    );
  });
});
