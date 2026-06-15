# Memory Engine Quality — Design Spec

**Date:** 2026-06-15
**Scope:** Three targeted improvements to StateCore's long-term memory engine quality: drift metric collection, deterministic replay verification, and extractKind recall rate hardening.

---

## Problem Statement

The memory engine's deterministic control layer (protectedStateMerge, normalizeDigestState) is well-tested and robust. Three gaps remain:

1. **No runtime drift visibility** — there is no way to observe whether goal/decision/constraint stability is holding up across digest runs in production.
2. **Replay non-determinism unverified** — the digest pipeline is assumed to be deterministic (given the same events and mock LLM), but this has never been tested.
3. **extractKind misses realistic inputs** — the accuracy test covers obvious keyword triggers. Real conversation inputs like "we should use Postgres" or "the API must stay backward compatible" fall through as `note`, never reaching `stableFacts`.

---

## Part 1: Drift Metrics

### Goal
Capture goal/decision/constraint churn per digest run, stored alongside the job log for historical querying.

### Interface

New file: `packages/core/src/drift-metrics.ts`

```typescript
export interface DriftMetrics {
  goalChanged: boolean;
  decisionsAdded: number;
  decisionsRemoved: number;
  constraintsAdded: number;
  constraintsRemoved: number;
  todosAdded: number;
  todosRemoved: number;
  stabilityScore: number; // 1 - (changed_items / total_tracked_items), 0–1
}

export function computeDriftMetrics(
  before: DigestState | null,
  after: DigestState
): DriftMetrics
```

### Stability Score Formula

```
tracked_items = max(1, |decisions_before| + |constraints_before| + (goal_before ? 1 : 0))
changed_items = decisionsAdded + decisionsRemoved + constraintsAdded + constraintsRemoved + (goalChanged ? 1 : 0)
stabilityScore = max(0, 1 - changed_items / tracked_items)
```

When `before` is null (first digest), stabilityScore = 1.0 (baseline, no prior state to drift from).

### Schema Change

Add to `DigestJobLog` in `packages/db/prisma/schema.prisma`:
```prisma
driftMetrics Json?
```

Migration: `packages/db/prisma/migrations/20260615010000_digest_job_log_drift/migration.sql`
```sql
ALTER TABLE "DigestJobLog" ADD COLUMN "driftMetrics" JSONB;
```

### Worker Integration

In `apps/worker/src/main.ts`, after successful `runDigestControlPipeline`:
```typescript
const driftMetrics = computeDriftMetrics(prevState, result.state);
await prisma.digestJobLog.create({
  data: { ..., driftMetrics: driftMetrics as any }
});
```

### Tests

`packages/core/src/drift-metrics.test.ts` — pure function, no DB:
- goal change detected correctly
- decisions added/removed counted correctly
- stabilityScore = 1.0 when nothing changes
- stabilityScore < 1.0 when decisions change
- before=null returns stabilityScore=1.0

---

## Part 2: Deterministic Replay Test

### Goal
Prove that the digest pipeline produces identical `DigestState` when run twice with the same inputs and a mock LLM.

### Test File

`packages/core/src/digest-replay.test.ts`

### Fixed Inputs

```typescript
const FIXED_EVENTS = [
  // 1 document
  event({ id: "doc-1", type: "document", key: "doc:plan",
    content: "goal: ship self-hosted memory runtime\nconstraint: no paid APIs\ndecision: use postgres" }),
  // 3 stream events
  event({ id: "s-1", type: "stream", content: "We decide to use Postgres for storage",
    createdAt: new Date("2026-01-01T10:00:00Z") }),
  event({ id: "s-2", type: "stream", content: "constraint: keep api stable",
    createdAt: new Date("2026-01-01T10:01:00Z") }),
  event({ id: "s-3", type: "stream", content: "TODO: write benchmark script",
    createdAt: new Date("2026-01-01T10:02:00Z") }),
];

const MOCK_LLM = {
  chat: async () => JSON.stringify({
    summary: "Goal: ship self-hosted memory runtime. Constraints: no paid APIs; keep api stable. Decision: use postgres.",
    changes: ["Decision: use postgres", "Constraint: keep api stable"],
    nextSteps: ["Write benchmark script"]
  })
};
```

