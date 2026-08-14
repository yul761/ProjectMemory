# Digest State Specification

This document defines the role, structure, and evolution rules for `DigestState`.

In the three-layer architecture, `DigestState` should be read as the internal State Layer representation.
It remains the authoritative protected memory layer, but it is no longer the only memory layer in the system.

`DigestState` is the protected State Layer memory that sits between raw events and generated digests. It exists to reduce drift by giving the system a stable, structured memory representation that does not depend entirely on free-form summary text.

## Purpose

`DigestState` should be treated as a first-class State Layer artifact.

Its job is to:

- preserve stable facts across long-running interaction
- separate durable memory from temporary context
- provide deterministic input to digest generation
- support contradiction checks
- support replay, rebuild, and auditing

Without a protected state layer, the system must repeatedly infer memory from previous digest text, which increases ambiguity and drift risk.

It is distinct from:

- Fast Layer context
- Working Memory snapshots

## Current State in the Repository

`DigestState` carries the five original narrative sections plus the record-keeping
that was added later. `packages/core/src/digest-control.ts` is authoritative;
`packages/contracts/src/index.ts` holds the schemas the API exposes.

The narrative sections:

- `stableFacts` — `goal?`, `constraints?`, `decisions`
- `workingNotes` — `openQuestions?`, `risks?`, `context?`
- `todos`
- `volatileContext?`
- `evidenceRefs?` — `{ id, sourceType: "document" | "event", key?, kind? }`

And the record-keeping, which is what makes the state auditable rather than merely
stored:

- `factRegistry?` — the authoritative record of individual facts. Each entry
  carries `id`, `content`, `type`, `confidence`, `addedAt`, `evidenceId` and
  `evidenceType`, plus `facet?` and the two ways a fact can leave the active set:
  `supersededBy` when a newer version replaced it, or `retiredAt` /
  `retiredReason` when it left without a replacement (capacity eviction, an
  explicit forget). **Nothing is deleted** — that is what lets
  `GET /v1/memory/facts/:factId/provenance` answer from any version in a chain.
  Inactive entries are bounded to the most recent 500.
- `profile?` — facet name to fact lines. The keys come from the active facet
  pack, not from this type: the engine stores and protects facts without knowing
  what a facet means, so a deployment can replace the ontology without a
  migration. See `packages/core/src/facet-registry.ts`.
- `confidence?` / `provenance?` — per-value confidence and evidence refs for the
  narrative sections.
- `transitionSummary?` / `recentChanges?` — what moved in the last digest, used by
  drift metrics and replay.

Facts a digest refused to store are not in the state at all; they are recorded in
`Digest.selectionLog` with a reason, readable through
`GET /v1/memory/digests/:digestId/selection`.

The narrative sections remain an early State Layer model rather than the final
intended state design; the sections below describe where they should go.

## Design Goals

The long-term `DigestState` design should optimize for:

- stability under repeated digesting
- explicit separation of durable vs temporary information
- evidence-aware updates
- conservative overwrite behavior
- replay and rebuild consistency
- benchmark-friendly inspection

## State Layers

`DigestState` should distinguish information by durability.

### 1. Stable Facts

Stable facts are project-level facts that should persist until explicitly changed or superseded.

Examples:

- project goal
- hard constraints
- accepted decisions
- durable operating assumptions

Stable facts should be the hardest part of state to overwrite.

### 2. Working Notes

Working notes are useful but less durable than stable facts.

Examples:

- current risks
- open questions
- intermediate reasoning
- recent project context

Working notes may decay, roll forward, or be pruned more aggressively.

### 3. Volatile Context

Volatile context is short-lived information that helps the next few turns but should not silently become permanent memory.

Examples:

- temporary blockers
- short-term priorities
- conversational noise worth keeping briefly
- near-term execution focus

The current implementation already has a `volatileContext` field, but it is still a lightweight string list rather than a richer typed record layer.

### 4. Todos

Todos are operational commitments and should remain separate from prose notes.

They should not be mixed into `workingNotes.context`, because task continuity is one of the core dimensions of drift measurement.

## Recommended Target Shape

The roadmap target should move toward a richer state model like:

```ts
interface DigestStateV2 {
  stableFacts: {
    goal?: FactRecord;
    constraints: FactRecord[];
    decisions: DecisionRecord[];
  };
  workingNotes: {
    openQuestions: NoteRecord[];
    risks: NoteRecord[];
  };
  volatileContext: ContextRecord[];
  todos: TodoRecord[];
  evidenceRefs: EvidenceRef[];
}
```

This document does not require that exact schema yet, but it defines the intended semantics behind it.

## Why the Current Shape Is Not Enough

The narrative sections still have two practical limitations:

1. They store most entries as plain strings.
2. They do not clearly separate temporary context from longer-lived notes.

The third limitation this section used to list — "facts do not carry their own
evidence metadata" — no longer holds. The record-per-fact model exists: every
`factRegistry` entry carries its content, `evidenceId` and `evidenceType`,
`confidence`, `addedAt`, its facet, and how it left the active set
(`supersededBy`, or `retiredAt` with a reason). Registry entries cover decisions
and constraints as well as profile facts (`type`), so the system can answer
directly:

- why a fact was added (`GET /v1/memory/facts/:factId/provenance`)
- what it believed before (the version chain)
- what a digest discarded and why (`GET /v1/memory/digests/:digestId/selection`)

The narrative sections additionally carry top-level `provenance`, `confidence`
and `recentChanges`, so replay can compare not only final state but how it got
there. What the registry model has **not** been extended to is todos and working
notes — those remain plain strings inside the narrative sections.

