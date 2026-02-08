# Research Overview

Project Memory is positioned as a research-grade long-term memory engine. The goal is to provide a reproducible baseline for studying layered digests, consistency constraints, and memory retrieval under controlled workloads.

## Scope
- Focus on system behavior, not end-user UI.
- Emphasis on reproducibility and transparent evaluation.
- Optional LLM usage; experiments must record model/provider and settings.

## Core Research Themes
1. Digest consistency under evolving event streams.
2. Trade-offs between latency, throughput, and reliability.
3. Drift prevention via protected state merges and snapshots.

## Artifacts
- Evaluation protocol: `docs/evaluation-protocol.md`
- Research questions: `docs/research-questions.md`
- Report template: `docs/research-report-template.md`
- Benchmark runner: `scripts/benchmark/run-benchmark.mjs`
