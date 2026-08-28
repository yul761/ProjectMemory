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
tsconfig.base.json          Compiler options every package extends
tsconfig.dev.json           Adds paths mapping @statecore/* to source; the dev
                            scripts pass it to tsx via --tsconfig
vitest.shared.ts            Aliases @statecore/* to source for every Vitest run
```

Workspace packages point `main` at `dist`, so a built app starts under plain Node,
and `types` at source, so type-checking needs no build. The last two files above
are how Vitest and `tsx` get source resolution back; `vitest.shared.ts` records
why tsconfig `paths` cannot be used for it.

## Docs

```
docs/start-here.md          Orientation for new contributors
docs/repo-map.md            This file
docs/philosophy.md          What the engine is for, and why auditability is the centre
docs/glossary.md            Vocabulary: facet, pack, supersession, retirement, drop log
docs/api.md                 Full API reference and the /v1 contract rules
docs/vision-and-roadmap.md  Positioning and roadmap (with a status map at the top)
docs/technical-overview.md  Architecture internals
docs/digest-state.md        Digest state specification
docs/protected-state-merge.md  The deterministic merge, field by field
docs/drift-definition.md    Drift definition and metrics
docs/assistant-runtime.md   Assistant runtime specification
docs/provider-abstraction.md   Provider abstraction specification
docs/llm-context.md         Condensed project context for an LLM
docs/benchmarking.md        Benchmark methodology
docs/evaluation-metrics.md  Evaluation metrics specification
docs/evaluation-protocol.md Evaluation protocol
docs/longmemeval.md         Published LongMemEval results vs mem0 OSS
docs/team-memory.md         One shared deployment as the team's agent memory
docs/runtime-profile-ablation-guide.md  Runtime profile ablations
docs/research-overview.md   Research framing
docs/research-questions.md  Open research questions
docs/audit/                 Dated design audits — historical records, not current state
docs/superpowers/           Dated specs and plans — historical records, not current state
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
