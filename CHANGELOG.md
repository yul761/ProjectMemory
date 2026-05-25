# Changelog

All notable changes to this project are documented in this file.

The format loosely follows Keep a Changelog and Semantic Versioning.

## [Unreleased]

### Added
- `apps/adapter-mcp`: `list_scopes` tool — discover all available scopes before cross-scope recall.
- `apps/adapter-mcp`: `recall` now accepts optional `scopeId` parameter for querying any scope, not just the current project scope.
- `apps/adapter-mcp`: scope resolution from `.statecore` project file or `STATECORE_SCOPE_NAME` env var, with directory-name fallback.
- `apps/adapter-mcp`: `save_turn` now uses `/memory/runtime/turn` endpoint for richer digest handling.
- `GET /diagnostics/queues` — active/waiting/failed counts for digest and workingMemory queues.
- `GET /diagnostics/mcp-usage` — today's MCP tool call counts from JSONL usage log.
- `docker-compose.local.yml` — full local Docker stack (Postgres 16, Redis 7, API, Worker).
- `Makefile` — local dev shortcuts (`start`, `stop`, `logs`, `rebuild`, `clean`).
- `start.ps1` — Windows startup script with health polling and status widget auto-launch.
- `status.html` — floating real-time status widget.
- `scripts/ingest-docs.ts` — bulk-ingest a folder of markdown/text files into a scope (`pnpm ingest:docs`).
- `scripts/wake-monitor.ps1` / `wake-recovery.ps1` — Windows background monitor that restores Docker networking after sleep/wake.
- `CLAUDE.md` — Claude Code project context for this repo.

### Fixed
- `apps/api/src/auth.middleware.ts`: health check bypass now uses `originalUrl` to correctly match `/health`.
- `Dockerfile`: now copies `apps/adapter-mcp/package.json` in the dependency-install stage.

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
