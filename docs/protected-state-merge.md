# Protected State Merge

`protectedStateMerge()` in `packages/core/src/digest-control.ts:931` is the core function of the State Layer digest pipeline. It merges new evidence into the existing memory state while preserving stable facts from being overwritten by noise.

## Role in the Pipeline

```
Stage 1: Event Selection
Stage 2: Delta Detection
Stage 3: protectedStateMerge  ← this doc
Stage 4: LLM Digest Generation
Stage 5: Consistency Check
```

Called with the previous state, a set of delta candidates (novel events), and any document-type events. Returns the updated state.

---

## State Structure

```typescript
DigestState {
  stableFacts: {
    goal?:         string           // single string, the project's current goal
    constraints?:  string[]         // list of active constraints
    decisions:     string[]         // list of architectural/process decisions
  }
  workingNotes: {
    openQuestions?: string[]        // unresolved questions (capped at 10)
    risks?:         string[]        // active risks/blockers (capped at 10)
    context?:       string
  }
  todos:            string[]        // open action items
  volatileContext?: string[]        // status/note snippets (capped at 10)
  evidenceRefs:     DigestEvidenceRef[]   // all source events/docs referenced
  provenance:       { [field]: ValueProvenance[] }  // per-value source tracking
  recentChanges:    DigestStateChange[]  // what changed in this run
  transitionSummary: Record<string, number>
}
```

---

## Processing Flow

The function operates in two phases: document-backed fields first, then stream events.

### Phase 1: Document-Backed Fields

Documents (`type: "document"`) are structured memory entries with explicit prefixes. Parsed in this order:

1. **Goal** — looks for a line matching `goal: <text>`. If found, calls `mergeGoalUpdate()`.
2. **Constraints** — extracts lines prefixed `constraint:`. Merges via `mergeDocumentBackedList()`.
3. **Decisions** — extracts lines prefixed `decision:`. Same merge.
4. **Todos** — extracts lines prefixed `todo:`. Same merge.

Document-backed values have higher authority than stream events. A document saying `constraint: must not use PII` pins that constraint regardless of stream noise.

Also supports natural-language goal detection from free text:
- Patterns like `"I'm trying to..."`, `"my goal is to..."`, `"I want to..."` are extracted and treated as goal candidates.

### Phase 2: Stream Event Processing

Events are sorted chronologically and processed one by one. Each event has a `kind` (classified earlier in Stage 1). Processing rules by kind:

#### `decision`

1. **Revocation check** — if the text contains `revoke/undo/cancel decision`, find the closest matching existing decision (Jaccard ≥ 0.45) and remove it.
2. **Conflict detection** — if the new decision has an opposite "direction" to an existing one (e.g., "merge layers" vs "separate layers"), remove the conflicting decision first.
3. **De-duplication** — if no close match exists (Jaccard ≥ 0.8), add as new. If match found, just add provenance (reaffirm).
4. **Question auto-resolution** — if this decision text semantically matches an open question (Jaccard ≥ 0.35), close that question.

#### `constraint`

Only added if `importanceScore >= 0.75` (high-confidence constraints only). Normalized via `normalizeConstraintFactText()`. De-duped with Jaccard ≥ 0.8 against existing constraints.

#### `todo`

1. **Completion check** — if text contains `done/completed/cancel/remove/drop/close`, find the closest matching todo (Jaccard ≥ 0.45) and remove it.
2. **De-duplication** — same as decisions: add if no close match, reaffirm if match found.

#### `question`

Added to `workingNotes.openQuestions` (capped at last 10). Skipped if an earlier decision in this same run already resolved it. De-duped at Jaccard ≥ 0.7.

#### `status` / `note`

Added to `volatileContext` (capped at last 10). Skipped if text matches a just-resolved risk. De-duped at Jaccard ≥ 0.7.

Also: if these kinds contain `resolved/fixed/mitigated/unblocked/cleared`, find the closest matching risk (Jaccard ≥ 0.35) and remove it + clean up related volatile context entries.

#### `risk` / `blocked` / `blocker` (any kind, keyword match)

Added to `workingNotes.risks` (capped at last 10). Skipped if already resolved in this run. De-duped at Jaccard ≥ 0.7.

---

## Matching Algorithm

All de-duplication uses **Jaccard similarity on token sets**. For two strings `a` and `b`:

```
similarity = |tokens(a) ∩ tokens(b)| / |tokens(a) ∪ tokens(b)|
```

Tokens are lowercased, punctuation-stripped, stop-word-filtered words.

**Thresholds by context:**

| Context | Threshold | Reasoning |
|---------|-----------|-----------|
| Decision / todo de-dup | 0.80 | High bar — avoid merging distinct decisions |
| Question / risk de-dup | 0.70 | Slightly looser — natural language varies more |
| Decision revocation match | 0.45 | Must find target even with paraphrase |
| Todo completion match | 0.45 | Same — completion phrasing differs from original |
| Risk / question resolution | 0.35 | Lowest — resolution phrases differ most from originals |

**Decision conflict detection** uses a separate direction classifier:
- Words like `merge/collapse/single` → direction "collapse"
- Words like `separate/boundary/layer` → direction "separate"
- If two decisions share topic tokens AND have opposite directions → conflict.

**Number token guard:** two values with different numbers are never considered duplicates (e.g., "use 3 layers" ≠ "use 5 layers").

---

## Provenance Tracking

Every value in every list carries evidence refs: which event IDs or document keys contributed to it. This enables:
- Tracing why a specific constraint appears in state
- Debugging unexpected state changes
- The consistency checker to validate evidence coverage

When a value is reaffirmed (second mention of same thing), the new event ref is added to its provenance. When a value is removed, its provenance is also cleaned up.

---

## Idempotency Property

Running the merge twice with the same deltas produces the same output state. De-duplication and normalization at the end (`[...new Set(...)]`) ensure no duplicates survive even if events were processed multiple times.

---

## What This Does NOT Do

- **No LLM calls.** All processing is deterministic string matching. The LLM is used in Stage 4 to generate prose summaries from this structured state.
- **No scoring of existing state.** It only adds/removes/reaffirms — it never re-ranks what was already stable.
- **No cross-field inference.** A decision does not automatically update constraints. Fields are processed independently.
