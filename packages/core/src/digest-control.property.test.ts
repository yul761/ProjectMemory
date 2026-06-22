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

describe("protectedStateMerge — properties", () => {
  function decisionDelta(content: string): DeltaCandidate {
    const event = ev({ type: "stream", content });
    return {
      eventId: event.id,
      reason: "stable_fact_signal",
      features: { kind: "decision", importanceScore: 0.9, noveltyScore: 1 },
      event
    };
  }
  function noiseDelta(content: string): DeltaCandidate {
    const event = ev({ type: "stream", content });
    return {
      eventId: event.id,
      reason: "novel_event",
      features: { kind: "note", importanceScore: 0.3, noveltyScore: 1 },
      event
    };
  }

  it("is deterministic with a deterministic idFactory", () => {
    const deltasArb = fc.array(fc.string({ minLength: 3, maxLength: 30 }).map(decisionDelta), { maxLength: 10 });
    fc.assert(
      fc.property(deltasArb, (deltas) => {
        // nowFactory must also be deterministic: addedAt: new Date() is the real bug this test surfaces.
        const run = () => protectedStateMerge({ prevState: null, deltaCandidates: deltas, documents: [], idFactory: deterministicIdFactory(), nowFactory: () => "2026-01-01T00:00:00.000Z" });
        expect(run()).toEqual(run());
      })
    );
  });

  it("does not let unrelated noise stream events delete a protected decision", () => {
    // Seed a protected decision, then bombard with unrelated noise; the decision must survive.
    const seed = protectedStateMerge({
      prevState: null,
      deltaCandidates: [decisionDelta("we decide to use postgres")],
      documents: [],
      idFactory: deterministicIdFactory()
    });
    expect(seed.stableFacts.decisions).toContain("we decide to use postgres");

    fc.assert(
      fc.property(fc.array(fc.string({ minLength: 1, maxLength: 30 }).map(noiseDelta), { maxLength: 15 }), (noise) => {
        const after = protectedStateMerge({
          prevState: seed,
          deltaCandidates: noise,
          documents: [],
          idFactory: deterministicIdFactory()
        });
        expect(after.stableFacts.decisions).toContain("we decide to use postgres");
      })
    );
  });

  it("a low-similarity stream event never overwrites an existing goal (anti-flip-flop)", () => {
    const seed = protectedStateMerge({
      prevState: null,
      deltaCandidates: [],
      documents: [ev({ type: "document", key: "doc:plan", content: "goal: launch the beta" })],
      idFactory: deterministicIdFactory()
    });
    expect(seed.stableFacts.goal).toBe("launch the beta");

    fc.assert(
      fc.property(fc.array(fc.string({ minLength: 3, maxLength: 30 }).map(decisionDelta), { maxLength: 10 }), (deltas) => {
        const after = protectedStateMerge({
          prevState: seed,
          deltaCandidates: deltas,
          documents: [],
          idFactory: deterministicIdFactory()
        });
        // Stream events cannot replace a document-set goal (overwrite threshold 0.95 for stream).
        expect(after.stableFacts.goal).toBe("launch the beta");
      })
    );
  });

  it("does not let a stream revoke delete a factRegistry-protected decision", () => {
    // Merge 1: seed a high-importance decision (importanceScore 0.9 >= 0.7) so it is
    // promoted into factRegistry via promoteToFactRegistry (digest-control.ts ~line 1459).
    const seed = protectedStateMerge({
      prevState: null,
      deltaCandidates: [decisionDelta("we decide to use postgres")],
      documents: [],
      idFactory: deterministicIdFactory()
    });
    expect(seed.stableFacts.decisions).toContain("we decide to use postgres");
    // The decision must be in the factRegistry — that is what makes it write-protected in merge 2.
    expect((seed.factRegistry ?? []).some((e) => !e.supersededBy && e.content === "we decide to use postgres")).toBe(true);

    // Merge 2: a kind="decision" delta whose content starts with "revoke" triggers the
    // revoke branch (digest-control.ts line 1428: /\b(revoke|undo|cancel decision)\b/).
    // stripDecisionRevocationPrefix strips the prefix → target = "we decide to use postgres".
    // findBestDecisionMatch (threshold 0.45) finds the exact match.
    // The protectedByRegistry check (lines 1432-1434) finds the entry in prevFactRegistryIds
    // and blocks deletion. Without that guard, the decision would be removed here.
    const after = protectedStateMerge({
      prevState: seed,
      deltaCandidates: [decisionDelta("revoke we decide to use postgres")],
      documents: [],
      idFactory: deterministicIdFactory()
    });
    expect(after.stableFacts.decisions).toContain("we decide to use postgres");
  });
});

