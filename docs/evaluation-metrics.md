# Evaluation Metrics Specification

This document defines the intended metric system for StateCore.

The project should not rely on a single benchmark score or on vague claims that memory "feels better". It should measure whether the system retains important information, avoids drift, grounds its answers in evidence, and reproduces stable state over time.

## Purpose

The evaluation system should answer four questions:

1. Did the system retain the right information?
2. Did the system avoid harmful drift?
3. Were answers grounded in memory evidence?
4. Can memory state be replayed or rebuilt consistently?

This document extends the existing benchmark and evaluation docs rather than replacing them.

## Metric Layers

StateCore should track metrics at five layers:

1. system performance
2. retention
3. drift
4. grounding
5. replay and stability

The current repository already measures much of layer 1 and part of layer 3. The remaining layers should be treated as first-class roadmap work.

## 1. System Performance Metrics

These metrics describe whether the system runs reliably and within practical latency budgets.

### Ingest

- throughput in events per second
- p50 latency
- p95 latency
- success count
- failure count

### Retrieve

- p50 latency
- p95 latency
- semantic hit rate
- strict hit rate

### Digest

- digest run success rate
- digest consistency pass rate
- average end-to-end latency
- retry count
- failure reason distribution

### Reminder

- delivery success rate
- due-to-sent latency

These are already close to the current benchmark implementation.

## 2. Retention Metrics

Retention metrics measure whether important memory survives over time.

### Fact Retention Rate

Definition:

The fraction of gold facts that remain recoverable from digest output, protected state, or answer-time recall after repeated interaction.

Use cases:

- long-running assistant sessions
- repeated digest cycles
- rebuild and replay comparisons

### Goal Retention Rate

Definition:

The fraction of gold goal statements that remain present and correct in protected state or digest output.

This should be stricter than general fact retention because the primary goal is often the highest-value stable fact.

### Constraint Preservation Rate

Definition:

The fraction of durable constraints that remain preserved without being omitted, weakened, or reversed.

### Decision Continuity Rate

Definition:

The fraction of accepted decisions that remain represented continuously across successive digests or state snapshots, unless explicitly superseded.

### Todo Continuity Rate

Definition:

The fraction of active todos that remain represented correctly until they are completed, canceled, or superseded.

Recommended stress fixture:

- `benchmark-fixtures/todo-pileup.json` for distinguishing durable roadmap todos from short-lived execution cleanup tasks

## 3. Drift Metrics

Drift metrics measure whether the memory system changes content in unsupported or harmful ways.

The semantic definitions for these drift types live in `docs/drift-definition.md`.

### Goal Drift Rate

Definition:

The rate at which the system drops, mutates, or invents project goals without sufficient supporting evidence.

### Constraint Drift Rate

Definition:

The rate at which durable constraints are omitted, weakened, reversed, or contradicted.

### Decision Contradiction Rate

Definition:

The rate at which accepted decisions are contradicted, silently replaced, or lost without explicit superseding evidence.

### Todo Drift Rate

Definition:

The rate at which todos disappear incorrectly, duplicate, or become detached from supported state.

### Temporary Todo Intrusion Rate

Definition:

The rate at which short-lived execution todos appear in digest output or drift summaries as if they were durable roadmap tasks.

This is especially useful for fixtures such as `benchmark-fixtures/todo-pileup.json`.

### Latest Document Retention Rate

Definition:

The fraction of current document-version facts that remain represented after newer content replaces earlier content for the same document key.

Recommended stress fixture:

- `benchmark-fixtures/document-version-updates.json`

### Superseded Document Intrusion Rate

Definition:

The rate at which facts from superseded document versions continue to appear in digest output or protected state as if they were still current.

Recommended stress fixture:

- `benchmark-fixtures/document-version-updates.json`

### Digest Contradiction Rate

Definition:

The rate at which generated digest output contradicts protected state or gold fixture facts.

### State Drift Rate

Definition:

An aggregate measure of divergence between expected protected state and actual protected state across goals, constraints, decisions, and todos.

The benchmark now derives this as an aggregate of lower-level state drift signals, including state-backed retention loss and state-side intrusion from temporary todos or superseded document facts.

## 4. Grounding Metrics

Grounding metrics measure whether answers or digest outputs are actually based on evidence.

### Answer Grounding Rate

Definition:

The fraction of answers whose substantive claims are supported by retrieved digest content, state snapshots, or source events.

### Evidence Usage Rate

Definition:

The fraction of answers that use at least one valid evidence source when a relevant source exists.

### Unsupported Claim Rate

Definition:

The fraction of answer claims that cannot be traced to retrieved memory evidence.

### Constraint Violation Rate

Definition:

The fraction of answers that recommend or imply actions that conflict with preserved constraints.

## 5. Replay and Stability Metrics

These metrics measure whether the memory system is reproducible and auditable.

### Rebuild Consistency Rate

Definition:

The fraction of rebuild or replay runs that produce compatible protected state and digest outcomes from the same event history under the same configuration.

