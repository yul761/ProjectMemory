# Benchmarking

StateCore includes a reproducible benchmark runner for research-facing claims (latency, throughput, reliability, digest consistency).

In the three-layer architecture, benchmark output should be read as separating:

- Fast Layer turn latency
- Working Memory update latency
- State Layer digest latency
- direct-state fast-path rate for runtime turns
- runtime diagnostic quality (`layerAlignment` / `warnings`)
- layer freshness quality (`freshness.workingMemoryCaughtUp` / `freshness.stableStateCaughtUp`)
- consistency between runtime-turn diagnostics and `GET /memory/layer-status`

For runtime consistency metrics, benchmark compares the runtime-turn diagnostics
against the pre-turn `GET /memory/layer-status` snapshot for the same message.
That keeps the comparison anchored to the same moment in time rather than mixing
turn-time state with post-background-update state.

## Run

Prerequisites:
- API running
- Worker running
- Postgres + Redis running

Command:
```bash
pnpm benchmark
```

Reproducible run (fixed seed + fixture):
```bash
BENCH_SEED=42 BENCH_FIXTURE=benchmark-fixtures/basic.json pnpm benchmark
```

Three-layer runtime scenario:
```bash
BENCH_FIXTURE=benchmark-fixtures/three-layer-session.json pnpm benchmark
```

If you want benchmark HTTP calls to fail fast instead of hanging on one bad
request, set a per-request timeout:

```bash
BENCH_REQUEST_TIMEOUT_MS=15000 BENCH_FIXTURE=benchmark-fixtures/three-layer-session.json pnpm benchmark
```

The same pattern is now available for drift runs:

```bash
DRIFT_REQUEST_TIMEOUT_MS=15000 DRIFT_RUNS=10 DRIFT_FIXTURE=benchmark-fixtures/goal-evolution.json node scripts/benchmark/run-drift.mjs
```

The visible comparison runner also supports request timeouts:

```bash
VISIBLE_COMPARE_REQUEST_TIMEOUT_MS=15000 pnpm benchmark:visible
```

That runner now writes partial reports while it is still in progress, so a failed
checkpoint leaves behind a readable artifact instead of an empty hang.

`three-layer-session.json` is the fixture to use when you want runtime-facing evidence for the
new architecture. It simulates a drift-sensitive session where:

- the goal shifts from generic low-drift memory into an explicit three-layer runtime
- Working Memory is expected to refresh between turns
- State Layer remains the durable truth via the digest pipeline
- benchmark reports should separate fast-path latency from Working Memory and State Layer update latency
- benchmark reports should also show whether runtime turns hit `direct_state_fast_path`
- benchmark reports should also show whether runtime turns and `layer-status` agree on goal alignment and warnings
- benchmark reports now also include runtime warning taxonomy so a bad alignment score is explainable

Additional higher-coverage fixtures:

- `long-session-handoff.json`
  - longer continuity window
  - operator handoff notes mixed with durable work
  - transient cleanup todos mixed with durable roadmap todos
- `failure-mode-mixed-signals.json`
  - stale document replacement
  - contradiction handling
  - transient todo filtering
  - mixed hosted-vs-self-hosted direction changes

Generate additional fixtures:
```bash
node scripts/benchmark/generate-fixtures.mjs
```

Fixture files may include explicit `gold` labels for:
- `goal`
- `constraints`
- `decisions`
- `todos`
- `openQuestions`
- `risks`
- `resolvedOpenQuestions`
- `resolvedRisks`
- `latestDocumentFacts`
- `supersededDocumentFacts`

Drift benchmarks will prefer these labels when present and fall back to parsing event text otherwise.
Drift reports include per-category omission and contradiction taxonomy summaries when gold labels are available.
`todo-pileup.json` is intended to stress todo continuity when durable roadmap tasks are mixed with many short-lived cleanup tasks.
When a fixture provides `gold.transientTodos`, drift reports also emit a `temporaryTodoIntrusionRate`.
`document-version-updates.json` is intended to stress whether the latest document version remains current while superseded guidance stays out of active memory.

Run ablations (controlled variable sweeps):
```bash
node scripts/benchmark/run-ablations.mjs
```