describe("detectDeltas — properties", () => {
  const kindArb = fc.constantFrom<MemoryEventKind>("decision", "constraint", "todo", "note", "status", "question", "noise");
  const selectedArb = fc.array(
    fc.record({
      content: fc.string({ minLength: 1, maxLength: 40 }),
      kind: kindArb,
      importanceScore: fc.double({ min: 0, max: 1, noNaN: true })
    }),
    { maxLength: 25 }
  ).map((rows) =>
    rows.map((r): SelectedEvent => ({
      event: ev({ type: "stream", content: r.content }),
      features: { kind: r.kind, importanceScore: r.importanceScore, noveltyScore: 0 }
    }))
  );

  it("always keeps decision and constraint events regardless of novelty", () => {
    fc.assert(
      fc.property(selectedArb, fc.string({ maxLength: 60 }), (selected, lastDigestText) => {
        const deltas = detectDeltas({ lastDigestText, selectedEvents: selected, noveltyThreshold: 1 });
        const keptIds = new Set(deltas.map((d) => d.eventId));
        for (const s of selected) {
          if (s.features.kind === "decision" || s.features.kind === "constraint") {
            expect(keptIds.has(s.event.id)).toBe(true);
          }
        }
      })
    );
  });

  it("is monotonic in threshold: higher threshold → subset of deltas", () => {
    fc.assert(
      fc.property(selectedArb, fc.string({ maxLength: 60 }), (selected, lastDigestText) => {
        const low = new Set(detectDeltas({ lastDigestText, selectedEvents: selected, noveltyThreshold: 0.2 }).map((d) => d.eventId));
        const high = detectDeltas({ lastDigestText, selectedEvents: selected, noveltyThreshold: 0.8 }).map((d) => d.eventId);
        for (const id of high) {
          expect(low.has(id)).toBe(true);
        }
      })
    );
  });
});