### Snapshot Replay Stability

Definition:

The fraction of replay comparisons where state snapshots remain equivalent or within an accepted divergence tolerance.

### Cross-run State Divergence Rate

Definition:

The rate at which the same input history yields materially different protected state across runs.

### Digest Repeatability Rate

Definition:

The fraction of repeated digest runs on the same evidence that produce compatible summary, change, and next-step structure.

## 6. Developer Experience Metrics

StateCore also claims to reduce integration overhead. That needs its own metric family.

### Time to First Memory

Definition:

Elapsed time from setup start to first successful end-to-end memory write and retrieval.

### Setup Step Count

Definition:

The number of required developer actions to reach a working local or self-hosted integration.

### Local Deployment Success Rate

Definition:

The fraction of tested environments where a documented local setup succeeds without undocumented manual fixes.

### Example Integration Completion Time

Definition:

Elapsed time for a developer to wire StateCore into a reference assistant integration.

## North Star Metric

The project can summarize memory quality using a composite score:

`Long-term Memory Reliability Score`

This should reflect:

- retention
- drift resistance
- grounding
- replayability

It should not hide the underlying sub-metrics. The composite is for trend communication, not for replacing diagnosis.

## Metric Interpretation Rules

The project should not treat all metrics as interchangeable.

Recommended interpretation order:

1. Safety and correctness metrics first
2. Stability and replay metrics second
3. Retention metrics third
4. Performance metrics fourth
5. Composite score last

This matters because a high throughput benchmark is not meaningful if drift or grounding is poor.

## Recommended Metric Families by Evaluation Type

### Baseline Benchmark

Use for:

- ingest performance
- retrieve hit rates
- digest latency
- digest consistency

### Drift Benchmark

Use for:

- goal drift
- constraint drift
- decision contradiction
- todo continuity loss
- repeated change rate

### Grounding Evaluation

Use for:

- answer grounding
- unsupported claims
- evidence usage
- constraint violations

### Replay Evaluation

Use for:

- rebuild consistency
- snapshot replay stability
- cross-run state divergence

### Ablation Evaluation

Use for:

- how individual mechanisms affect drift, retention, grounding, and latency

## Fixture Requirements

Each benchmark fixture should eventually expose labels that support metric computation.

Suggested fixture labels:

- gold goals
- gold constraints
- gold decisions
- gold todos
- contradiction injections
- expected supported answers
- expected prohibited answers

Recommended fixture families now include:

- baseline memory continuity
- decision-heavy continuity
- noise-heavy retrieval stress
- contradiction-injected drift checks

Without labeled fixtures, many of the higher-level metrics remain subjective.

## Metric Calculation Guidance

The following rules should guide future implementation.

### Use explicit gold data when possible

If a fixture encodes gold facts, prefer scoring against those facts rather than against free-form judgment.

### Separate omission from contradiction

Missing a fact and contradicting a fact are different failure modes and should be counted separately.

### Prefer category scores over one global pass-fail

A digest might preserve constraints well while losing todos. The metrics should preserve that distinction.

### Record raw counts before percentages

Percentages are useful for summaries, but raw counts are required for auditability.

### Preserve run metadata

Each report should include:

- commit hash
- fixture id
- provider and model settings
- benchmark configuration
- timestamp

## Relationship to Current Repository

Today the repository already measures:

- ingest throughput and latency
- retrieve hit rate and latency
- digest success and consistency pass rate
- reminder delivery timing
- a simple drift runner with recall slope and repeated change rate

That is a useful base, but it is not yet the full memory-quality evaluation system described in the roadmap.

Partly closed since this list was written:

- **retention scoring** now has an external number alongside the internal
  synthetic one — `docs/longmemeval.md` reports ingest completeness and answer
  accuracy at an equal context budget against another system
- **state-level drift metrics** observe the fact registry, not only the narrative
  sections

Still open:

- grounding scoring for answer outputs
- replay consistency scoring
- developer experience metrics
- **auditability scoring — the largest gap, because it is the differentiator.**
  The engine can be asked what a fact's evidence was, what it believed before,
  and what a digest discarded; none of it is scored. A memory system that cannot
  demonstrate its audit trail is in the position this document exists to
  argue against: claiming a property without measuring it.

## Suggested Rollout Order

The safest implementation order is:

1. add labeled drift and retention fixtures
2. expand drift benchmark outputs
3. add state-level comparison metrics
4. add answer grounding evaluation
5. add replay and rebuild scoring
6. add composite reporting and commit-over-commit trend views

## Reporting Standard

Every serious evaluation report should include:

- experiment goal
- fixture and gold labels used
- configuration and commit hash
- raw counts
- percentages or rates
- failure taxonomy summary
- notable regressions or improvements

## Success Criteria

The metric system is doing its job when StateCore can answer, with evidence:

- what the system remembered
- what the system forgot
- where the system drifted
- whether answers were grounded
- whether rebuilds stayed stable

At that point, "low drift" becomes a measurable claim rather than a positioning statement.
