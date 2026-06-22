# W3 — Quality & Observability Hardening — Design

Date: 2026-06-21
Status: Approved (brainstorming) → ready for implementation planning
Parent: `docs/superpowers/specs/2026-06-21-statecore-core-readiness-design.md` (W3)

## Context

W3 of StateCore Core Readiness. Core internals are well-tested and the benchmark
/ drift suite is healthy, but there are observability and coverage gaps within
the core scope (`packages/*`, `apps/api`, `apps/worker`):

- Invalid request bodies return **HTTP 500**, not 400: controllers call Zod
  `.parse()` directly, and `GlobalErrorFilter` (`apps/api/src/error.filter.ts`)
  maps every non-`HttpException` (including `ZodError`) to 500. The filter also
  logs **nothing**.
- Background queue failures are **silently swallowed**: `memory.controller.ts`
  does `embedQueue.add(...).catch(() => {})` / `classifyQueue.add(...).catch(() => {})`.
- Two core files are **untested**: `packages/core/src/model-provider.ts` and
  `packages/core/src/working-memory.service.ts`.
- A few W2 follow-ups left small test/quality gaps.

A `pino` logger already exists and is exported from `@statecore/core` (`logger`);
the worker uses it, but `apps/api` does not.

## Goals

1. Invalid request bodies return 400 with structured detail.
2. Unexpected (500) errors and background-queue failures are logged, not
   swallowed.
3. The two untested core files have unit tests.
4. The W2 test/quality follow-ups are cleaned up.
5. The "partial" loose ends (fact-registry, integration tests) are verified and
   their boundary documented — without expanding scope.

## Decisions (from brainstorming)

- **ZodError → 400 in `GlobalErrorFilter`** (not a global ValidationPipe). The
  controllers keep their manual `.parse()` pattern; a single `ZodError` branch in
  the filter fixes every endpoint at once with minimal change.
- **Scope: core + the W2 test tail.** Do the error-handling/observability/two-
  untested-files core, plus fold in the W2 follow-ups (retrieve test assertion,
  `/v1`-exclusion coverage, reminders `parseOutput`). Do NOT deep-dive
  fact-registry / integration-test "partial" items — verify and document only.

## Components

### 1. `apps/api/src/error.filter.ts` — `GlobalErrorFilter`

- Add a branch: `exception instanceof ZodError` → HTTP 400, body
  `{ error: "Validation failed", details: exception.issues }`.
- Keep the `HttpException` branch unchanged.
- The fallback (500) branch logs via the `@statecore/core` `logger`:
  `logger.error({ err: exception }, "Unhandled exception")`. `ZodError`/400 is a
  client error and is not error-logged (optionally debug).

### 2. `apps/api/src/memory.controller.ts` — queue error observability

- Replace `.catch(() => {})` on `embedQueue.add(...)` and
  `classifyQueue.add(...)` with `.catch((err) => logger.error({ err, eventId }, "<queue> enqueue failed"))`.
  Stays non-blocking for ingest; failures are now visible.

### 3. `packages/core/src/model-provider.test.ts` (new)

- `createModelProvider(null | undefined)` → `null`.
- `createModelProvider(config)` → a factory exposing chat + embedding clients.
- `LlmClient` / `EmbeddingClient` throw on non-2xx response and on
  missing content/vectors (mock `fetch`).

### 4. `packages/core/src/working-memory.service.test.ts` (new)

- `getLatest(scopeId)` delegates to the repo.
- `updateFromEvents(...)` produces/persists the expected working-memory snapshot
  (mock repo + options).

### 5. W2 test/quality follow-ups

- `apps/api/src/test/retrieve-no-query.integration.test.ts`: assert
  `res.body.events.length >= 1` and guard `scopeRes.status === 201`, so the test
  is falsifiable for the no-query retrieval path.
- `apps/api/src/test/v1-routing.integration.test.ts`: add 1–2 more excluded
  internal endpoints (e.g. `/v1/memory/check-contradiction`,
  `/v1/memory/digest/rebuild`) asserting 404 under `/v1`.
- `apps/api/src/reminders.controller.ts`: wrap responses in `parseOutput(...)`
  (`ReminderOutput` / `ReminderListOutput` / `ReminderCancelOutput`), matching
  the other handlers so the frozen contract is runtime-enforced.

### 6. Loose-ends verification (no scope expansion)

- Confirm `fact-registry` (`getActiveFactRegistry`, `FactRegistryEntrySchema`)
  and the API integration tests are functional. Record a one-line boundary note
  in the spec/PR. Only write code if a concrete gap is found.

## Testing

- Extend `apps/api/src/error.filter.test.ts`: a `ZodError` → 400 (with
  `details`) case, and confirm the 500 path logs.
- New unit tests (components 3, 4).
- Strengthened W2 tests (component 5).
- Acceptance: `pnpm --filter @statecore/core test`, `pnpm --filter @statecore/api test`
  green; invalid body → 400; no silent `.catch(() => {})` remains in
  `memory.controller.ts`; the two files have tests.

## Out of scope

- Structured/centralized logging beyond using the existing pino `logger`.
- Converting controllers to NestJS ValidationPipe/DTOs.
- Finishing/expanding fact-registry or integration-test features beyond
  verification.
- Rate limiting (a deployment/hosted-layer concern).
- The cross-workstream items belonging to W4 (docs/positioning, CLAUDE.md,
  SQLite-lite shelving).

## Next step

Decompose into ~5 tasks via writing-plans.
