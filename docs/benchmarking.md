# Benchmarking

Project Memory includes a reproducible benchmark runner for developer-facing claims (latency, throughput, reliability, digest consistency).

## Run

Prerequisites:
- API running
- Worker running
- Postgres + Redis running

Command:
```bash
pnpm benchmark
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
- hit rate (keyword-grounded heuristic check)

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

## Tuning via Env

- `BENCH_EVENTS` (default 300)
- `BENCH_INGEST_CONCURRENCY` (default 20)
- `BENCH_RETRIEVE_QUERIES` (default 12)
- `BENCH_DIGEST_RUNS` (default 2)
- `BENCH_TIMEOUT_MS` (default 180000)
- `BENCH_USER_ID` (default benchmark-user)
- `BENCH_OUTPUT_DIR` (default benchmark-results)

## Interpreting Results

For external sharing, focus on:
- p95 ingest latency
- retrieve hit rate + p95
- digest consistency pass rate
- reminder delay distribution
- overall score trend across commits

Use the same benchmark config across runs to keep comparisons fair.