The ablation matrix now includes both digest-control variables and assistant runtime policy profiles.
When comparing ablations, prefer reporting `Long-term Memory Reliability` and runtime metrics alongside the overall score.
See `docs/runtime-profile-ablation-guide.md` for a runtime-focused interpretation guide.
Generated ablation summaries now break out overall score, reliability, and runtime behavior separately.

Run drift test (50 rounds default):
```bash
DRIFT_RUNS=50 DRIFT_FIXTURE=benchmark-fixtures/decision-heavy.json node scripts/benchmark/run-drift.mjs
```

Contradiction-injection drift test:
```bash
DRIFT_RUNS=25 DRIFT_FIXTURE=benchmark-fixtures/contradiction-injected.json node scripts/benchmark/run-drift.mjs
```

Goal-evolution drift test:
```bash
DRIFT_RUNS=25 DRIFT_FIXTURE=benchmark-fixtures/goal-evolution.json node scripts/benchmark/run-drift.mjs
```

Todo-pileup drift test:
```bash
DRIFT_RUNS=25 DRIFT_FIXTURE=benchmark-fixtures/todo-pileup.json node scripts/benchmark/run-drift.mjs
```

Document-version drift test:
```bash
DRIFT_RUNS=25 DRIFT_FIXTURE=benchmark-fixtures/document-version-updates.json node scripts/benchmark/run-drift.mjs
```

Retrieval-semantic benchmark:
```bash
BENCH_FIXTURE=benchmark-fixtures/retrieval-semantic.json BENCH_RETRIEVE_USE_EMBEDDINGS=true pnpm benchmark
```

### Per-stage latency breakdown

Retrieve and digest emit structured stage timings to the logs (the benchmark
reports end-to-end p95; the breakdown lives in logs to keep it out of the /v1
response):

