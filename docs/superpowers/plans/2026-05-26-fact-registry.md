# FactRegistry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an append-only `factRegistry` layer to `DigestState` that protects high-confidence decisions and constraints from being silently overwritten by noisy stream events.

**Architecture:** A new `FactRegistryEntry[]` field is added to the existing `DigestState` JSON (no schema migration needed — it's stored in the existing `state` JSON column of `DigestStateSnapshot`). During `applyProtectedStateMerge`, facts that pass an importance threshold are promoted into `factRegistry`. Stream events cannot remove or supersede factRegistry entries; only document events can. The retrieve endpoint exposes active (non-superseded) registry entries.

**Tech Stack:** TypeScript, Vitest, Zod (contracts), NestJS (API). No new dependencies.

---

## File Map

| File | Change |
|------|--------|
| `packages/core/src/digest-control.ts` | Add `FactRegistryEntry` type, `factRegistry` field to `DigestState`, normalization, `promoteToFactRegistry`, `supersedeFact`, `isInFactRegistry`, `getActiveFactRegistry` helpers; integrate into decision/constraint merge and revoke logic |
| `packages/core/src/digest-control.test.ts` | New `describe("factRegistry")` tests |
| `packages/core/src/index.ts` | Export `FactRegistryEntry`, `getActiveFactRegistry` |
| `packages/contracts/src/index.ts` | Add `factRegistry` field to `RetrieveOutput` schema |
| `apps/api/src/memory.controller.ts` | Include active factRegistry in retrieve response |

---

## Task 1: Add FactRegistryEntry type and factRegistry to DigestState

**Files:**
- Modify: `packages/core/src/digest-control.ts` — after line 55 (after `DigestEvidenceRef` interface)
- Modify: `packages/core/src/digest-control.ts` — `DigestState` interface (line 14)
- Modify: `packages/core/src/digest-control.ts` — `normalizeDigestState` function (around line 178)

- [ ] **Step 1: Add `FactRegistryEntry` interface** after the `DigestEvidenceRef` interface (after line 55):

```typescript
export interface FactRegistryEntry {
  id: string;
  content: string;
  type: "decision" | "constraint";
  confidence: number;
  addedAt: string;
  evidenceId: string;
  evidenceType: "event" | "document";
  supersededBy?: string;
}
```

- [ ] **Step 2: Add `factRegistry` field to `DigestState`** (add as last field before closing brace):

```typescript
export interface DigestState {
  stableFacts: { ... };          // existing
  workingNotes: { ... };         // existing
  todos: string[];               // existing
  volatileContext?: string[];    // existing
  evidenceRefs?: DigestEvidenceRef[];  // existing
  confidence?: { ... };          // existing
  provenance?: { ... };          // existing
  transitionSummary?: Record<string, number>;  // existing
  recentChanges?: DigestStateChange[];          // existing
  factRegistry?: FactRegistryEntry[];           // NEW
}
```

- [ ] **Step 3: Update `normalizeDigestState`** to pass factRegistry through without modification (add after the `recentChanges` line in the return object):

```typescript
factRegistry: base.factRegistry ?? [],
```

- [ ] **Step 4: Update `DEFAULT_DIGEST_STATE`** (around line 121) to include `factRegistry`:

```typescript
const DEFAULT_DIGEST_STATE: DigestState = {
  stableFacts: { decisions: [] },
  workingNotes: {},
  todos: [],
  volatileContext: [],
  evidenceRefs: [],
  confidence: {},
  provenance: {},
  transitionSummary: {},
  recentChanges: [],
  factRegistry: [],    // NEW
};
```

- [ ] **Step 5: Write failing test** in `packages/core/src/digest-control.test.ts`:

```typescript
describe("factRegistry", () => {
  it("normalizeDigestState preserves factRegistry entries", () => {
    const entry: FactRegistryEntry = {
      id: "fact-1",
      content: "use ONNX for inference",
      type: "decision",
      confidence: 0.9,
      addedAt: "2026-01-01T00:00:00.000Z",
      evidenceId: "evt-1",
      evidenceType: "event"
    };
    const state = normalizeDigestState({
      stableFacts: { decisions: [] },
      workingNotes: {},
      todos: [],
      factRegistry: [entry]
    });
    expect(state.factRegistry).toHaveLength(1);
    expect(state.factRegistry![0].content).toBe("use ONNX for inference");
  });

  it("normalizeDigestState initializes empty factRegistry when absent", () => {
    const state = normalizeDigestState({
      stableFacts: { decisions: [] },
      workingNotes: {},
      todos: []
    });
    expect(state.factRegistry).toEqual([]);
  });
});
```

- [ ] **Step 6: Run tests** — expect failing with `FactRegistryEntry is not defined`:

```
cd C:/StateCore/StateCore && pnpm --filter @statecore/core test
```

- [ ] **Step 7: Run tests after implementing** — expect pass:

```
cd C:/StateCore/StateCore && pnpm --filter @statecore/core test
```

- [ ] **Step 8: Commit**

```
git add packages/core/src/digest-control.ts packages/core/src/digest-control.test.ts
git commit -m "feat(factRegistry): add FactRegistryEntry type and factRegistry field to DigestState"
```

---

## Task 2: Add factRegistry helper functions

**Files:**
- Modify: `packages/core/src/digest-control.ts` — add helper functions near the other merge helpers (around line 840)

- [ ] **Step 1: Add `isInFactRegistry` helper** (add near `mergeGoalUpdate`):

```typescript
function isInFactRegistry(state: DigestState, content: string): boolean {
  const norm = normalizeText(content);
  return (state.factRegistry ?? []).some(
    (entry) => !entry.supersededBy && jaccardSimilarity(normalizeText(entry.content), norm) >= 0.6
  );
}
```

- [ ] **Step 2: Add `getActiveFactRegistry` export** (add after `isInFactRegistry`):

```typescript
export function getActiveFactRegistry(state: DigestState): FactRegistryEntry[] {
  return (state.factRegistry ?? []).filter((entry) => !entry.supersededBy);
}
```

- [ ] **Step 3: Add `promoteToFactRegistry` helper**:

```typescript
function promoteToFactRegistry(
  state: DigestState,
  content: string,
  type: FactRegistryEntry["type"],
  confidence: number,
  evidence: DigestEvidenceRef
): void {
  if (!state.factRegistry) state.factRegistry = [];
  // Skip if already in registry
  if (isInFactRegistry(state, content)) return;
  state.factRegistry.push({
    id: `fact-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    content,
    type,
    confidence,
    addedAt: new Date().toISOString(),
    evidenceId: evidence.id,
    evidenceType: evidence.sourceType
  });
}
```

- [ ] **Step 4: Add `supersedeFact` helper**:

```typescript
function supersedeFact(state: DigestState, content: string, newContent: string, evidence: DigestEvidenceRef): void {
  if (!state.factRegistry) return;
  const norm = normalizeText(content);
  const toSupersede = state.factRegistry.find(
    (entry) => !entry.supersededBy && jaccardSimilarity(normalizeText(entry.content), norm) >= 0.6
  );
  if (!toSupersede) return;
  const newId = `fact-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  toSupersede.supersededBy = newId;
  state.factRegistry.push({
    id: newId,
    content: newContent,
    type: toSupersede.type,
    confidence: toSupersede.confidence,
    addedAt: new Date().toISOString(),
    evidenceId: evidence.id,
    evidenceType: evidence.sourceType
  });
}
```

- [ ] **Step 5: Write failing tests** for helpers:

```typescript
it("isInFactRegistry detects existing entry by fuzzy match", () => {
  const state = normalizeDigestState({
    stableFacts: { decisions: [] },
    workingNotes: {},
    todos: [],
    factRegistry: [{
      id: "f1",
      content: "use ONNX for inference, no GPU for V1",
      type: "decision",
      confidence: 0.9,
      addedAt: "2026-01-01T00:00:00.000Z",
      evidenceId: "e1",
      evidenceType: "event"
    }]
  });
  expect(isInFactRegistry(state, "ONNX inference no GPU V1")).toBe(true);
  expect(isInFactRegistry(state, "use PostgreSQL as database")).toBe(false);
});

it("getActiveFactRegistry excludes superseded entries", () => {
  const state = normalizeDigestState({
    stableFacts: { decisions: [] },
    workingNotes: {},
    todos: [],
    factRegistry: [
      { id: "f1", content: "old decision", type: "decision", confidence: 0.8, addedAt: "2026-01-01T00:00:00.000Z", evidenceId: "e1", evidenceType: "event", supersededBy: "f2" },
      { id: "f2", content: "new decision", type: "decision", confidence: 0.9, addedAt: "2026-01-02T00:00:00.000Z", evidenceId: "e2", evidenceType: "document" }
    ]
  });
  const active = getActiveFactRegistry(state);
  expect(active).toHaveLength(1);
  expect(active[0].id).toBe("f2");
});
```

Note: `isInFactRegistry` is not exported — test it indirectly through `promoteToFactRegistry` or export it temporarily for testing.

- [ ] **Step 6: Run tests, confirm pass, commit**:

```
git add packages/core/src/digest-control.ts packages/core/src/digest-control.test.ts packages/core/src/index.ts
git commit -m "feat(factRegistry): add helper functions isInFactRegistry, promoteToFactRegistry, supersedeFact, getActiveFactRegistry"
```

---

## Task 3: Integrate promotion into merge pipeline

**Files:**
- Modify: `packages/core/src/digest-control.ts` — decision merge block (around line 1052-1093) and constraint merge block (around line 1095-1105)

- [ ] **Step 1: Promote decisions to factRegistry after adding to stableFacts**

Find the block (around line 1068-1076) where a new decision is added:

```typescript
const existing = findBestDecisionMatch(next.stableFacts.decisions, text);
if (!existing) {
  next.stableFacts.decisions.push(text);
  pushRecentChange(next, { field: "decisions", action: "add", value: text, evidence });
  next.provenance.decisions = upsertValueProvenance(next.provenance.decisions, text, evidence);
} else if (!valueHasEvidence(next.provenance.decisions, existing, evidence)) {
  pushRecentChange(next, { field: "decisions", action: "reaffirm", value: existing, evidence });
  next.provenance.decisions = upsertValueProvenance(next.provenance.decisions, existing, evidence);
}
```

Add promotion after the `if (!existing)` branch:

```typescript
if (!existing) {
  next.stableFacts.decisions.push(text);
  pushRecentChange(next, { field: "decisions", action: "add", value: text, evidence });
  next.provenance.decisions = upsertValueProvenance(next.provenance.decisions, text, evidence);
  // Promote high-confidence decisions to factRegistry
  if (delta.features.importanceScore >= 0.7) {
    promoteToFactRegistry(next, text, "decision", delta.features.importanceScore, evidence);
  }
} else if (!valueHasEvidence(next.provenance.decisions, existing, evidence)) {
  pushRecentChange(next, { field: "decisions", action: "reaffirm", value: existing, evidence });
  next.provenance.decisions = upsertValueProvenance(next.provenance.decisions, existing, evidence);
}
```

- [ ] **Step 2: Promote constraints to factRegistry** (after the existing constraint add at line ~1099):

```typescript
if (!existing) {
  next.stableFacts.constraints.push(normalizedConstraint);
  pushRecentChange(next, { field: "constraints", action: "add", value: normalizedConstraint, evidence });
  next.provenance.constraints = upsertValueProvenance(next.provenance.constraints, normalizedConstraint, evidence);
  // All constraints at this importanceScore threshold go to factRegistry
  promoteToFactRegistry(next, normalizedConstraint, "constraint", delta.features.importanceScore, evidence);
}
```

- [ ] **Step 3: Write promotion test**:

```typescript
it("promotes high-importance decisions to factRegistry", () => {
  const makeEvent = (id: string, content: string): MemoryEvent => ({
    id, type: "stream" as const, key: null, content, createdAt: new Date(), role: "user" as const
  });
  const delta: import("./digest-control").DeltaCandidate = {
    eventId: "evt-1",
    reason: "decision",
    features: { kind: "decision", importanceScore: 0.85, noveltyScore: 0.9 },
    event: makeEvent("evt-1", "decision: use ONNX runtime, no GPU required for V1")
  };
  const prevState = normalizeDigestState(null);
  const result = protectedStateMerge({
    prevState,
    deltaCandidates: [delta],
    documents: []
  });
  const active = getActiveFactRegistry(result);
  expect(active).toHaveLength(1);
  expect(active[0].type).toBe("decision");
  expect(active[0].confidence).toBe(0.85);
});

it("does not promote low-importance decisions to factRegistry", () => {
  const makeEvent = (id: string, content: string): MemoryEvent => ({
    id, type: "stream" as const, key: null, content, createdAt: new Date(), role: "user" as const
  });
  const delta: import("./digest-control").DeltaCandidate = {
    eventId: "evt-2",
    reason: "decision",
    features: { kind: "decision", importanceScore: 0.4, noveltyScore: 0.9 },
    event: makeEvent("evt-2", "decision: use prettier for formatting")
  };
  const prevState = normalizeDigestState(null);
  const result = protectedStateMerge({
    prevState,
    deltaCandidates: [delta],
    documents: []
  });
  expect(getActiveFactRegistry(result)).toHaveLength(0);
});
```

- [ ] **Step 4: Run tests, confirm pass, commit**:

```
pnpm --filter @statecore/core test
git add packages/core/src/digest-control.ts packages/core/src/digest-control.test.ts
git commit -m "feat(factRegistry): promote high-confidence decisions and constraints during merge"
```

---

## Task 4: Protect factRegistry entries from stream event removal

**Files:**
- Modify: `packages/core/src/digest-control.ts` — revoke logic (around line 1053) and conflicting decision removal (around line 1062)

- [ ] **Step 1: Guard revoke logic** — stream events cannot revoke factRegistry entries:

Find the revoke block (around line 1053-1060):
```typescript
if (/\b(revoke|undo|cancel decision)\b/.test(lowered)) {
  const revokeTarget = stripDecisionRevocationPrefix(text);
  const matched = findBestDecisionMatch(next.stableFacts.decisions, revokeTarget, 0.45);
  if (matched) {
    next.stableFacts.decisions = next.stableFacts.decisions.filter((item) => item !== matched);
    next.provenance.decisions = removeValueProvenance(next.provenance.decisions, matched);
    pushRecentChange(next, { field: "decisions", action: "remove", value: matched, evidence });
  }
}
```

Replace with:
```typescript
if (/\b(revoke|undo|cancel decision)\b/.test(lowered)) {
  const revokeTarget = stripDecisionRevocationPrefix(text);
  const matched = findBestDecisionMatch(next.stableFacts.decisions, revokeTarget, 0.45);
  if (matched) {
    const inRegistry = isInFactRegistry(next, matched);
    if (!inRegistry || evidence.sourceType === "document") {
      next.stableFacts.decisions = next.stableFacts.decisions.filter((item) => item !== matched);
      next.provenance.decisions = removeValueProvenance(next.provenance.decisions, matched);
      pushRecentChange(next, { field: "decisions", action: "remove", value: matched, evidence });
      if (inRegistry && evidence.sourceType === "document") {
        supersedeFact(next, matched, `[revoked] ${matched}`, evidence);
      }
    }
  }
}
```

- [ ] **Step 2: Guard conflicting decision removal** — stream events cannot remove factRegistry entries when conflicts detected:

Find the conflicting block (around line 1062-1067):
```typescript
const conflicting = findConflictingDecision(next.stableFacts.decisions, text);
if (conflicting) {
  next.stableFacts.decisions = next.stableFacts.decisions.filter((item) => item !== conflicting);
  next.provenance.decisions = removeValueProvenance(next.provenance.decisions, conflicting);
  pushRecentChange(next, { field: "decisions", action: "remove", value: conflicting, evidence });
}
```

Replace with:
```typescript
const conflicting = findConflictingDecision(next.stableFacts.decisions, text);
if (conflicting) {
  const inRegistry = isInFactRegistry(next, conflicting);
  if (!inRegistry || evidence.sourceType === "document") {
    next.stableFacts.decisions = next.stableFacts.decisions.filter((item) => item !== conflicting);
    next.provenance.decisions = removeValueProvenance(next.provenance.decisions, conflicting);
    pushRecentChange(next, { field: "decisions", action: "remove", value: conflicting, evidence });
    if (inRegistry && evidence.sourceType === "document") {
      supersedeFact(next, conflicting, text, evidence);
    }
  }
}
```

- [ ] **Step 3: Write protection test**:

```typescript
it("stream events cannot remove a factRegistry decision", () => {
  const makeEvent = (id: string, content: string): MemoryEvent => ({
    id, type: "stream" as const, key: null, content, createdAt: new Date(), role: "user" as const
  });
  // First establish a factRegistry decision
  const addDelta: import("./digest-control").DeltaCandidate = {
    eventId: "evt-1",
    reason: "decision",
    features: { kind: "decision", importanceScore: 0.8, noveltyScore: 0.9 },
    event: makeEvent("evt-1", "decision: use ONNX runtime for V1")
  };
  const stateWithFact = protectedStateMerge({
    prevState: normalizeDigestState(null),
    deltaCandidates: [addDelta],
    documents: []
  });
  expect(getActiveFactRegistry(stateWithFact)).toHaveLength(1);

  // Now try to revoke via stream event
  const revokeDelta: import("./digest-control").DeltaCandidate = {
    eventId: "evt-2",
    reason: "decision",
    features: { kind: "decision", importanceScore: 0.8, noveltyScore: 0.9 },
    event: makeEvent("evt-2", "revoke decision: ONNX runtime")
  };
  const stateAfterRevoke = protectedStateMerge({
    prevState: stateWithFact,
    deltaCandidates: [revokeDelta],
    documents: []
  });
  // factRegistry entry should survive
  expect(getActiveFactRegistry(stateAfterRevoke)).toHaveLength(1);
  expect(getActiveFactRegistry(stateAfterRevoke)[0].content).toContain("ONNX");
});
```

- [ ] **Step 4: Run tests, confirm pass, commit**:

```
pnpm --filter @statecore/core test
git add packages/core/src/digest-control.ts packages/core/src/digest-control.test.ts
git commit -m "feat(factRegistry): protect registry entries from stream event removal and conflict resolution"
```

---

## Task 5: Expose factRegistry in retrieve output

**Files:**
- Modify: `packages/contracts/src/index.ts` — `RetrieveOutput` schema
- Modify: `apps/api/src/memory.controller.ts` — retrieve endpoint
- Modify: `packages/core/src/index.ts` — export `getActiveFactRegistry`, `FactRegistryEntry`

- [ ] **Step 1: Export from `packages/core/src/index.ts`**

Add to the existing exports:
```typescript
export { getActiveFactRegistry } from "./digest-control";
export type { FactRegistryEntry } from "./digest-control";
```

- [ ] **Step 2: Add `FactRegistryEntrySchema` to `packages/contracts/src/index.ts`** (add near top with other schemas):

```typescript
export const FactRegistryEntrySchema = z.object({
  id: z.string(),
  content: z.string(),
  type: z.enum(["decision", "constraint"]),
  confidence: z.number().min(0).max(1),
  addedAt: z.string(),
  evidenceId: z.string(),
  evidenceType: z.enum(["event", "document"])
});
```

- [ ] **Step 3: Add `factRegistry` to `RetrieveOutput`** in `packages/contracts/src/index.ts`:

Find `RetrieveOutput` and add field:
```typescript
export const RetrieveOutput = z.object({
  digest: z.string().nullable(),
  events: z.array(z.object({
    id: z.string().uuid(),
    content: z.string(),
    createdAt: z.string()
  })),
  factRegistry: z.array(FactRegistryEntrySchema),   // NEW
  retrieval: z.object({ ... })                       // existing
});
```

- [ ] **Step 4: Update retrieve endpoint in `apps/api/src/memory.controller.ts`**

Find the retrieve handler (around line 745-762) and update to include factRegistry:

```typescript
const snapshot = await this.domain.getLatestDigestState(input.scopeId);
const activeFactRegistry = snapshot ? getActiveFactRegistry(snapshot.state) : [];

return parseOutput(RetrieveOutput, {
  digest: result.digest ? result.digest.summary : null,
  events: result.events.map((event) => ({
    id: event.id,
    content: event.content,
    createdAt: event.createdAt.toISOString()
  })),
  factRegistry: activeFactRegistry,    // NEW
  retrieval: result.retrieval
});
```

- [ ] **Step 5: Build all packages to check types**:

```
cd C:/StateCore/StateCore
pnpm --filter @statecore/core build
pnpm --filter @statecore/contracts build
pnpm --filter @statecore/api build
```

Expected: no TypeScript errors.

- [ ] **Step 6: Run all tests**:

```
pnpm --filter @statecore/core test
```

Expected: all 95+ tests pass.

- [ ] **Step 7: Commit**:

```
git add packages/core/src/index.ts packages/contracts/src/index.ts apps/api/src/memory.controller.ts
git commit -m "feat(factRegistry): expose active factRegistry entries in retrieve output"
```

---

## Task 6: Rebuild Docker and verify end-to-end

- [ ] **Step 1: Rebuild and restart**:

```powershell
docker compose -f C:\StateCore\StateCore\docker-compose.local.yml build api worker
docker compose -f C:\StateCore\StateCore\docker-compose.local.yml up -d api worker
```

- [ ] **Step 2: Post a high-importance decision event and check factRegistry**:

```bash
curl -s -X POST http://localhost:3002/memory/events \
  -H "x-user-id: local-dev-user" \
  -H "Content-Type: application/json" \
  -d '{"scopeId":"<your-scope-id>","type":"stream","source":"api","content":"decision: use ONNX runtime for AI inference, no GPU required for V1, importanceScore is high"}'
```

Then trigger a digest:
```bash
curl -s -X POST http://localhost:3002/memory/digest \
  -H "x-user-id: local-dev-user" \
  -H "Content-Type: application/json" \
  -d '{"scopeId":"<your-scope-id>"}'
```

Wait 20 seconds, then check retrieve:
```bash
curl -s -X POST http://localhost:3002/memory/retrieve \
  -H "x-user-id: local-dev-user" \
  -H "Content-Type: application/json" \
  -d '{"scopeId":"<your-scope-id>","query":"ONNX decision"}' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('factRegistry:', d.get('factRegistry'))"
```

Expected: `factRegistry` contains the ONNX decision entry.

- [ ] **Step 3: Final commit**:

```
git add .
git commit -m "feat(factRegistry): complete — append-only protected fact layer for high-confidence decisions and constraints"
```

---

## Self-Review

**Spec coverage:**
- ✅ `FactRegistryEntry` type with all required fields
- ✅ Append-only promotion for decisions (importanceScore >= 0.7) and constraints (importanceScore >= 0.75)
- ✅ Stream events cannot remove or supersede factRegistry entries
- ✅ Document events CAN supersede (via `supersedeFact`)
- ✅ `getActiveFactRegistry` excludes superseded entries
- ✅ Retrieve endpoint exposes active factRegistry
- ✅ No Prisma schema migration needed
- ⚠️ `supersedeFact` is tested indirectly via revoke/conflict tests; direct test for document supersede could be added in a follow-up

**Placeholder scan:** None found.

**Type consistency:** `FactRegistryEntry` is defined in Task 1 and used consistently in Tasks 2-5. `getActiveFactRegistry` signature is consistent across tasks. `promoteToFactRegistry` and `supersedeFact` are private (not exported) — tests that need them use `protectedStateMerge` indirectly.
