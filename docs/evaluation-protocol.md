# Evaluation Protocol

This protocol defines a minimal, reproducible evaluation for Project Memory.

## Environment
- Record OS, Node version, and hardware.
- Record database and Redis versions.
- Record LLM provider, model, temperature, and timeout settings (if enabled).

## Benchmark Config
Use fixed values for comparisons:
- `BENCH_SEED`
- `BENCH_PROFILE` or explicit overrides
- `BENCH_FIXTURE` (if used)

## Procedure
1. Start Postgres and Redis.
2. Apply migrations and start API + worker.
3. Run benchmark with fixed config.
4. Save JSON + Markdown reports.

## Reporting
Include:
- Config block (seed, fixture, profile, env overrides)
- Scores and metrics
- Any failures or skipped components (e.g., LLM disabled)

## Reproducibility Checklist
- [ ] Fixed seed used
- [ ] Same fixture file used
- [ ] Same profile or explicit overrides
- [ ] Same code commit hash
- [ ] Raw JSON report attached
