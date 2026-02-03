# Benchmark Comparison (Latest vs Previous)

- Previous: `benchmark-2026-02-03T05-56-31-707Z.json`
- Latest: `benchmark-2026-02-03T06-18-23-411Z.json`

## Score Summary

- Overall: **81.58 → 83.49** (1.91 pts)

## Metric Deltas

| Metric | Previous | Latest | Delta | Trend |
|---|---:|---:|---:|:--:|
| Overall Score | 81.58 | 83.49 | +1.91 | ↑ ✅ |
| Ingest Score | 100.00 | 100.00 | 0.00 | → ✅ |
| Retrieve Score | 65.00 | 100.00 | +35.00 | ↑ ✅ |
| Digest Score | 61.93 | 45.00 | -16.93 | ↓ ⚠️ |
| Reminder Score | 100.00 | 99.94 | -0.06 | ↓ ⚠️ |
| Ingest Throughput (events/s) | 468.14 | 350.35 | -117.79 | ↓ ⚠️ |
| Ingest P95 (ms) | 89.98 | 71.64 | -18.34 | ↓ ✅ |
| Retrieve Hit Rate | 0.500 | 1.000 | +0.500 | ↑ ✅ |
| Retrieve P95 (ms) | 17.28 | 16.37 | -0.91 | ↓ ✅ |
| Digest Consistency Pass Rate | 0.000 | 0.000 | 0.000 | → ✅ |
| Digest Avg Latency (ms) | 19609.78 | 99526.10 | +79916.32 | ↑ ⚠️ |
| Reminder Delay (ms) | 45218.00 | 60284.00 | +15066.00 | ↑ ⚠️ |

## Config Snapshot

| Key | Previous | Latest |
|---|---|---|
| `concurrency` | `20` | `12` |
| `digestRuns` | `2` | `3` |
| `events` | `300` | `60` |
| `retrieveQueries` | `12` | `16` |

## Notes

- Trend icons assume higher is better except latency metrics.
- Use this report with the raw JSON for reproducibility.
