# Start Here

If you are opening this repository for the first time, use this order instead of reading every doc.

## What Is StateCore

StateCore is a self-hosted memory runtime. It ingests events, consolidates them into protected stable state through a digest control pipeline, and retrieves grounded evidence for AI runtime turns. The goal is low-drift, replayable long-term memory.

For the design philosophy and roadmap, see `docs/vision-and-roadmap.md`.

## Get It Running

```bash
# 1. Install dependencies
pnpm install

# 2. Copy and edit environment config
cp .env.example .env
#    Set PORT, LOCAL_USER_TOKEN, DATABASE_URL, REDIS_URL
#    Set FEATURE_LLM=true + MODEL_* to enable digest and answers

# 3. Start infrastructure (Postgres + Redis)
docker compose -f docker-compose.local.yml up -d

# 4. Prepare the database
pnpm db:generate
pnpm db:migrate
pnpm seed

# 5. Start the runtime
pnpm dev:api
pnpm dev:worker
```

The API is available at `http://localhost:3002` (or your `PORT`). Browse the interactive API docs at `http://localhost:3002/docs`.

## Explore the API

All requests require `x-user-id: local-dev-user` (matches `LOCAL_USER_TOKEN` in `.env`).

The `/v1` prefix is the stable public subset. Full OpenAPI schema:

```
GET /openapi.json
```

Reference: `docs/api.md`

## Run Tests and Benchmarks

```bash
# Package tests
pnpm --filter @statecore/core test
pnpm --filter @statecore/api test

# Synthetic memory quality eval (no LLM required)
pnpm --filter @statecore/core eval

# Full latency + memory benchmark
pnpm benchmark

# Smoke tests (no LLM)
pnpm smoke:no-llm

# Runtime smoke (requires running API + worker with FEATURE_LLM=true)
pnpm smoke:runtime
```

## Repo Structure

See `docs/repo-map.md` for the full map. The short version:

```
apps/api        HTTP server (NestJS)
apps/worker     Background workers (BullMQ)
packages/core   Memory engine logic
packages/contracts  Zod schemas
packages/db     Prisma schema and client
packages/prompts    LLM prompt templates
```

## Further Reading

- `docs/repo-map.md` — full repo structure
- `docs/api.md` — API reference
- `docs/technical-overview.md` — architecture internals
- `docs/digest-state.md` — digest state specification
- `docs/drift-definition.md` — drift definition and metrics
- `docs/benchmarking.md` — benchmark methodology
- `docs/vision-and-roadmap.md` — design philosophy and roadmap
