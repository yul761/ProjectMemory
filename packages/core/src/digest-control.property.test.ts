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
