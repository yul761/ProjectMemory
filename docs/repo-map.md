# Repo Map

This repository now has three different kinds of content:

- product runtime code
- research and benchmark tooling
- curated evidence and docs

If you are trying to build on top of StateCore, use this map first.

## Product Runtime

These paths are the product-facing core:

- `apps/api`
  - NestJS API entrypoint
  - runtime turn endpoint
  - inspectable memory endpoints
  - diagnostics endpoints (`/diagnostics/queues`, `/diagnostics/mcp-usage`)
- `apps/worker`
  - BullMQ background jobs
  - Working Memory updates
  - State Layer digest jobs
- `apps/adapter-mcp`
  - MCP server adapter for Claude Code and other MCP clients
  - tools: `save_turn`, `recall`, `list_scopes`
  - scope auto-discovery via `.statecore` file, `STATECORE_SCOPE_NAME` env var, or directory name
  - see `docs/mcp-adapter.md`
- `apps/cli`
  - developer/operator diagnostics
  - `doctor`, `layer-status`, `turn`
- `apps/demo-web`
  - interactive demo shell
  - scope browser, chat UI, and three-layer inspector
- `packages/core`
  - runtime logic
  - Fast Layer / Working Memory / State Layer behavior
- `packages/contracts`
  - request/response schemas
  - stable runtime-facing shapes
- `packages/prompts`
  - runtime, answer, and digest prompt templates
- `packages/db`
  - Prisma schema and migrations

If you are adding a demo app, this is the part of the repo you should build on.
For the shortest path to run the current demo, see `docs/demo-quickstart.md`.

## Local Development

These files configure the local Docker stack:

- `docker-compose.local.yml` — full stack (Postgres, Redis, API, Worker) for local dev
- `Makefile` — shortcuts: `make start`, `make stop`, `make logs`, `make rebuild`, `make clean`
- `start.ps1` — Windows startup script with health check and status widget
- `status.html` — floating status widget (auto-launched by `start.ps1`)

Quick start:

```bash
make start
# or on Windows:
.\start.ps1
```

## Operator Scripts

- `scripts/ingest-docs.ts` — bulk-ingest a folder of markdown/text files into a scope
  - usage: `pnpm ingest:docs --dir <path> --scope <name-or-uuid>`
  - options: `--ext`, `--no-digest`, `--dry-run`, `--token`, `--url`
- `scripts/wake-monitor.ps1` — background process that restores Docker networking after Windows sleep/wake
- `scripts/wake-recovery.ps1` — one-shot recovery script (called by the monitor)

## Research And Benchmarking

These paths exist to validate the system, not to define the main app contract:

- `benchmark-fixtures`
  - reproducible input scenarios
- `benchmark-results`
  - local run output
  - not intended as canonical repo content
- `scripts/benchmark`
  - benchmark runners
  - drift tests
  - visible comparison tooling
- `scripts/ci`
  - readiness scripts
  - CI-style validation passes

These are important for credibility, but a product demo should not depend on
their internal file layout.

## Curated Evidence

These paths are intended for repo readers:

- `artifacts/demos`
  - stable evidence artifacts
  - handpicked examples rather than every local run
- `docs`
  - architecture, API, evaluation, and onboarding docs
- `README.md`
  - primary entrypoint

## Recommended Reading Order

For a new engineer or demo builder:

1. `README.md`
2. `docs/demo-quickstart.md`
3. `docs/start-here.md`
4. `docs/product-surface.md`
5. `docs/api.md`
6. `docs/technical-overview.md`

## Practical Rule

When deciding where code belongs:

- if it serves runtime behavior, put it under `apps/*` or `packages/*`
- if it exists to measure or validate claims, put it under `scripts/benchmark`
  or `scripts/ci`
- if it exists to explain or prove the system to readers, put it under `docs`
  or `artifacts/demos`