## State Record Semantics

State elements should carry more than text. For facts, decisions and
constraints, they now do — via `factRegistry` — while todo and note records
remain future work.

### Fact Records (delivered, as `FactRegistryEntry`)

- canonical text — `content`, bounded to statement length
- source evidence ids — `evidenceId` + `evidenceType`
- confidence — `confidence`
- first seen timestamp — `addedAt`
- superseded or active status — `supersededBy`, or `retiredAt`/`retiredReason`

The one field from the original sketch that does not exist is a "last reaffirmed
timestamp"; reaffirmation currently leaves no mark on the entry.

### Decision Records (delivered, same registry)

Decisions and constraints live in the same registry (`type: "decision" | "constraint"`),
so they carry the same evidence, status, and supersedes pointer as facts.

### Todo Records

Todos should eventually support:

- todo text
- status such as open, completed, canceled, blocked, duplicate
- source evidence ids
- optional owner or scope tags
- created and updated timestamps

### Note Records

Working notes should eventually support:

- note text
- note kind such as risk or question
- source evidence ids
- recency metadata

## Evolution Rules

The state should evolve conservatively.

### Rule 1: Prefer append over overwrite

For stable facts and decisions, new evidence should usually append, reaffirm, supersede, or explicitly revoke. Silent replacement should be avoided.

### Rule 2: Require stronger evidence to change stable facts

A weak conversational note should not override a stable goal or hard constraint. Updates to stable facts should require explicit and stronger evidence.

### Rule 3: Treat removal as a first-class operation

Removing a constraint, decision, or todo should require explicit evidence rather than passive disappearance.

### Rule 4: Separate durable truth from temporary context

If a piece of information is only relevant for a short time, it should land in volatile context or a note layer, not in stable facts.

### Rule 5: Preserve evidence linkage

Every important state transition should be explainable in terms of source documents, stream events, or prior accepted state.

### Rule 6: Preserve replay determinism

Running the same event sequence through the same merge logic should produce the same protected state unless configuration changes.

## Merge Semantics

The current `protectedStateMerge()` already applies conservative behavior:

- documents can set goals and contribute constraints or todos
- decisions append rather than replace
- constraints append when strong enough
- todos append uniquely
- questions and risks accumulate in capped note lists

The four merge outcomes this section once proposed all exist now, under these
names:

1. append — recorded in `recentChanges` as `add` (or `set` for the goal)
2. reaffirm — recorded as `reaffirm`
3. supersede — the registry marks the old entry `supersededBy`
4. reject — recorded in the drop log with a reason, persisted to
   `Digest.selectionLog`

An important incoming candidate resolves to one of these, and the resolution
leaves a trace.

## Snapshot Semantics

Each accepted digest should persist a snapshot of protected state.

Snapshot persistence matters because it allows the system to:

- avoid reconstructing state from free-form text
- compare state transitions over time
- audit why drift occurred
- replay from a known state boundary

The current schema already stores `DigestStateSnapshot` as JSON linked to a digest. That is the correct direction and should remain central to the architecture.

## Relationship to Drift

`DigestState` is one of the main mechanisms for reducing:

- goal drift
- constraint drift
- decision drift
- todo drift

If `DigestState` is weak, digest text becomes the de facto memory source, and drift becomes harder to prevent and harder to measure.

## Relationship to Consistency Checks

Consistency checks should treat protected state as a guardrail.

Examples:

- summaries should not contradict `stableFacts.goal`
- changes should not violate preserved constraints
- next steps should not invent unsupported todos
- answer generation should not override protected state without evidence

As the state model becomes richer, consistency checks should use more than plain string inclusion and move toward evidence-aware comparisons.

## Implementation Guidance

The ordered steps this section prescribed have mostly run their course:

1. Keep the current `DigestState` shape stable — held; existing data needs no
   migration, including for the facet-pack change.
2. Define a versioned successor shape — not done as a `V2` type; the shape grew
   additively instead.
3. Add provenance fields — done (`provenance`, `evidenceRefs`, per-fact evidence).
4. Add `volatileContext` — done; **richer todo status handling remains open**.
5. Explicit supersede and rejection semantics — done (registry supersession, drop
   log).
6. Replay tests comparing state snapshots, not just digest text — done
   (`run-replay-check.mjs`, category-level diffs).

## Migration Strategy

The safest migration path is incremental.

### Stage 1

Document the semantics of the current fields and use them consistently.

### Stage 2

Add optional metadata fields compatible with the current snapshot JSON format.

### Stage 3

Introduce richer record types and migrate merge logic to produce them.

### Stage 4

Update benchmarks and drift analysis to score state continuity using richer fields.

## Immediate Practical Standard

Until a richer schema is implemented, contributors should treat the current state fields like this:

- `stableFacts.goal`: the best current project goal, changed only by explicit evidence
- `stableFacts.constraints`: hard or durable constraints that should persist
- `stableFacts.decisions`: decisions that should remain continuous across digests
- `workingNotes.openQuestions`: unresolved questions worth carrying forward briefly
- `workingNotes.risks`: active risks or blockers
- `workingNotes.context`: limited free-form context, not a dumping ground for stable facts
- `todos`: active action items that should remain visible until resolved

## Success Criteria

`DigestState` is doing its job when:

- core goals remain stable across long interaction
- constraints are not silently lost
- decisions remain continuous or are explicitly superseded
- todos are preserved without multiplying into noise
- rebuilds reproduce compatible state snapshots
- contradictions can be detected against structured state rather than loose digest text
