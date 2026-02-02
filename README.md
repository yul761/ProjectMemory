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
pnpm dev:cli -- pm scopes
```

No-LLM smoke test:
```bash
./scripts/smoke-no-llm.sh
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
