# Benchmarking

Project Memory includes a reproducible benchmark runner for research-facing claims (latency, throughput, reliability, digest consistency).

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

Generate additional fixtures:
```bash
node scripts/benchmark/generate-fixtures.mjs
```

Run ablations (controlled variable sweeps):
```bash
node scripts/benchmark/run-ablations.mjs
```

Outputs are written to `benchmark-results/`:
- `benchmark-*.json`
- `benchmark-*.md`

## What It Measures

1. Ingest
- event throughput (events/s)
- p50/p95 latency
- success/failure counts

2. Retrieve
- p50/p95 latency
- semantic hit rate (concept + alias grounded check)
- strict hit rate (exact keyword check)

3. Digest (when `FEATURE_LLM=true`)
- success rate
- average end-to-end latency
- consistency pass rate (summary/changes/nextSteps constraints)

4. Reminder
- due-to-sent latency
- delivery success

## Scoring Model (0-100)

Weighted score:
- LLM enabled: ingest 30%, retrieve 20%, digest 30%, reminder 20%
- LLM disabled: ingest 45%, retrieve 35%, reminder 20%

Each component score is derived from thresholds on latency/success/hit-rate.

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
4. Report the generated JSON with config metadata.

## Interpreting Results

For external sharing, focus on:
- p95 ingest latency
- retrieve hit rate + p95
- digest consistency pass rate
- reminder delay distribution
- overall score trend across commits

Use the same benchmark config across runs to keep comparisons fair.
