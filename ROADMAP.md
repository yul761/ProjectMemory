# Roadmap

The canonical product direction now lives in [`docs/vision-and-roadmap.md`](docs/vision-and-roadmap.md).

StateCore is an open-source runtime core; a commercial product stack (hosted
version, GPT-API layer, app) is built on top via the frozen `/v1` API — see the
"Layered Model" section in `docs/vision-and-roadmap.md`.

## Current Priority Order

1. Stabilize the low-drift digest core.
2. Make retention, drift, grounding, and replay measurable.
3. Expose the system as a developer-friendly assistant memory runtime.
4. Add provider abstraction and local model friendliness.
5. Improve retrieval without sacrificing evidence and stability.

## Contribution Priorities

If you want to contribute today, the highest-leverage areas are:

1. Drift definitions, consistency checks, and digest failure analysis.
2. Protected state evolution and `DigestState` structure.
3. Benchmark fixtures, ablations, and reproducible evaluation.
4. Assistant runtime boundaries and reference integrations.
