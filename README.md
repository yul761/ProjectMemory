# Project Memory

An open-source **long-term memory engine** for developers. It provides primitives to ingest events, produce layered digests, retrieve memory, and (optionally) answer questions grounded in that memory.

This is **not** a consumer assistant app. You bring your own infrastructure and secrets via environment variables.

## Quickstart in 5 minutes

1) **Start infra**
```bash
cd project-memory
docker-compose up -d
```
This starts Postgres + Redis only.

2) **Install deps**
```bash
pnpm install
```

3) **Set env**
```bash
cp .env.example .env
```
Apps will auto-load the repo root `.env` on startup.
You can override per app by creating `apps/<app>/.env` (for example `apps/worker/.env`).

4) **DB migrate + seed**
```bash
pnpm db:generate
pnpm db:migrate
pnpm seed
```

5) **Run services**
```bash
pnpm dev:api
pnpm dev:worker
pnpm dev:telegram
```

Optional CLI:
```bash
pnpm dev:cli -- scopes
```

No-LLM smoke test:
```bash
./scripts/smoke-no-llm.sh
```

LLM smoke test:
```bash
FEATURE_LLM=true OPENAI_API_KEY=... ./scripts/smoke-llm.sh
```

Reminder smoke test:
```bash
./scripts/smoke-reminders.sh
```

All smoke tests:
```bash
pnpm smoke
```

Core unit tests (digest control layer):
```bash
pnpm --filter @project-memory/core test
```

Benchmark (performance + reliability score):
```bash
pnpm benchmark
```

## Config matrix

Required for all:
- `DATABASE_URL`, `REDIS_URL`

API (`apps/api`):
- `PORT`, `LOCAL_USER_TOKEN` (dev)
- Optional LLM: `FEATURE_LLM=true` + `OPENAI_*`

Worker (`apps/worker`):
- `FEATURE_LLM=true` + `OPENAI_*` for digests
- Optional Telegram reminder delivery: `FEATURE_TELEGRAM=true` + `TELEGRAM_BOT_TOKEN`
- Digest control vars:
  - `DIGEST_EVENT_BUDGET_TOTAL`, `DIGEST_EVENT_BUDGET_DOCS`, `DIGEST_EVENT_BUDGET_STREAM`
  - `DIGEST_NOVELTY_THRESHOLD`, `DIGEST_MAX_RETRIES`
  - `DIGEST_USE_LLM_CLASSIFIER`, `DIGEST_DEBUG`, `DIGEST_REBUILD_CHUNK_SIZE`

Telegram adapter (`apps/adapter-telegram`):
- `FEATURE_TELEGRAM=true`
- `TELEGRAM_BOT_TOKEN`, `PUBLIC_BASE_URL`, `TELEGRAM_WEBHOOK_PATH`, `API_BASE_URL`
- `ADAPTER_PORT` (optional)

CLI (`apps/cli`):
- `API_BASE_URL`

## Telegram webhook setup

Set `PUBLIC_BASE_URL` and call the adapter:
```bash
curl -X POST "http://localhost:3001/telegram/webhook/set"
```

## SDK usage (chat app integration)
```ts
import { ProjectMemoryClient } from "@projectmemory/client";

const client = new ProjectMemoryClient({ baseUrl: process.env.API_BASE_URL!, userId: "dev-user" });
const scope = await client.createScope({ name: "Chat App" });
await client.ingestEvent({ scopeId: scope.id, type: "stream", source: "sdk", content: "User asked about pricing" });
```

## SDK usage (note app integration)
```ts
await client.ingestEvent({
  scopeId: scope.id,
  type: "document",
  source: "sdk",
  key: "note:roadmap",
  content: "Updated roadmap draft"
});
```

## FEATURE_LLM
Set `FEATURE_LLM=true` and provide `OPENAI_API_KEY` to enable `/memory/answer` and digest jobs. If disabled, the API returns a clear error and worker jobs fail fast.

## Digest Control Layer
Digest is processed as a controlled pipeline (not a single LLM call):
- Event selection with dedupe and per-type budgets
- Delta detection with novelty threshold
- Protected deterministic state merge for stable facts
- LLM stage with strict JSON schema
- Consistency checks + retry (`DIGEST_MAX_RETRIES`)
- Rebuild/backfill endpoint: `POST /memory/digest/rebuild`

## Workflow Diagram
```mermaid
flowchart LR
  U[Adapter / CLI / SDK] --> A[API]
  A --> DB[(Postgres)]
  A --> Q[(Redis Queue)]
  Q --> W[Worker]
  W --> LLM[OpenAI-compatible LLM]
  W --> DB
  A --> U
```

## How It Works (Technical)
- API validates input with shared Zod contracts and scopes all requests by user identity.
- Core engine (`packages/core`) performs selection/delta/state/consistency logic.
- Worker executes digest and rebuild jobs asynchronously via BullMQ.
- Digests are stored as first-class records, with optional `rebuildGroupId` for backfills.
- SDK and adapters call API only (no direct database coupling).

## Evidence-Based Performance Claims
Use the built-in benchmark runner to generate reproducible metrics and a score report:

- Ingest throughput + p95 latency
- Retrieve hit-rate + p95 latency
- Digest success/consistency/latency (when `FEATURE_LLM=true`)
- Reminder due-to-sent delay

Run:
```bash
pnpm benchmark
```

Reports are generated in `benchmark-results/` as JSON + Markdown.

## Troubleshooting
- Prisma runs from `packages/db`, so copy `.env` to `packages/db/.env` before `pnpm db:migrate`.
- If API or worker says `FEATURE_LLM disabled` but `.env` is set, restart the process after updating `.env`.
- Ensure Postgres port mapping matches `DATABASE_URL` (e.g. `5433:5432` in `docker-compose.yml`).
- Reminder smoke test depends on the worker’s 60s scheduler; keep the worker running and allow ~1–2 minutes.
- Digest and rebuild endpoints require `FEATURE_LLM=true`; otherwise API returns an actionable 400 message.

## Repo structure
- `apps/api` NestJS REST API
- `apps/worker` BullMQ workers
- `apps/adapter-telegram` Telegram reference adapter
- `apps/cli` Developer CLI
- `packages/core` domain services + pipelines
- `packages/contracts` Zod schemas + shared enums
- `packages/prompts` prompt templates
- `packages/sdk-client` `@projectmemory/client`
- `packages/sdk-react` `@projectmemory/react` (hooks only)
- `packages/db` Prisma schema + client

See `docs/api.md` for endpoint details.
See `docs/glossary.md` for term definitions.
See `docs/technical-overview.md` for architecture and pipeline internals.
See `docs/benchmarking.md` for benchmark methodology and scoring.
