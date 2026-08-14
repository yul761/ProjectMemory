# Drift Definition

This document defines what "drift" means in StateCore.

The goal is to make drift a concrete, testable property of the memory system instead of a vague description of "the model forgot something" or "the summary feels off".

## Why This Exists

StateCore is not primarily optimizing for open-ended conversation quality. It is optimizing for long-term memory reliability under repeated interaction.

That means the system needs a shared definition for:

- what counts as memory preservation
- what counts as memory corruption
- what counts as unsupported answer behavior
- what can be measured in benchmarks, regressions, and replay runs

## Scope

This definition applies to:

- digest generation
- protected state evolution
- retrieval and answer grounding
- rebuild and replay comparisons

It does not assume that every change is bad. Some state changes are legitimate. Drift only occurs when the system changes memory in a way that is unsupported, inconsistent, lossy, or not recoverable from evidence.

## Core Definition

In StateCore, **drift** is a harmful divergence between memory state or memory-backed output and the supported historical evidence available to the system.

Drift can appear in five primary forms:

1. goal drift
2. constraint drift
3. decision drift
4. todo drift
5. answer drift

## Evidence Model

Drift can only be judged against evidence. In this repository, evidence currently comes from:

- memory events
- latest document versions
- previous digest state snapshots
- the last accepted digest

When these sources disagree, the system should prefer explicit, newer, and better-scoped evidence rather than silently rewriting stable state.

## Drift Categories

### Goal Drift

Goal drift happens when the system changes, drops, weakens, or invents the project goal without sufficient evidence.

Examples:

- A prior goal disappears from protected state even though no superseding evidence exists.
- A digest reframes the goal into a materially different objective.
- A temporary note is promoted into the primary goal.

Typical signals:

- `stableFacts.goal` changes unexpectedly
- summaries stop reflecting the known goal
- rebuild results disagree on the core goal from the same event history

### Constraint Drift

Constraint drift happens when the system omits, reverses, or mutates an important constraint.

Examples:

- "must be self-hosted" disappears after several digests
- "must not depend on hosted memory" becomes optional language
- a hard requirement is replaced by a weaker preference

Typical signals:

- protected constraints shrink without evidence of removal
- digests contradict previously accepted constraints
- answers propose actions that violate preserved constraints

### Decision Drift

Decision drift happens when a recorded decision is overwritten, contradicted, or replaced with an unsupported alternative.

Examples:

- a chosen architecture decision later appears as undecided
- a previous decision is replaced by a different one without an explicit new decision event
- the system preserves only the newer phrasing and loses the continuity of the earlier decision

Typical signals:

- missing decision continuity across digests
- contradiction between new digest output and stored decisions
- rebuild runs produce different decision histories from the same events

### Todo Drift

Todo drift happens when action items are lost, duplicated, falsely created, or detached from the current state of work.

Examples:

- a still-open todo disappears from memory
- the same todo multiplies into several variants
- a digest invents a next step that is not supported by the event stream
- completed and pending tasks become conflated

Typical signals:

- unstable `todos` lists across repeated digests
- repeated vague next steps
- mismatch between fixture gold todos and persisted memory state

### Answer Drift

Answer drift happens when the system produces a response that is not grounded in available memory evidence.

Examples:

- an answer cites a decision that does not exist in memory
- an answer ignores preserved constraints and recommends a conflicting approach
- an answer fills missing details with model guesses instead of evidence-backed uncertainty

Typical signals:

- unsupported claims
- low evidence usage
- contradiction with digest state or event evidence

## What Is Not Drift

The following changes should not automatically be counted as drift:

- a goal legitimately changes because a new explicit goal update was recorded
- a todo is removed because the work was completed or canceled
- a decision is superseded by a new documented decision
- wording changes that preserve the same meaning

Drift is about unsupported or harmful divergence, not any change at all.

## Severity Levels

Each drift finding should be tagged by severity.

### Low Severity

Minor wording changes, duplicate todos, or soft recall degradation that does not yet change behavior.

### Medium Severity

Loss of important context, weakening of constraints, or unstable replay results that would affect future digests or retrieval.

### High Severity

Contradiction of stable facts, invented decisions, missing core goals, or answers that materially violate preserved constraints.

## Measurement Approach

Drift should be measured at more than one layer.

