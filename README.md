# StateCore

[![CI](https://github.com/yul761/StateCore/actions/workflows/ci.yml/badge.svg)](https://github.com/yul761/StateCore/actions/workflows/ci.yml)
[![Integration Smoke](https://github.com/yul761/StateCore/actions/workflows/integration-smoke.yml/badge.svg)](https://github.com/yul761/StateCore/actions/workflows/integration-smoke.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

StateCore is a self-hosted, low-drift long-term memory runtime for AI systems using local or BYO models. It turns memory from accumulated text into controlled state: events are ingested, run through a digest control pipeline, merged into protected stable state, and retrieved with grounded evidence — all over a stable HTTP API you can deploy yourself.

## Features

- **Event store** — ingest stream events and keyed documents into per-scope memory
- **Digest pipeline** — background worker consolidates events into stable state through selection, merge, consistency checks, and retry
- **Protected state** — goals, constraints, decisions, and todos are gated by a consistency gate; the LLM proposes, the pipeline enforces
- **Auditable facts** — every fact carries its evidence and its supersession chain, and a fact that leaves the active set is retired rather than deleted, so "why do you believe this, and what did you believe before" stays answerable
- **Recorded discards** — the digest logs what it dropped and why, against a fixed set of reasons; losing information is survivable, losing it silently is not
- **Replaceable ontology** — facets come from a pack resolved per tenant and scope, so the engine stores, protects and supersedes without knowing what a facet means
- **Retrieval** — hybrid keyword + optional pgvector semantic search over events and digests, packed into a caller-declared character budget that reports what it refused
- **Reminders** — daily reminder job surfaces follow-up items from active scopes
- **Benchmarks** — built-in synthetic memory quality suite (fact retention, goal stability, decision continuity, retrieval MRR), plus a published LongMemEval comparison

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
MODEL_NAME=gpt-5-mini
```

> **On OpenAI, pick a model that accepts `reasoning_effort`.** The runtime turn
> sends it on every request — `assistant-runtime.ts` defaults it to `low` rather
> than leaving it unset — so `POST /v1/memory/runtime/turn` fails against a
> `gpt-4o*` model, which rejects the parameter. Digest and answers do not send it
> unless `MODEL_STRUCTURED_OUTPUT_REASONING_EFFORT` is set, so a `gpt-4o*` model
> appears to work right up until the first runtime turn. Any endpoint that
> accepts the parameter, or ignores unknown ones, is fine.

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
| `POST` | `/v1/memory/retrieve` | Retrieve grounded evidence for a query, within an optional `maxChars` budget |
| `POST` | `/v1/memory/digest` | Trigger a State Layer digest job |
| `GET` | `/v1/memory/facts` | Grouped memory facts for a scope |
| `GET` | `/v1/memory/facts/:factId/provenance` | A fact's evidence and its full version chain |
| `GET` | `/v1/memory/digests/:digestId/selection` | What a digest kept, and what it discarded and why |
| `GET` | `/v1/facet-pack` | The active facet ontology for a scope or account |
| `GET` | `/v1/scopes` | List scopes |
| `GET` | `/memory/stable-state` | Current stable-state snapshot ¹ |
| `GET` | `/memory/working-state` | Current working-memory snapshot ¹ |
| `GET` | `/memory/layer-status` | Aggregated layer health ¹ |

The three audit readers in the middle are the ones that make the engine's memory
checkable rather than merely stored; `docs/api.md` lists the full frozen surface.

> **API stability:** the `/v1` contract is frozen and additive-only — see
> [STABILITY.md](STABILITY.md). It currently covers **21 operations across 19
> paths**. The contract carries its own version in the generated OpenAPI document
> (`info.version`, currently `1.5.0`), which is what tells you how current a spec
> you are holding; it is not the release tag and not any package version.

¹ Internal read-model endpoints — registered only at `/memory/...`, not under `/v1`, and not part of the frozen `/v1` contract.

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

### LongMemEval

Compared against mem0 OSS on
[LongMemEval](https://github.com/xiaowu0162/LongMemEval) at an **equal context
budget** — the same number of characters of memory in the answerer's prompt,
rather than the same number of retrieved items. 194 questions, `gpt-5` answering,
the official `gpt-4o` judge (2026-08-08):

| system | 4,000 tok | 16,000 tok | 64,000 tok |
|---|---|---|---|
| **StateCore** | 51.0% ±7.0 | **80.9% ±5.5** | **87.6% ±4.6** |
| mem0 OSS | **61.3% ±6.9** | 59.8% ±6.9 | 61.3% ±6.9 |
| No memory (recency window) | 9.3% ±4.1 | 22.7% ±5.9 | 53.6% ±7.0 |

At 64k, StateCore also beats the **70.1% ±6.4** ceiling of pasting the entire
corpus into the prompt with no memory layer at all. At 4k it loses to mem0 by 10
points — a real difference in kind, explained rather than closed, in the full
write-up.

Numbers, caveats and what the benchmark does *not* measure:
[`docs/longmemeval.md`](docs/longmemeval.md). Harness, raw retrievals and
per-question judge verdicts:
[memory-budget-bench](https://github.com/yul761/memory-budget-bench).

## Documentation

- `docs/start-here.md` — orientation for new contributors
- `docs/repo-map.md` — repo structure and where code belongs
- `docs/api.md` — full API reference
- `docs/vision-and-roadmap.md` — design philosophy and roadmap
- `docs/technical-overview.md` — architecture internals
- `docs/digest-state.md` — digest state specification
- `docs/drift-definition.md` — drift definition and metrics
- `docs/benchmarking.md` — benchmark methodology
- `docs/longmemeval.md` — LongMemEval results vs mem0 OSS
- `docs/evaluation-metrics.md` — evaluation metrics specification

## Contributing

1. Fork the repo and create a feature branch.
2. Run `pnpm lint` and `pnpm --filter @statecore/core test` before opening a PR.
3. Follow [Conventional Commits](https://www.conventionalcommits.org/).

## License

MIT — see [LICENSE](LICENSE).