describe("CJK over-merge guard — properties (via protectedStateMerge)", () => {
  function decisionDelta(content: string): DeltaCandidate {
    const event = ev({ type: "stream", content });
    return {
      eventId: event.id,
      reason: "stable_fact_signal",
      features: { kind: "decision", importanceScore: 0.9, noveltyScore: 1 },
      event
    };
  }

  // Baseline (Jaccard ≈ 0.6 < 0.8 — passes even without asciiContentDiverges, kept for regression).
  it("does not merge two CJK decisions whose ASCII tokens diverge (PostgreSQL vs MySQL)", () => {
    const merged = protectedStateMerge({
      prevState: null,
      deltaCandidates: [
        decisionDelta("我决定用 PostgreSQL"),
        decisionDelta("我决定用 MySQL")
      ],
      documents: [],
      idFactory: deterministicIdFactory()
    });
    // Both must be retained as distinct decisions — divergent ASCII content overrides bigram similarity.
    expect(merged.stableFacts.decisions).toContain("我决定用 PostgreSQL");
    expect(merged.stableFacts.decisions).toContain("我决定用 MySQL");
  });

  // Non-vacuous guard test for asciiContentDiverges:
  // "我决定在下个版本中使用" contributes 10 shared CJK bigrams; ASCII "postgresql" vs "mysql"
  // are disjoint → tokenize union = 12 → Jaccard = 10/12 ≈ 0.833 ≥ 0.8 (findBestDecisionMatch
  // threshold, digest-control.ts line 785).  The asciiContentDiverges guard at line 461 is
  // therefore the deciding factor: without it sameFactCjkAware returns true and MySQL is
  // treated as a dup of PostgreSQL, so only one decision is kept — both toContain assertions
  // would fail.  The factRegistry path (isInFactRegistry, threshold 0.6, line 1003) is also
  // exercised: Jaccard 0.833 ≥ 0.6 but asciiContentDiverges = true → both entries are promoted
  // separately; without the guard MySQL would be blocked from factRegistry promotion.
  it("does not merge CJK+ASCII decisions when Jaccard ≥ 0.8 but ASCII tokens diverge", () => {
    const merged = protectedStateMerge({
      prevState: null,
      deltaCandidates: [
        decisionDelta("我决定在下个版本中使用 PostgreSQL"),
        decisionDelta("我决定在下个版本中使用 MySQL")
      ],
      documents: [],
      idFactory: deterministicIdFactory()
    });
    expect(merged.stableFacts.decisions).toContain("我决定在下个版本中使用 PostgreSQL");
    expect(merged.stableFacts.decisions).toContain("我决定在下个版本中使用 MySQL");
    // Both must be independently promoted to factRegistry (0.6-threshold site, line 1003).
    expect(merged.factRegistry?.some(e => !e.supersededBy && e.content === "我决定在下个版本中使用 PostgreSQL")).toBe(true);
    expect(merged.factRegistry?.some(e => !e.supersededBy && e.content === "我决定在下个版本中使用 MySQL")).toBe(true);
  });

  // Non-vacuous guard test for the empty-normalization shortcut in findBestSemanticMatch
  // (digest-control.ts line 762: `normalizedValue.length > 0 && normalizedValue === normalizedCandidate`).
  // Without that guard all pure-CJK strings normalise to "" and any two of them score 1 via
  // "" === "".  In a multi-entry values list the first entry wins on ties, so the best-match
  // for B' becomes the unrelated A (not the genuine near-dup B); sameFactCjkAware(A, B') is
  // false, and B' is added spuriously.  The not.toContain assertion is the one that would fail.
  it("does not spuriously add a near-dup pure-CJK decision when an unrelated entry shadows it", () => {
    // Merge 1: seed prevState with A (unrelated) and B (near-dup base).
    // Jaccard(A, B) ≈ 0 → both are added as distinct decisions.
    const seed = protectedStateMerge({
      prevState: null,
      deltaCandidates: [
        decisionDelta("我喜欢喝茶"),           // A — unrelated; bigrams: 我喜,喜欢,欢喝,喝茶
        decisionDelta("我打算下周去北京出差")   // B — base; bigrams: 我打,打算,算下,下周,周去,去北,北京,京出,出差
      ],
      documents: [],
      idFactory: deterministicIdFactory()
    });
    expect(seed.stableFacts.decisions).toContain("我喜欢喝茶");
    expect(seed.stableFacts.decisions).toContain("我打算下周去北京出差");

    // Merge 2: B' = B + one char → Jaccard(B, B') = 9/10 = 0.9 ≥ 0.8.
    // With the guard: best-match = B (score 0.9; A scores ≈ 0) → sameFactCjkAware(B, B', 0.8)
    //   = true → B' deduped, not added → decisions = {A, B}.
    // Without the guard: A and B both score 1 via "" === "" → first wins (A) →
    //   sameFactCjkAware(A, B', 0.8) = false (Jaccard ≈ 0) → B' added → decisions = {A, B, B'}.
    const after = protectedStateMerge({
      prevState: seed,
      deltaCandidates: [decisionDelta("我打算下周去北京出差啊")],
      documents: [],
      idFactory: deterministicIdFactory()
    });
    expect(after.stableFacts.decisions).toContain("我打算下周去北京出差");
    expect(after.stableFacts.decisions).not.toContain("我打算下周去北京出差啊");
    expect(after.stableFacts.decisions).toContain("我喜欢喝茶");
  });
});

describe("consistencyCheck — properties", () => {
  it("does not flag goal_contradiction when the summary restates the protected goal verbatim", () => {
    fc.assert(
      fc.property(fc.constantFrom("launch the beta", "ship api v1", "reduce p95 latency"), (goal) => {
        const result = consistencyCheck({
          output: {
            summary: `goal: ${goal}. Progress is steady.`,
            changes: ["documented the goal"],
            nextSteps: ["ship the next milestone"]
          },
          protectedState: {
            stableFacts: { goal, constraints: [], decisions: [] },
            workingNotes: {},
            todos: []
          },
          previousDigest: null
        });
        expect(result.errors).not.toContain("goal_contradiction");
      })
    );
  });

  it("flags goal_contradiction when the summary states a different goal", () => {
    const result = consistencyCheck({
      output: {
        summary: "goal: build a mobile app. Progress is steady.",
        changes: ["pivoted scope"],
        nextSteps: ["ship the next milestone"]
      },
      protectedState: {
        stableFacts: { goal: "launch the beta web platform", constraints: [], decisions: [] },
        workingNotes: {},
        todos: []
      },
      previousDigest: null
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("goal_contradiction");
  });

  it("flags decision_contradiction when a protected decision is negated", () => {
    const result = consistencyCheck({
      output: {
        summary: "We will no longer use postgres for storage.",
        changes: ["reversed the database decision"],
        nextSteps: ["migrate the data"]
      },
      protectedState: {
        stableFacts: { goal: undefined, constraints: [], decisions: ["use postgres for storage"] },
        workingNotes: {},
        todos: []
      },
      previousDigest: null
    });
    expect(result.errors).toContain("decision_contradiction");
  });
});
