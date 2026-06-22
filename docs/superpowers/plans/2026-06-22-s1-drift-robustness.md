# S1 Drift-Robustness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn StateCore's "low drift" claim into stress-tested properties by adding property-based (fast-check) and adversarial regression tests over the pure deterministic functions in `digest-control.ts`, and fixing any real drift bugs they expose.

**Architecture:** Add `fast-check` to `packages/core`. Inject a deterministic `idFactory` into `protectedStateMerge` so merges are reproducible. Add two new test files — one for fast-check properties + generators, one for hand-authored adversarial regression fixtures — leaving the existing example-based `digest-control.test.ts` untouched.

**Tech Stack:** TypeScript, vitest, fast-check.

## Global Constraints

- Test runner: **vitest** (already configured in `packages/core`). Run from repo root with `pnpm --filter @statecore/core test <file>` or inside `packages/core` with `pnpm test <file>` (confirm the exact script in Task 1).
- New dependency: `fast-check` as a **devDependency** of `packages/core` only.
- **No breaking `/v1` changes.** The only source change is the `idFactory` injection in `digest-control.ts`, which is internal and backward-compatible (the parameter is optional and defaults to current behavior).
- Do NOT modify `packages/core/src/digest-control.test.ts` — it is the existing example-based suite and stays as-is.
- Scope is the pure functions only: `normalizeDigestState`, `selectEventsForDigest`, `detectDeltas`, `protectedStateMerge`, `consistencyCheck`, and the CJK guards (`sameFactCjkAware`, `asciiContentDiverges`, `jaccardSimilarity`, `tokenize`). No LLM, no full `runDigestControlPipeline`.
- When a property/fixture FAILS: first decide **real bug vs intended behavior**. Real bug → fix the source (internal, non-breaking). Intended behavior → tighten the property to match reality and add a code comment explaining why. Never weaken a property to silence a genuine bug.

---

### Task 1: Add fast-check + tooling smoke test

**Files:**
- Modify: `packages/core/package.json` (devDependencies + confirm test script)
- Create: `packages/core/src/digest-control.property.test.ts`

**Interfaces:**
- Produces: the `digest-control.property.test.ts` file with shared helpers (`ev`, arbitraries) that later tasks extend.

- [ ] **Step 1: Inspect the test script**

Run: `cat packages/core/package.json`
Confirm there is a `"test"` script (e.g. `"vitest run"`). Note the package `name` (used in `pnpm --filter`).

- [ ] **Step 2: Add fast-check**

Run: `pnpm --filter @statecore/core add -D fast-check@^3.23.0`
(Use the actual package name from Step 1 if it differs.)
Expected: `fast-check` appears under `devDependencies` in `packages/core/package.json`.

- [ ] **Step 3: Create the property test file with shared helpers + a smoke property**

```typescript
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
```

- [ ] **Step 4: Run the smoke test**

