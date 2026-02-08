# Ablation Results (2026-02-08)

This document summarizes the ablation study based on:
- Baseline report: `benchmark-results/benchmark-2026-02-08T05-59-35-302Z.md`
- Ablation summary: `benchmark-results/ablation-2026-02-08T06-34-38-713Z.md`

## Setup

- Profile: `quick`
- Seed: `42`
- Fixture: `benchmark-fixtures/basic.json`
- API: `http://localhost:3000`
- Benchmark runner: `scripts/benchmark/run-benchmark.mjs`

## Ablation Matrix (Overall Score)

- baseline: **82.78**
- no_classifier: **94.00**
- high_novelty: **83.50**
- low_novelty: **88.75**
- small_budget: **96.49**
- large_budget: **83.49**

## Key Findings

### 1) Smaller budgets improve stability
`small_budget` produced the highest overall score (96.49). With fewer selected events, the digest generator receives a narrower evidence set, which appears to reduce inconsistency and improve completion latency.

### 2) Disabling the classifier helped
`no_classifier` scored 94.00, outperforming baseline. Under this fixture, heuristic selection + novelty filtering likely outperformed classifier-driven re-labeling, suggesting that the classifier adds variance without clear gains on small, deterministic workloads.

### 3) High novelty thresholds degrade digest quality
`high_novelty` scored 83.50 with the lowest digest component. Raising the novelty threshold appears to drop relevant events, making the digest less consistent or incomplete.

### 4) Large budgets harm digest performance
`large_budget` scored 83.49 and had a weak digest component, indicating that excessive event volume degrades output quality and/or increases generation latency.

## Interpretation

For this fixture and profile, the digest pipeline is most robust when:
- The event budget is constrained (avoid large budgets).
- Novelty thresholds are moderate or low.
- The optional LLM classifier is disabled.

These findings align with a “minimal evidence” principle: given controlled inputs, smaller evidence sets reduce contradiction risk and stabilize summaries.

## Recommendations (Next Experiments)

1. Repeat the same ablation matrix on `decision-heavy.json` and `noise-heavy.json` fixtures.
2. Compare `DIGEST_NOVELTY_THRESHOLD` at finer increments (0.05, 0.10, 0.15, 0.20).
3. Run a longer profile (`balanced`) to validate that these effects persist under higher load.
4. Track digest latency and consistency separately to isolate trade-offs.

## Notes

These results are specific to the current fixture, profile, and environment. Do not generalize beyond this setup without cross-fixture validation.
