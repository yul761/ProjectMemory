# StateCore — Claude Context

## What this is
StateCore is an AI memory management system. It stores memory events, runs digest workers to build stable state, and serves a REST API for ingestion and recall.

It is the **Layer 1 engine** of the `StateCore-App` stack (see `../CLAUDE.md`): open-source
(MIT), self-hostable, and fronted by `../statecore-cloud` (managed gateway) which
`../assistant-backend` uses as its memory store. Tech: **pnpm + Turbo monorepo**
(`apps/*`, `packages/*`), TypeScript, Node ≥20, NestJS, Prisma/Postgres+pgvector,
BullMQ/Redis, Zod, Vitest, Changesets.

## Commands
```bash
pnpm install
pnpm dev:api          # API only (port 3002)
pnpm dev:worker       # background workers (digest, working memory, reminders)
pnpm dev:lite         # = dev:api
pnpm test:core        # Vitest suite for @statecore/core
pnpm lint             # tsc --noEmit across apps + packages
pnpm build            # build all apps + packages
pnpm changeset        # add a changeset (releases via Changesets)
pnpm benchmark        # synthetic memory-quality benchmark suite
```

## Running locally
- API: `http://localhost:3002` (set in `.env`: `PORT=3002`)
- Auth: `x-user-id: local-dev-user` header (token set in `.env`: `LOCAL_USER_TOKEN=local-dev-user`)
- Start: `pnpm start` or see `start.ps1`

### Enable semantic retrieval (optional)
Add to `.env`:
```
MODEL_EMBEDDING_NAME=text-embedding-3-small
RETRIEVE_USE_EMBEDDINGS=true
```
Uses the same API key as the LLM. Restart the API container after changing. Health endpoint shows `"retrieve":{"useEmbeddings":true}` when active.

## StateCore Memory API (key endpoints)

### Ingest a document
```
POST /memory/events
x-user-id: local-dev-user
{ "scopeId": "<uuid>", "type": "document", "source": "api", "key": "<unique-slug>", "content": "<text>" }
```
- `type: "document"` = long-form, keyed, upsertable by key
- `type: "stream"` = short ephemeral facts/events

### List scopes
```
GET /scopes
x-user-id: local-dev-user
```
Returns array of `{ id, name }`.

### Trigger digest (LLM summarization)
```
POST /memory/digest
x-user-id: local-dev-user
{ "scopeId": "<uuid>" }
```

### Retrieve memory
```
POST /memory/retrieve
{ "scopeId": "<uuid>", "query": "...", "limit": 20 }
```

## Bulk document ingest script
To ingest an entire folder of markdown files into a scope:
```
pnpm ingest:docs --dir "C:\path\to\docs" --scope "scope-name-or-uuid"
```
Options:
- `--token <token>` — override auth token (default: local-dev-user)
- `--url <url>` — override API base URL (default: http://localhost:3002)
- `--ext .md,.txt` — file extensions to include (default: .md)
- `--no-digest` — skip digest trigger after ingestion
- `--dry-run` — preview without sending

Script: `scripts/ingest-docs.ts`

## Scopes
Scopes are per-user and dynamic — do not hardcode a list here. List the current
user's scopes via `GET /scopes` (auth header `x-user-id`).

## Architecture quick-ref
- `apps/api` (`@statecore/api`) — NestJS HTTP server, port 3002; serves the stable `/v1` API
- `apps/worker` (`@statecore/worker`) — BullMQ background workers (digest, working memory, reminders)
- `packages/core` — MemoryService, DigestService, RetrieveService, AnswerService, AssistantSession, digest-control pipeline
- `packages/db` — Prisma schema, migrations, client (Postgres + pgvector)
- `packages/contracts` — Zod schemas for all API I/O
- `packages/prompts` — LLM prompt templates (digest, answer, runtime)

## Key files
- `apps/api/src/memory.controller.ts` — all memory endpoints
- `apps/api/src/domain.service.ts` — service orchestration
- `apps/api/src/auth.middleware.ts` — x-user-id / x-telegram-user-id auth
- `packages/core/src/index.ts` — MemoryService, DigestService, AnswerService exports

## Deploy (droplet `statecore` → api.statecore.io)
Git-pull based, from a checkout at `/root/StateCore` on the `statecore` droplet
(137.184.45.203). That host runs **both** the core stack (`statecore-api`,
`statecore-worker`, `statecore-postgres` [pgvector], `statecore-redis`) **and** the
statecore-cloud stack (gateway/console/docs/caddy) — the cloud gateway proxies to core
over the docker bridge. Source of truth: `deploy.md`.
```bash
ssh statecore
cd /root/StateCore
git pull origin main
docker compose -f docker-compose.prod.yml --env-file .env.production build
docker compose -f docker-compose.prod.yml --env-file .env.production run --rm migrate   # one-shot Prisma migrate
docker compose -f docker-compose.prod.yml --env-file .env.production up -d api worker
```
Notes: there's a dedicated one-shot `migrate` service (run it before `up` on schema
changes). The live stack was brought up with an extra override
(`-f docker-compose.prod.yml -f compose.deploy.yml`); keep that override if you rebuild
the whole stack. Compose files: `docker-compose.prod.yml` (prod), `compose.deploy.yml`
(host override), `docker-compose.local.yml` (local).