### 1. State-level Drift

Compare protected state or snapshot state against gold facts or prior accepted state.

Candidate metrics:

- goal drift rate
- constraint drift rate
- decision contradiction rate
- todo continuity rate
- state drift rate

### 2. Digest-level Drift

Check whether digest output remains consistent with protected state and evidence.

Candidate metrics:

- digest contradiction rate
- repeated change rate
- vague next-step rate
- unsupported summary claim rate

### 3. Answer-level Drift

Check whether answers are supported by recalled memory.

Candidate metrics:

- answer grounding rate
- evidence usage rate
- unsupported claim rate
- constraint violation rate

### 4. Replay-level Drift

Check whether the same event history produces stable memory state under rebuild or replay.

Candidate metrics:

- rebuild consistency rate
- snapshot replay stability
- cross-run state divergence rate

## Current Repository Mapping

The current codebase already contains partial building blocks for this model:

- protected state merge in `packages/core/src/digest-control.ts`
- consistency checks in `packages/core/src/digest-control.ts`
- digest state snapshots in Prisma schema
- drift-oriented benchmark runner in `scripts/benchmark/run-drift.mjs`

The current consistency taxonomy includes omission/contradiction signals across the four narrative memory categories:

- `goal_omission`
- `constraint_omission`
- `decision_omission`
- `todo_omission`
- `goal_contradiction`
- `constraint_contradiction`
- `decision_contradiction`
- `todo_contradiction`

plus a dynamic `profile_<facet>_contradiction` signal for each facet of the
active pack, so write-protected profile facts participate in the contradiction
gate rather than only `stableFacts`.

For the current `DigestState` shape, see
[digest-state.md](digest-state.md#current-state-in-the-repository) — the list
that used to sit here went stale once and is not duplicated again.

The four separations this section once listed as missing now exist in
`DigestState`:

- **stable facts vs volatile context** — `volatileContext` is its own field with
  its own capacity
- **evidence references** — `evidenceRefs`, plus a per-fact `evidenceId` and
  `evidenceType` in `factRegistry`
- **confidence levels** — a `confidence` block for the narrative sections, and a
  `confidence` on every registry entry
- **explicit overwrite policy** — facets declare `writeProtected` and
  `documentAuthority`, and sources carry authority scores, so a lower-authority
  source cannot silently replace a higher one

Drift metrics observe the fact registry, where user facts actually live, rather
than only the narrative sections.

## Operational Rules

Rules 1 to 3 are implemented; 4 to 6 remain guidance.

1. **Implemented.** Stable facts are not overwritten by weaker evidence. Write
   protection applies on every digest path rather than only the classifier-driven
   one, and a document-authority facet refuses a fact when the run has no
   document.
2. **Implemented.** Constraint removal requires explicit contrary evidence; the
   consistency gate rejects contradictions against protected facts.
3. **Implemented.** Facts supersede rather than replace — the old entry keeps
   `supersededBy`, and one displaced without a replacement keeps `retiredAt` and
   `retiredReason`. Nothing in the registry is deleted.
4. Todos should distinguish open, completed, canceled, and duplicate states.
5. Answers should expose evidence or explicitly signal uncertainty.
6. Replay should be treated as a first-class check on memory stability.

## Benchmark Implications

A drift-focused benchmark fixture should be able to test at least one of these patterns:

- long-running goal continuity
- repeated constraint reinforcement
- conflicting decision updates
- noisy event interference
- todo pile-up and completion
- rebuild consistency under the same input history

## Failure Taxonomy Interface

Drift should connect directly to digest failure analysis.

Suggested failure buckets:

- invalid structured output
- contradiction with stable facts
- missing required retained facts
- repeated or no-op changes
- unsupported next steps
- unstable replay result

Not every failure is drift, but drift-related failures should be labeled separately so benchmark results can answer both:

- did the digest fail formatting or control constraints
- did the memory system drift semantically

## Immediate Next Steps

The near-term implementation path should be:

1. Add drift labels to benchmark fixtures.
2. Expand `consistencyCheck()` with explicit goal, constraint, decision, and todo drift checks.
3. Add benchmark outputs for state drift and digest contradiction rates.
4. Define a stronger `DigestState` successor that includes evidence references and change policy.
5. Add replay tests that compare state snapshots across rebuild runs.