- Retrieve: log `"retrieve stage timings"` → `retrieveTimings: { embedMs, vectorSearchMs, rerankMs, totalMs }`
  (`embedMs` is the vector-search query-embedding cost only; the rerank's own embedding cost is folded into `rerankMs`, so `embedMs: 0` means vector search was not active, not that no embedding ran at all)
- Digest: log `"digest stage timings"` → `digestTimings: { selectionMs, classificationMs, deltaMs, mergeMs, generationMs }`

Filter the API/worker logs by these messages to see where retrieve/digest time
goes (the current p95 is dominated by the embedding/LLM calls, not the DB query).

### Verifying the HNSW index is used

The HNSW index (`MemoryEventEmbedding_embedding_hnsw_idx`, `vector_cosine_ops`)
is used only when the query uses the matching cosine operator `<=>`. To confirm
on a populated database:

    EXPLAIN ANALYZE
    SELECT mee."eventId" FROM "MemoryEventEmbedding" mee
    JOIN "MemoryEvent" me ON me.id = mee."eventId"
    WHERE me."scopeId" = '<scope>'
    ORDER BY mee.embedding <=> '<query-vector>'::vector LIMIT 20;

Look for an `Index Scan using MemoryEventEmbedding_embedding_hnsw_idx`. On small
tables the planner may still choose a sequential scan — that is expected and
correct; the index matters at scale. Set `SET hnsw.ef_search = <n>;` to trade
recall vs latency.

Document-heavy runtime benchmark:
```bash
BENCH_FIXTURE=benchmark-fixtures/document-heavy.json BENCH_RUNTIME_POLICY_PROFILE=document-heavy pnpm benchmark
```

Runtime override benchmark example:
```bash
BENCH_RUNTIME_POLICY_PROFILE=conservative BENCH_RUNTIME_PROMOTE_LONG_FORM=true BENCH_RUNTIME_RECALL_LIMIT=8 pnpm benchmark
```

Generate a research-report draft from the latest benchmark and ablation outputs:
```bash
node scripts/benchmark/generate-research-report.mjs
```

Generate a trend report from recent benchmark JSON artifacts:
```bash
pnpm benchmark:trend
```

Fixture-scoped trend report:
```bash
BENCH_TREND_FIXTURE=benchmark-fixtures/document-heavy.json pnpm benchmark:trend
```

Replay consistency check:
```bash
REPLAY_FIXTURE=benchmark-fixtures/basic.json node scripts/benchmark/run-replay-check.mjs
```

Increase repeated rebuild checks inside the main benchmark:
```bash
BENCH_REPLAY_RUNS=5 pnpm benchmark
```

Replay reports include category-level state diffs for:
- `goal`
- `constraints`
- `decisions`
- `todos`
- `goalConfidence`
- `constraintConfidence`
- `decisionConfidence`
- `todoConfidence`
- `volatileContextConfidence`
- `openQuestionConfidence`
- `riskConfidence`
- `transitionTaxonomy`

Replay scoring and reports now track the `recentChanges` transition taxonomy in addition to
final state equality, so rebuild stability covers how state evolved, not just what the last
snapshot contained.

`Long-term Memory Reliability` uses a replay stability blend that combines rebuild
consistency, cross-run state divergence, transition-taxonomy match rate, and cross-run
transition divergence.

The grounded-response view also tracks whether runtime and answer evidence include a
structured state transition taxonomy, not just plain state summaries.
- `volatileContext`
- `evidenceRefs`
- `goalProvenance`
- `constraintProvenance`
- `decisionProvenance`
- `todoProvenance`
- `recentChanges`
- `openQuestions`
- `risks`
- `workingContext`

`evidenceRefs` may now contain either legacy string ids or structured refs from newer snapshots; replay and benchmark diffing normalize both forms before comparison.

Outputs are written to `benchmark-results/`:
- `benchmark-*.json`
- `benchmark-*.md`
- `trend-*.json`
- `trend-*.md`

## What It Measures

1. Ingest
- event throughput (events/s)
- p50/p95 latency
- success/failure counts

2. Retrieve
- p50/p95 latency
- semantic hit rate (concept + alias grounded check)
- strict hit rate (exact keyword check)
- retrieval mode (`heuristic` or `hybrid`)
- retrieve limit used for each query batch
- whether embedding rerank was requested and whether an embedding role was configured
- embedding candidate-limit metadata for reproducibility
- ranking-reason coverage for returned matches
- reranked-query rate and embedding top-match rate
- top-match source-type bias and source-diversity rate

3. Digest (when `FEATURE_LLM=true`)
- success rate
- average end-to-end latency
- consistency pass rate (summary/changes/nextSteps constraints)
- repeatability rate across successful digest runs
- omission warning rate from persisted digest consistency taxonomy
- failure taxonomy histogram for digest benchmark runs
- persisted consistency taxonomy histogram from accepted digest snapshots
- gold-backed retention and contradiction summary when fixture labels are available
- latest-document retention and superseded-document intrusion checks when fixture labels are available

When gold labels are available, benchmark JSON also emits retention-oriented aliases:
- `factRetentionRate`
- `goalRetentionRate`
- `constraintPreservationRate`
- `decisionContinuityRate`
- `todoContinuityRate`
- `openQuestionContinuityRate`
- `riskContinuityRate`

The benchmark now also emits state-backed counterparts for the latest protected snapshot:
- `stateFactRetentionRate`
- `stateGoalRetentionRate`
- `stateConstraintPreservationRate`
- `stateDecisionContinuityRate`
- `stateTodoContinuityRate`
- `latestDocumentRetentionRate`
- `stateLatestDocumentRetentionRate`
- `supersededDocumentIntrusionRate`
- `stateSupersededDocumentIntrusionRate`
- `digestDriftRate`
- `stateDriftRate`

4. Reminder
- due-to-sent latency
- delivery success

5. Replay
- rebuild snapshot count
- full-state equivalence check
- category-level mismatch report for protected state and evidence context

6. Assistant runtime
- turn success rate
- average turn latency
- fast-path average turn latency
- working-memory update average latency
- stable-state update average latency
- evidence coverage rate
- digest-summary evidence rate
- event-snippet evidence rate
- event ranking-reason evidence rate
- event score evidence rate
- event embedding-reason evidence rate
- event document-source evidence rate
- state-summary evidence rate
- state-confidence evidence rate
- state-transition-taxonomy evidence rate
- digest trigger rate
- observed write-tier distribution
- policy profile used by the run
- runtime decision-note taxonomy
- working-memory-version coverage rate
- stable-state-version coverage rate
- fast-layer-context-summary coverage rate

7. Answer grounding
- answer success rate
- answer evidence coverage rate
- answer event ranking-reason evidence rate
- answer event score evidence rate
- answer state-summary evidence rate
- answer state-confidence evidence rate
- answer state-transition-taxonomy evidence rate

8. Grounded response view
- combined success rate across runtime turns and answer calls
- combined evidence coverage / ranking-reason / event-score / state-summary / state-confidence / state-transition-taxonomy rates
- intended as the top-level grounding view, with runtime and answer metrics as drill-downs
- ablation and trend reports now surface this view directly in highlights so grounding regressions are easier to spot

## Scoring Model (0-100)

Weighted score:
- LLM enabled: ingest 30%, retrieve 20%, digest 30%, reminder 20%
- LLM disabled: ingest 45%, retrieve 35%, reminder 20%

Each component score is derived from thresholds on latency/success/hit-rate.

The benchmark also emits a separate `Long-term Memory Reliability` score.
This memory-first score is distinct from the overall performance score and combines:

- digest consistency
- gold-backed retention
- contradiction and omission penalties
- temporary todo intrusion penalties when available
- replay consistency
- rebuild consistency across repeated replay runs
- cross-run replay divergence penalties
- runtime and answer grounding quality, including state-confidence and state-transition evidence

Benchmark JSON and Markdown reports also emit a reliability breakdown so changes can be attributed to:

- consistency
- retention
- contradiction control
- replay
- runtime grounding

## Profiles And Tuning

`BENCH_PROFILE` presets:
- `quick`: fast smoke benchmark
- `balanced` (default): stable local comparison
- `stress`: higher load for saturation checks

Env values still override profile defaults.

## Tuning via Env

- `BENCH_PROFILE` (default balanced)
- `BENCH_EVENTS` (profile default)
- `BENCH_INGEST_CONCURRENCY` (profile default)
- `BENCH_RETRIEVE_QUERIES` (profile default)
- `BENCH_RETRIEVE_LIMIT` (default `20`; fixture `retrieveLimit` overrides it)
- `BENCH_RETRIEVE_USE_EMBEDDINGS` (records the intended retrieval mode in benchmark outputs; start the API with matching `RETRIEVE_USE_EMBEDDINGS`)
- `BENCH_RETRIEVE_EMBEDDING_CANDIDATE_LIMIT` (records the intended hybrid rerank candidate limit; start the API with matching `RETRIEVE_EMBEDDING_CANDIDATE_LIMIT`)

When available, the benchmark runner also reads `/health` and records the API's actual retrieval and model-role configuration so reports can distinguish benchmark-side intent from live API settings.
- `BENCH_RUNTIME_RUNS` (profile default)
- `BENCH_RUNTIME_POLICY_PROFILE` (default `default`)
- `BENCH_RUNTIME_RECALL_LIMIT` (optional override)
- `BENCH_RUNTIME_PROMOTE_LONG_FORM` (`true|false`)
- `BENCH_RUNTIME_DIGEST_ON_CANDIDATE` (`true|false`)
- `BENCH_DIGEST_RUNS` (profile default)
- `BENCH_TIMEOUT_MS` (default 180000)
- `BENCH_USER_ID` (default benchmark-user)
- `BENCH_OUTPUT_DIR` (default benchmark-results)
- `BENCH_SEED` (default 42)
- `BENCH_FIXTURE` (path to JSON fixture; optional)

## Reproducibility Protocol

To compare results across machines:
1. Use a fixed `BENCH_SEED`.
2. Use the same `BENCH_FIXTURE` file (or none).
3. Keep the same `BENCH_PROFILE` or explicit env overrides.
4. Record model provider metadata (`MODEL_PROVIDER`, `MODEL_NAME`, `MODEL_BASE_URL`).
5. Report the generated JSON with config metadata.

## Interpreting Results

For external sharing, focus on:
- p95 ingest latency
- retrieve hit rate + p95
- digest consistency pass rate
- long-term memory reliability trend
- reliability breakdown trend
- reminder delay distribution
- overall score trend across commits

Use the same benchmark config across runs to keep comparisons fair.
