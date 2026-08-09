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
**⚠️ `-f compose.deploy.yml` is not optional.** It is an untracked host override that
publishes core's port 3000 to `127.0.0.1:3002` and `172.17.0.1:3002` (the docker0
bridge). The cloud gateway finds core at `CORE_URL=http://host.docker.internal:3002`,
which resolves to that bridge IP. Recreate the `api` container without this override
and the port binding silently disappears: core stays healthy and logs a clean startup,
the gateway stays up, and **every request through api.statecore.io returns 502**.
Because the file is untracked, `git pull` does not carry it and nothing fails loudly.
This is how prod broke on 2026-08-09 (4h outage) — the command block below used to
omit it, so it is now baked into every line.

```bash
ssh statecore
cd /root/StateCore
git pull origin main

# Define once, so no invocation can drift from another.
DC="docker compose -f docker-compose.prod.yml -f compose.deploy.yml --env-file .env.production"

$DC build
$DC run --rm migrate            # one-shot Prisma migrate; run before `up` on schema changes
$DC up -d api worker
```

**Verify through the gateway, not just core.** Core's own health passing proves
nothing about the path Remi actually uses — that was the gap that let the 502 sit
unnoticed for four hours:
```bash
# on the droplet: core is published where the gateway expects it
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3002/v1/health   # want 200
docker inspect statecore-api-1 --format '{{json .HostConfig.PortBindings}}'  # must NOT be {}

# end-to-end, from the consumer's side (assistant-backend holds the sc_live_ key):
ssh remi "cd /root/assistant-backend && docker compose exec -T api node -e '
  fetch(process.env.STATECORE_BASE_URL + \"/v1/scopes\", {
    headers: { authorization: \"Bearer \" + process.env.STATECORE_API_KEY }
  }).then(r => console.log(r.status))'"                                    # want 200
```

Notes: there's a dedicated one-shot `migrate` service. Compose files:
`docker-compose.prod.yml` (prod), `compose.deploy.yml` (untracked host override — see
warning above), `docker-compose.local.yml` (local).
