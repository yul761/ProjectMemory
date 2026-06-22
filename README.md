# StateCore

[![CI](https://github.com/yul761/StateCore/actions/workflows/ci.yml/badge.svg)](https://github.com/yul761/StateCore/actions/workflows/ci.yml)
[![Integration Smoke](https://github.com/yul761/StateCore/actions/workflows/integration-smoke.yml/badge.svg)](https://github.com/yul761/StateCore/actions/workflows/integration-smoke.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

StateCore is a self-hosted, low-drift long-term memory runtime for AI systems using local or BYO models. It turns memory from accumulated text into controlled state: events are ingested, run through a digest control pipeline, merged into protected stable state, and retrieved with grounded evidence — all over a stable HTTP API you can deploy yourself.

## Features

- **Event store** — ingest stream events and keyed documents into per-scope memory
- **Digest pipeline** — background worker consolidates events into stable state through selection, merge, consistency checks, and retry
- **Protected state** — goals, constraints, decisions, and todos are gated by a consistency gate; the LLM proposes, the pipeline enforces
- **Retrieval** — hybrid keyword + optional pgvector semantic search over events and digests
- **Reminders** — daily reminder job surfaces follow-up items from active scopes
- **Benchmarks** — built-in synthetic memory quality suite (fact retention, goal stability, decision continuity, retrieval MRR)

## Quickstart

### 1. Install dependencies

```bash
pnpm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Minimum required variables:

```
PORT=3002
LOCAL_USER_TOKEN=local-dev-user
DATABASE_URL=postgresql://postgres:postgres@localhost:5434/statecore
REDIS_URL=redis://localhost:6380
```

To enable LLM features (digest, answers):

```
FEATURE_LLM=true
MODEL_PROVIDER=openai-compatible
MODEL_API_KEY=<your-key>
MODEL_BASE_URL=https://api.openai.com/v1
MODEL_NAME=gpt-4o-mini
```

### 3. Start infrastructure

```bash
docker compose -f docker-compose.local.yml up -d
```

This starts Postgres (with pgvector) and Redis.

### 4. Prepare the database

```bash
pnpm db:generate
pnpm db:migrate
pnpm seed
```

### 5. Start the services

```bash
pnpm dev:api      # NestJS API on PORT (default 3002)
pnpm dev:worker   # background digest + reminder workers
```

The API is available at `http://localhost:3002` (or whatever `PORT` is set to).

## API

### Authentication

All requests require an `x-user-id` header. For local development, set `LOCAL_USER_TOKEN=local-dev-user` in `.env` and send:

```
x-user-id: local-dev-user
```

### Public surface (`/v1`)

The `/v1` prefix exposes the stable, public-facing subset of the API. Full OpenAPI schema:

```
GET /openapi.json
```

Interactive Scalar UI:

```
http://localhost:3002/docs
```

Reference documentation: `docs/api.md`

### Key endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/memory/events` | Ingest a stream event or document |
| `POST` | `/v1/memory/retrieve` | Retrieve grounded evidence for a query |
| `POST` | `/v1/memory/digest` | Trigger a State Layer digest job |
| `GET` | `/v1/scopes` | List scopes |
| `GET` | `/v1/memory/stable-state` | Current stable-state snapshot |
| `GET` | `/v1/memory/working-state` | Current working-memory snapshot |
| `GET` | `/v1/memory/layer-status` | Aggregated layer health |

## Architecture

```
apps/api        NestJS HTTP server — ingestion, retrieval, runtime turns, diagnostics
apps/worker     BullMQ background workers — digest, working-memory updates, reminders

packages/core       Memory engine (MemoryService, DigestService, RetrieveService, AssistantSession)
packages/contracts  Zod schemas for all API I/O
packages/db         Prisma schema, migrations, and client
packages/prompts    LLM prompt templates (digest, answer, runtime)
```

StateCore sits between your client and your model endpoint. Events flow in, the digest pipeline consolidates them into protected state, and retrieval pulls grounded evidence back out for answers or runtime turns.

Three-layer memory model:

- **Fast Layer** — synchronous; assembles prompt context for the current turn from recent events, working memory, and stable state
- **Working Memory** — lightweight, quickly-updated structured memory; bridges raw recent turns and slow stable-state consolidation
- **State Layer** — authoritative, replayable, low-drift long-term memory; updated asynchronously through the digest control pipeline

See `docs/vision-and-roadmap.md` for the layered model design and roadmap.

## Testing and Benchmarks

Run package tests:

```bash
pnpm --filter @statecore/core test
pnpm --filter @statecore/api test
```

Run the full latency + memory quality benchmark:

```bash
pnpm benchmark
```

Run the synthetic memory quality evaluation (no LLM required):

```bash
pnpm --filter @statecore/core eval
```

Benchmark methodology: `docs/benchmarking.md`

## Documentation

- `docs/start-here.md` — orientation for new contributors
- `docs/repo-map.md` — repo structure and where code belongs
- `docs/api.md` — full API reference
- `docs/vision-and-roadmap.md` — design philosophy and roadmap
- `docs/technical-overview.md` — architecture internals
- `docs/digest-state.md` — digest state specification
- `docs/drift-definition.md` — drift definition and metrics
- `docs/benchmarking.md` — benchmark methodology
- `docs/evaluation-metrics.md` — evaluation metrics specification

## Contributing

1. Fork the repo and create a feature branch.
2. Run `pnpm lint` and `pnpm --filter @statecore/core test` before opening a PR.
3. Follow [Conventional Commits](https://www.conventionalcommits.org/).

## License

MIT — see [LICENSE](LICENSE).
