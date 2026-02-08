# Project Memory Benchmark Report (Baseline Example)

This is a placeholder example report to illustrate the expected output format.

- Started: 2026-02-08T00:00:00.000Z
- Ended: 2026-02-08T00:10:00.000Z
- API: http://localhost:3000
- Seed: 42
- Fixture: benchmark-fixtures/basic.json
- Commit: 0000000000000000000000000000000000000000
- Node: v20.x (darwin/arm64)
- CPU: Example CPU (10 cores, 16 GB)

## Scores

- Overall: **72.5** / 100
- Ingest: 78.4
- Retrieve: 66.2
- Digest: 70.1
- Reminder: 75.3

## Metrics

- Ingest throughput: 52.3 events/s (p95 210 ms)
- Retrieve semantic hit rate: 0.75, strict hit rate: 0.50 (p95 280 ms)
- Digest success: 2/2, consistency pass 0.5, avg latency 12000 ms
- Reminder sent: yes, delay 62000 ms

## Notes

- Placeholder values for documentation only. Do not cite as real results.
