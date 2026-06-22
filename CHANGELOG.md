# Changelog

All notable changes to this project are documented in this file.

The format loosely follows Keep a Changelog and Semantic Versioning.

## [1.1.0] - 2026-06-22

Freeze-readiness release. The `/v1` API is now frozen — see STABILITY.md. This
release is additive + internal hardening only; the `/v1` contract is unchanged
since 1.0.0.

### Changed / Removed
- Trimmed the runtime to `apps/api` + `apps/worker` + `packages/*`. Removed the
  peripheral apps (demo-web, adapter-telegram, cli, adapter-mcp) and demo-only
  code paths.
- Removed the in-process rate limiter — rate limiting now belongs to the hosting
  gateway/reverse proxy (the open core no longer rate-limits in-process). `429`
  was never part of the `/v1` contract.

### Added
- Drift-control robustness: property-based (fast-check) + adversarial regression
  tests over the digest-control pure functions; deterministic `idFactory`/`nowFactory`.
- Multi-instance safety: `rebuild_digest_chain` now runs under the distributed
  digest-lock; the periodic maintenance tasks run as cluster-safe BullMQ repeatable
  jobs; the runtime recall caches are bounded (`BoundedTtlCache`).
- pgvector **HNSW index** on embeddings, with the vector query aligned to the
  cosine operator so the index is used at scale.
- Per-stage latency logs for retrieve and digest (`retrieveTimings`/`digestTimings`).
- Request body size limit (`MAX_REQUEST_BODY_BYTES`, default 1 MB) with clean
  413 (too large) / 400 (malformed JSON) responses.
- Daily data-lifecycle GC (`data_gc`): prunes old digest/snapshot history (always
  keeping the latest per scope), old job logs, and terminal reminders.
- `examples/quickstart.sh` — a runnable `/v1` worked example.
- `STABILITY.md` — the `/v1` freeze + stability policy.

### Fixed
- `consistencyCheck` no longer false-flags `goal_contradiction` when a summary
  appends prose after the goal.
- digest + state snapshot are now written atomically in a transaction.

## [1.0.0] - 2026-03-18

### Added
- Assistant runtime turn flow with policy profiles, overrides, structured evidence, and grounded answer evidence.
- Provider-neutral model configuration with role-specific chat, structured-output, and embedding endpoints.
- Configurable model timeout support via `MODEL_TIMEOUT_MS` for slower digest and benchmark workloads.
- Replay consistency analysis with transition taxonomy and confidence-aware state diffs.
- Working-note continuity benchmarking, including open-question and risk retention / intrusion metrics.
- Release verification command (`pnpm release:verify`) and v1.0.0 release notes draft.

### Improved
- Protected-state evolution for goals, constraints, decisions, todos, questions, risks, and volatile context.
- Durable numbered decision and todo retention across digest selection, state merge, and drift evaluation.
- Long-term memory reliability scoring with replay stability, grounded response quality, and state-confidence signals.
- Benchmark, ablation, trend, and research-report outputs for working-note continuity and replay explainability.

### Docs
- Vision, drift, digest state, assistant runtime, evaluation, provider abstraction, and benchmarking docs now reflect the memory-first 1.0.0 positioning.

## [0.1.0] - 2026-02-04

### Added
- Benchmark suite and comparison reporting (`benchmark-results/compare-all.md`).
- Digest control pipeline (selection, delta detection, state protection, consistency checks, retries).
- Digest rebuild endpoint and worker flow.
- OSS governance docs (`CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`).
- GitHub templates and CI workflow.

### Improved
- Query-aware retrieve ranking and answer grounding.
- Benchmark retrieve scoring with semantic + strict hit rates.

### Docs
- Expanded technical and benchmarking docs.
