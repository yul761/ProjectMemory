# Benchmark Comparison (All Runs)

Generated from 4 benchmark JSON files in `benchmark-results/`.

## Overall Timeline

| Run | File | Started At | Profile | Events | Concurrency | Retrieve Q | Digest Runs | Overall | Ingest | Retrieve | Digest | Reminder |
|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | `benchmark-2026-02-03T05-56-31-707Z.json` | 2026-02-03T05:54:46.309Z | legacy | 300 | 20 | 12 | 2 | 81.58 | 100 | 65 | 61.93 | 100 |
| 2 | `benchmark-2026-02-03T06-18-23-411Z.json` | 2026-02-03T06:12:04.058Z | legacy | 60 | 12 | 16 | 3 | 83.49 | 100 | 100 | 45 | 99.94 |
| 3 | `benchmark-2026-02-03T06-32-58-726Z.json` | 2026-02-03T06:26:13.065Z | legacy | 60 | 12 | 16 | 3 | 83.5 | 100 | 100 | 45 | 100 |
| 4 | `benchmark-2026-02-03T06-54-40-748Z.json` | 2026-02-03T06:43:34.256Z | balanced | 60 | 12 | 16 | 3 | 94 | 100 | 100 | 80 | 100 |

## Key Metric Comparison

| Run | Ingest Throughput (evt/s) | Ingest P95 (ms) | Retrieve Hit | Retrieve Strict Hit | Retrieve P95 (ms) | Digest Success | Digest Consistency | Digest Avg Latency (ms) | Reminder Delay (ms) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 468.14 | 89.98 | 0.5 | N/A | 17.28 | 2/2 | 0 | 19609.78 | 45218 |
| 2 | 350.35 | 71.64 | 1 | N/A | 16.37 | 3/3 | 0 | 99526.1 | 60284 |
| 3 | 366.17 | 65.03 | 1 | N/A | 20.1 | 3/3 | 0 | 126673.63 | 5110 |
| 4 | 351.03 | 66.58 | 1 | 1 | 19.29 | 3/3 | 1 | 78401.15 | 45241 |

## Situation Notes (Each Run)

- **Run 1** (`benchmark-2026-02-03T05-56-31-707Z.json`): High-load ingest profile.
- **Run 2** (`benchmark-2026-02-03T06-18-23-411Z.json`): Short-run digest stress; Very high digest latency.
- **Run 3** (`benchmark-2026-02-03T06-32-58-726Z.json`): Short-run digest stress; Very high digest latency; Fast reminder cycle observed.
- **Run 4** (`benchmark-2026-02-03T06-54-40-748Z.json`): Short-run digest stress; Semantic + strict retrieve scoring enabled; Digest consistency gate passing.

## First vs Latest

- Overall: **81.58 -> 94** (↑ 12.42 pts)
- Retrieve score: **65 -> 100** (↑ 35.00 pts)
- Digest score: **61.93 -> 80** (↑ 18.07 pts)
- Digest consistency pass rate: **0 -> 1** (↑ 1.00)
- Ingest throughput: **468.14 -> 351.03** (↓ -117.11 evt/s)
- Digest avg latency: **19609.78 -> 78401.15** (↓ 58791.37 ms)

## Takeaways

- Retrieve quality is now saturated at current benchmark dataset (semantic + strict both reach 1.0 in latest run).
- Digest reliability improved materially (consistency from 0 to 1), while latency remains the main bottleneck.
- Ingest remains strong (>350 evt/s in tuned runs) with stable p95 latency around ~65-72 ms.
- Reminder pipeline is reliable, but delay varies with scheduler timing and benchmark phase.