Run: `pnpm --filter @statecore/core test digest-control.property`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add packages/core/package.json packages/core/src/digest-control.property.test.ts pnpm-lock.yaml
git commit -m "test(core): add fast-check + property-test scaffold for digest-control"
```

---

### Task 2: Inject deterministic idFactory into protectedStateMerge

**Files:**
- Modify: `packages/core/src/digest-control.ts`
- Test: `packages/core/src/digest-control.property.test.ts`

**Interfaces:**
- Produces: `protectedStateMerge(input: { prevState?; deltaCandidates; documents; idFactory?: () => string }): DigestState`. When `idFactory` is omitted, behavior is unchanged. Internal helpers `promoteToFactRegistry`, `supersedeFact`, `mergeProfileFacets`, `applyProfileFactsFromDigest` gain a trailing `makeId: () => string` parameter.

- [ ] **Step 1: Write the failing determinism test**

Append to `digest-control.property.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @statecore/core test digest-control.property`
Expected: FAIL — either a TypeScript error (`idFactory` not in the input type) or the id assertion fails (current ids are `fact-${Date.now()}-${random}`).

- [ ] **Step 3: Add the default factory and thread it through**

In `digest-control.ts`, add near the top (after the imports):

```typescript
function createDefaultIdFactory(): () => string {
  return () => `fact-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}
```

Change `promoteToFactRegistry` to take `makeId` and use it instead of the inline id:

```typescript
function promoteToFactRegistry(
  state: DigestState,
  content: string,
  type: FactRegistryEntry["type"],
  confidence: number,
  evidence: DigestEvidenceRef,
  makeId: () => string,
  facet?: string
): void {
  if (!state.factRegistry) state.factRegistry = [];
  if (isInFactRegistry(state, content)) return;
  const entry: FactRegistryEntry = {
    id: makeId(),
    content,
    type,
    confidence,
    addedAt: new Date().toISOString(),
    evidenceId: evidence.id,
    evidenceType: evidence.sourceType
  };
  if (facet !== undefined) entry.facet = facet;
  state.factRegistry.push(entry);
}
```

Change `supersedeFact` to take `makeId` and use it for `newId`:

```typescript
function supersedeFact(
  state: DigestState,
  content: string,
  newContent: string,
  evidence: DigestEvidenceRef,
  makeId: () => string,
  overrides?: { facet?: string; confidence?: number; type?: FactRegistryEntry["type"] }
): void {
  if (!state.factRegistry) return;
  const toSupersede = state.factRegistry.find(
    (entry) => !entry.supersededBy && sameFactCjkAware(entry.content, content, 0.6)
  );
  if (!toSupersede) return;
  const newId = makeId();
  toSupersede.supersededBy = newId;
  const newEntry: FactRegistryEntry = {
    id: newId,
    content: newContent,
    type: overrides?.type ?? toSupersede.type,
    confidence: overrides?.confidence ?? toSupersede.confidence,
    addedAt: new Date().toISOString(),
    evidenceId: evidence.id,
    evidenceType: evidence.sourceType
  };
  if (overrides?.facet !== undefined) newEntry.facet = overrides.facet;
  state.factRegistry.push(newEntry);
}
```

Thread `makeId` through the two callers that promote/supersede. Update `mergeProfileFacets` and `applyProfileFactsFromDigest` signatures to accept `makeId: () => string` as a trailing parameter and pass it to their `promoteToFactRegistry`/`supersedeFact` calls. Then in `protectedStateMerge`:

```typescript
export function protectedStateMerge(input: {
  prevState?: DigestState | null;
  deltaCandidates: DeltaCandidate[];
  documents: MemoryEvent[];
  idFactory?: () => string;
}): DigestState {
  const makeId = input.idFactory ?? createDefaultIdFactory();
  // ... existing body, but every promoteToFactRegistry(...) / supersedeFact(...) /
  // mergeProfileFacets(...) / applyProfileFactsFromDigest(...) call now passes makeId.
```

Search for every call site and add `makeId`:

Run: `grep -n "promoteToFactRegistry\|supersedeFact\|mergeProfileFacets(\|applyProfileFactsFromDigest(" packages/core/src/digest-control.ts`
Update each call inside `protectedStateMerge` (and inside `mergeProfileFacets`/`applyProfileFactsFromDigest`) to pass `makeId` in the new position.

- [ ] **Step 4: Run the determinism test + the full existing suite**

Run: `pnpm --filter @statecore/core test digest-control.property`
Expected: PASS.
Run: `pnpm --filter @statecore/core test digest-control`
Expected: the existing `digest-control.test.ts` still PASSES (idFactory defaults preserve behavior).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/digest-control.ts packages/core/src/digest-control.property.test.ts
git commit -m "feat(core): inject deterministic idFactory into protectedStateMerge"
```

---

### Task 3: Properties for normalizeDigestState (total, idempotent, capped)

**Files:**
- Test: `packages/core/src/digest-control.property.test.ts`

**Interfaces:**
- Consumes: `stateArb`, `normalizeDigestState` from Task 1.

- [ ] **Step 1: Write the failing test**

Append:

```typescript
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
```

- [ ] **Step 2: Run to verify pass-or-bug**

Run: `pnpm --filter @statecore/core test digest-control.property`
Expected: PASS if the implementation already satisfies these. If a property FAILS, fast-check prints the minimal counterexample — apply the Global Constraints failure rule (real bug → fix `normalizeDigestState`; intended → tighten property + comment).

- [ ] **Step 3: Resolve any failure**

If any property failed, implement the fix decided in Step 2. Re-run until green.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/digest-control.property.test.ts packages/core/src/digest-control.ts
git commit -m "test(core): property tests for normalizeDigestState (total/idempotent/capped)"
```

---

### Task 4: Properties for selectEventsForDigest (budget, durable preservation, determinism)

**Files:**
- Test: `packages/core/src/digest-control.property.test.ts`

**Interfaces:**
- Consumes: `ev` from Task 1.

- [ ] **Step 1: Write the failing test**

Append:

```typescript
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
        // Every distinct durable event id is present (dedup may collapse exact duplicates).
        const distinctById = new Map(events.map((e) => [e.content, e]));
        for (const e of distinctById.values()) {
          expect(selectedIds.has(e.id)).toBe(true);
        }
      })
    );
  });
});
```

- [ ] **Step 2: Run to verify pass-or-bug**

Run: `pnpm --filter @statecore/core test digest-control.property`
Expected: PASS, or a minimal counterexample. Apply the failure rule. Note: the durable-preservation property is the highest-value one here — if it fails, it is very likely a real drift bug in `selectEventsForDigest` and should be fixed in source.

- [ ] **Step 3: Resolve any failure**

Implement the decided fix. Re-run until green.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/digest-control.property.test.ts packages/core/src/digest-control.ts
git commit -m "test(core): property tests for selectEventsForDigest (budget/durable/determinism)"
```

---

### Task 5: Properties for detectDeltas (durable-always-kept, threshold monotonicity)

**Files:**
- Test: `packages/core/src/digest-control.property.test.ts`

- [ ] **Step 1: Write the failing test**

Append:

```typescript
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
```

Note: `detectDeltas` mutates `selected[i].features.noveltyScore`. Because each `fc.property` run builds fresh `selectedArb` values, the two `detectDeltas` calls in the monotonicity test operate on the same array — that is fine, the kept-set comparison only reads `eventId`.

- [ ] **Step 2: Run to verify pass-or-bug**

Run: `pnpm --filter @statecore/core test digest-control.property`
Expected: PASS or counterexample → apply failure rule.

- [ ] **Step 3: Resolve any failure**

Implement the decided fix. Re-run until green.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/digest-control.property.test.ts packages/core/src/digest-control.ts
git commit -m "test(core): property tests for detectDeltas (durable-kept/threshold-monotonic)"
```

---

### Task 6: Properties for protectedStateMerge (protection, goal anti-flip-flop, determinism)

**Files:**
- Test: `packages/core/src/digest-control.property.test.ts`

**Interfaces:**
- Consumes: `ev`, `deterministicIdFactory` from Task 1; the `idFactory` parameter from Task 2.

- [ ] **Step 1: Write the failing test**

Append:

```typescript
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
        const run = () => protectedStateMerge({ prevState: null, deltaCandidates: deltas, documents: [], idFactory: deterministicIdFactory() });
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
});
```

- [ ] **Step 2: Run to verify pass-or-bug**

Run: `pnpm --filter @statecore/core test digest-control.property`
Expected: PASS or counterexample. These three are the core anti-drift invariants — a failure is most likely a real bug; fix in source per the failure rule (only tighten the property if the "violation" is genuinely intended, e.g. a delta string fast-check generated that legitimately parses as a goal restatement).

- [ ] **Step 3: Resolve any failure**

Implement the decided fix. Re-run until green.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/digest-control.property.test.ts packages/core/src/digest-control.ts
git commit -m "test(core): property tests for protectedStateMerge (protection/goal-stability/determinism)"
```

---

### Task 7: Properties for consistencyCheck (no false positive on clean state, catches contradictions)

**Files:**
- Test: `packages/core/src/digest-control.property.test.ts`

**Interfaces:**
- Consumes: `consistencyCheck`. Its input is `{ output: DigestOutput; previousDigest?; protectedState: DigestState }`.

- [ ] **Step 1: Write the failing test**

Append:

```typescript
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
```

- [ ] **Step 2: Run to verify pass-or-bug**

Run: `pnpm --filter @statecore/core test digest-control.property`
Expected: PASS or counterexample → apply failure rule.

- [ ] **Step 3: Resolve any failure**

Implement the decided fix. Re-run until green.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/digest-control.property.test.ts packages/core/src/digest-control.ts
git commit -m "test(core): property tests for consistencyCheck (clean-pass/contradiction-catch)"
```

---

### Task 8: CJK guard properties (disjoint-ASCII never merges, pure-CJK not falsely merged)

**Files:**
- Test: `packages/core/src/digest-control.property.test.ts`

**Interfaces:**
- The CJK guards (`sameFactCjkAware`, `asciiContentDiverges`) are NOT exported. Test them through `protectedStateMerge`, which is the precision-critical site that uses them.

- [ ] **Step 1: Write the failing test**

Append:

```typescript
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

  it("treats two genuinely different pure-CJK decisions as distinct", () => {
    const pairArb = fc.constantFrom(
      ["我喜欢喝茶", "我喜欢爬山"],
      ["项目要上线", "团队要扩招"]
    );
    fc.assert(
      fc.property(pairArb, ([a, b]) => {
        const merged = protectedStateMerge({
          prevState: null,
          deltaCandidates: [decisionDelta(a), decisionDelta(b)],
          documents: [],
          idFactory: deterministicIdFactory()
        });
        // Two unrelated Chinese facts must not collapse into one via the empty-normalization pitfall.
        expect(merged.stableFacts.decisions).toContain(a);
        expect(merged.stableFacts.decisions).toContain(b);
      })
    );
  });
});
```

- [ ] **Step 2: Run to verify pass-or-bug**

Run: `pnpm --filter @statecore/core test digest-control.property`
Expected: PASS or counterexample → apply failure rule (a CJK over-merge is a real correctness bug; fix in source).

- [ ] **Step 3: Resolve any failure**

Implement the decided fix. Re-run until green.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/digest-control.property.test.ts packages/core/src/digest-control.ts
git commit -m "test(core): CJK over-merge guard properties via protectedStateMerge"
```

---

### Task 9: Adversarial regression fixtures (the 5 synthetic patterns)

**Files:**
- Create: `packages/core/src/digest-control.adversarial.test.ts`

**Interfaces:**
- Consumes: `protectedStateMerge`, `selectEventsForDigest`, `consistencyCheck` from `digest-control.ts`. Re-declare local `ev` / `deterministicIdFactory` helpers (test files are independent; do not import from the property test file).

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/digest-control.adversarial.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  protectedStateMerge,
  selectEventsForDigest,
  type DigestState,
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
function noise(content: string): DeltaCandidate {
  const event = ev({ type: "stream", content });
  return { eventId: event.id, reason: "novel_event", features: { kind: "note", importanceScore: 0.2, noveltyScore: 1 }, event };
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
    const events = [
      ev({ type: "stream", content: "we decide to ship api v1" }),
      ...Array.from({ length: 30 }, () => ev({ type: "stream", content: "ok" }))
    ];
    const selected = selectEventsForDigest({ recentEvents: events, lastDigest: null, eventBudgetTotal: 5, eventBudgetDocs: 0, eventBudgetStream: 2 });
    expect(selected.selectedEvents.map((s) => s.event.content)).toContain("we decide to ship api v1");
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
```

- [ ] **Step 2: Run to verify pass-or-bug**

Run: `pnpm --filter @statecore/core test digest-control.adversarial`
Expected: PASS, or a concrete failing assertion. These fixtures encode intended anti-drift behavior; a failure is a real bug → fix in source per the failure rule. If a fixture's expectation turns out to encode behavior the algorithm intentionally does not provide, adjust the fixture and document why in a comment.

- [ ] **Step 3: Resolve any failure**

Implement the decided fix in `digest-control.ts`. Re-run until green.

- [ ] **Step 4: Run the full core suite to confirm no regressions**

Run: `pnpm --filter @statecore/core test`
Expected: all suites PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/digest-control.adversarial.test.ts packages/core/src/digest-control.ts
git commit -m "test(core): adversarial regression fixtures for the 5 synthetic drift patterns"
```

---

## Self-Review

**Spec coverage:**
- Scope = pure functions → Tasks 3–8 cover normalize/select/detectDeltas/protectedStateMerge/consistencyCheck/CJK; Global Constraints pin the boundary. ✓
- idFactory refactor → Task 2. ✓
- fast-check tooling + two test files (property + adversarial) → Tasks 1 and 9. ✓
- Invariant table rows → normalize (Task 3), select (Task 4), detectDeltas (Task 5), protectedStateMerge a/b/c/d/e (Task 6, plus determinism), consistencyCheck (Task 7), CJK (Task 8). Note: protectedStateMerge cap-eviction-order (invariant d) is exercised indirectly via the protection property in Task 6 and the contradiction-storm fixture in Task 9; a dedicated cap-eviction property can be added if Task 6 review finds it under-covered. ✓
- 5 adversarial patterns → Task 9 (one describe block each), with generative coverage also in Tasks 4/6/8. ✓
- Failure handling rule (real bug vs intended) → Global Constraints + repeated in each task's Step 2. ✓

**Placeholder scan:** No "TBD"/"handle edge cases"/bare "write tests" — every test step contains runnable code. ✓

**Type consistency:** `ev`, `deterministicIdFactory`/`idFactory`, `decisionDelta`/`decision`, `noiseDelta`/`noise` are defined per-file (property file vs adversarial file are independent, as Task 9 notes). `protectedStateMerge` gains `idFactory?: () => string` in Task 2 and every later task passes it consistently. `consistencyCheck` input shape matches the source (`output`/`previousDigest`/`protectedState`). ✓
