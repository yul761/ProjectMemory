# Repo Map

StateCore is organized around a focused memory runtime: an HTTP API, background workers, and shared packages. There are no demo apps, adapters, or CLIs in this repo.

## Apps

```
apps/api        NestJS HTTP server
                - /v1 public API subset (OpenAPI at GET /openapi.json, Scalar UI at /docs)
                - ingestion, retrieval, runtime turns
                - diagnostics endpoints (/diagnostics/queues)

apps/worker     BullMQ background workers
                - Working Memory updates
                - State Layer digest jobs
                - daily reminder job
```

## Packages

```
packages/core       Memory engine logic
                    - MemoryService, DigestService, RetrieveService, AssistantSession
                    - Fast Layer / Working Memory / State Layer behavior
                    - synthetic memory quality eval suite

packages/contracts  Request/response schemas (Zod)
                    - stable runtime-facing shapes
                    - shared between API and worker

packages/prompts    LLM prompt templates
                    - runtime, answer, and digest prompts

packages/db         Prisma schema, migrations, and generated client
```

## Scripts and Tooling

```
scripts/benchmark/      Benchmark runners (latency, visible comparison, trend)
scripts/ci/             CI readiness scripts
scripts/format/         Code formatting helpers
scripts/release/        Release verification
scripts/ingest-docs.ts  Bulk-ingest markdown/text files into a scope
                        Usage: pnpm ingest:docs --dir <path> --scope <name-or-uuid>
```

## Infrastructure

```
docker-compose.local.yml    Local dev stack (Postgres with pgvector, Redis)
docker-compose.prod.yml     Production stack
Makefile                    Shortcuts: make start, make stop, make logs, make rebuild
```

## Docs

```
docs/start-here.md          Orientation for new contributors
docs/repo-map.md            This file
docs/api.md                 Full API reference
docs/vision-and-roadmap.md  Design philosophy and roadmap
docs/technical-overview.md  Architecture internals
docs/digest-state.md        Digest state specification
docs/drift-definition.md    Drift definition and metrics
docs/benchmarking.md        Benchmark methodology
docs/evaluation-metrics.md  Evaluation metrics specification
docs/assistant-runtime.md   Assistant runtime specification
docs/provider-abstraction.md Provider abstraction specification
```

## Where Code Belongs

- Runtime behavior: `apps/*` or `packages/*`
- Measurement and validation: `scripts/benchmark` or `scripts/ci`
- Explanation and evidence for readers: `docs` or `artifacts/demos`

## Recommended Reading Order

For a new contributor:

1. `README.md`
2. `docs/start-here.md`
3. `docs/api.md`
4. `docs/technical-overview.md`
5. `docs/vision-and-roadmap.md`
