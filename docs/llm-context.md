# LLM Context: Project Memory

## One-Line Summary
Project Memory is an OSS, developer-first long-term memory engine (API + worker + adapters + SDKs), not a consumer assistant app.

## Scope and Boundaries
- Backend-only system (no UI/mobile).
- BYO infra/secrets via env vars.
- Core logic lives in `packages/core` and should remain transport/UI independent.

## Core Capabilities
1. Ingest memory events (`stream` append, `document` upsert by key)
2. Generate layered digests (digest control pipeline)
3. Retrieve memory (latest digest + recent events)
4. Answer from retrieved memory (only if `FEATURE_LLM=true`)
5. Schedule/send reminders

## Key Architecture
- API: `apps/api` (NestJS REST, auth + validation + queue producer)
- Worker: `apps/worker` (BullMQ jobs: digest + rebuild + reminders)
- DB: Postgres + Prisma (`packages/db`)
- Queue: Redis + BullMQ
- Contracts: Zod (`packages/contracts`)
- Prompts: `packages/prompts`
- SDKs: `packages/sdk-client`, `packages/sdk-react`
- Adapters: Telegram (`apps/adapter-telegram`), CLI (`apps/cli`)

## Digest Control Pipeline
The digest flow is controlled and multi-stage:
1. Event selection (dedupe, budgets, latest docs)
2. Delta detection (novelty threshold; always keep decision/constraint)
3. Protected state merge (conservative stable-fact updates)
4. LLM digest generation (structured JSON)
5. Consistency checks + retry
6. Optional rebuild/backfill job for recovery

Important env vars:
- `DIGEST_EVENT_BUDGET_TOTAL`
- `DIGEST_EVENT_BUDGET_DOCS`
- `DIGEST_EVENT_BUDGET_STREAM`
- `DIGEST_NOVELTY_THRESHOLD`
- `DIGEST_MAX_RETRIES`
- `DIGEST_USE_LLM_CLASSIFIER`
- `DIGEST_DEBUG`
- `DIGEST_REBUILD_CHUNK_SIZE`

## Public API Notes
- Identity via headers: `x-user-id` or `x-telegram-user-id`.
- Digest endpoints require `FEATURE_LLM=true`; otherwise return actionable 400.
- Rebuild endpoint exists: `POST /memory/digest/rebuild`.

## Data Concepts
- `ProjectScope`: memory container
- `MemoryEvent`: stream/document memory unit
- `Digest`: compressed memory object (with optional `rebuildGroupId`)
- `Reminder`: scheduled action

## What to Preserve When Making Changes
- Do not break public API contracts unless explicitly requested.
- Keep user scoping for all data access.
- Keep `packages/core` reusable and framework-agnostic.
- Keep digest reliability controls deterministic where intended.

## Known Current Limitations
- Retrieval is heuristic (no vector search yet).
- Internal digest state is derived/reconstructed, not a dedicated persisted state table.

## Good Next Improvements (Optional)
- Add vector retrieval behind existing interfaces.
- Add explicit persisted digest-state snapshots.
- Add stronger drift auditing and replay tooling.