### Tests

**Test 1 — Idempotency:**
Run `runDigestControlPipeline` twice with identical inputs → `normalizeDigestState(r1.state)` deep-equals `normalizeDigestState(r2.state)`.

**Test 2 — Rebuild consistency:**
Run pipeline once to get `originalState`. Then run pipeline again with `prevState: null, lastDigest: null` (simulating rebuild from scratch) → `result2.state.stableFacts` equals `originalState.stableFacts`.

Use `normalizeDigestState` on both sides before comparison to remove non-deterministic ordering artefacts.

---

## Part 3: extractKind Recall Rate

### Goal
Test realistic ambiguous conversation inputs; fix high-confidence false negatives; mark low-confidence gaps as known limitations.

### Test File

`packages/core/src/extract-kind.recall.test.ts`

### Classification of False Negatives

| Input | Expected | Intent confidence | Action |
|-------|----------|-------------------|--------|
| "we should use Postgres" | decision | HIGH — "should use X" = clear preference | Fix regex |
| "let's go with Ollama for local models" | decision | HIGH — "let's go with X" = clear direction | Fix regex |
| "going forward, use UUIDv7" | decision | HIGH — "going forward, use X" | Fix regex |
| "the API must stay backward compatible" | constraint | HIGH — "must [verb]" = obligation | Fix regex |
| "no cloud storage allowed" | constraint | HIGH — "no X allowed" = prohibition | Fix regex |
| "we need to keep this self-hosted" | constraint | HIGH — "need to keep X" = requirement | Fix regex |
| "let's add a benchmark script" | todo | HIGH — "let's add X" = clear action item | Fix regex |
| "make sure to test the edge cases" | todo | HIGH — "make sure to X" = clear action item | Fix regex |
| "we need to write docs for this" | todo | HIGH — "need to write X" = clear action item | Fix regex |
| "I think Postgres might be better" | decision | LOW — "I think" = opinion, not decision | `it.skip` + comment |
| "X would probably work" | decision | LOW — uncertain framing | `it.skip` + comment |

### Regex Extensions to extractKind

In `packages/core/src/digest-control.ts`, extend the `extractKind` function:

**Decision patterns to add:**
```
/\b(we should use|let's go with|going forward.*use|should go with)\b/i
```

**Constraint patterns to add:**
```
/\b(must\s+(?!not\b)\w|no\s+\w+\s+allowed|need to keep|required to)\b/i
```

**Todo patterns to add:**
```
/\b(let's add|make sure to|need to (write|add|create|implement|test|document))\b/i
```

### Test Structure

Each high-confidence case: `it("routes [input] to [field]", ...)` — must pass.
Each low-confidence case: `it.skip("known limitation: [input] ambiguous", ...)` with comment explaining why.

---

## File Map

| File | Action |
|------|--------|
| `packages/core/src/drift-metrics.ts` | Create |
| `packages/core/src/drift-metrics.test.ts` | Create |
| `packages/db/prisma/schema.prisma` | Modify — add `driftMetrics Json?` to DigestJobLog |
| `packages/db/prisma/migrations/20260615010000_digest_job_log_drift/migration.sql` | Create |
| `apps/worker/src/main.ts` | Modify — call computeDriftMetrics, pass to DigestJobLog.create |
| `packages/core/src/digest-replay.test.ts` | Create |
| `packages/core/src/extract-kind.recall.test.ts` | Create |
| `packages/core/src/digest-control.ts` | Modify — extend extractKind regex patterns |

---

## Success Criteria

1. `pnpm --filter @statecore/core test` — all pass (includes replay + recall tests)
2. `pnpm --filter @statecore/worker test` — all pass
3. `GET /metrics/digest/:scopeId` response includes `driftMetrics` from latest job log
4. `stabilityScore` field present in DigestJobLog rows after digest run
5. All high-confidence recall cases pass; low-confidence cases `it.skip` with explanatory comment
