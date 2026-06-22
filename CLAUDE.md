# StateCore — Claude Context

## What this is
StateCore is an AI memory management system. It stores memory events, runs digest workers to build stable state, and serves a REST API for ingestion and recall.

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
- `apps/api` — NestJS HTTP server, port 3002
- `apps/worker` — Celery-style background workers (digest, working memory)
- `packages/core` — MemoryService, DigestService, RetrieveService, AssistantSession
- `packages/db` — Prisma client
- `packages/contracts` — Zod schemas for all API I/O
- `packages/prompts` — LLM prompt templates

## Key files
- `apps/api/src/memory.controller.ts` — all memory endpoints
- `apps/api/src/domain.service.ts` — service orchestration
- `apps/api/src/auth.middleware.ts` — x-user-id / x-telegram-user-id auth
- `packages/core/src/index.ts` — MemoryService, DigestService, AnswerService exports
