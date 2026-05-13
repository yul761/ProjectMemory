# Integration Tests Design

**Date:** 2026-05-13
**Status:** Approved

## Problem

Zero integration tests exist. The API controller → service → database path is untested. Error handling, auth middleware, and response format correctness are only verified manually.

## Goal

Add HTTP-level integration tests covering the critical path: scope management, event ingestion, and fast-view retrieval. Tests run against a real PostgreSQL test database.

## Approach

Use `@nestjs/testing` + `supertest` to spin up a real NestJS application and send actual HTTP requests. A dedicated test database (`statecore_test`) is reset before each test suite.

## Test Infrastructure

### New files

```
apps/api/src/test/
├── setup.ts                        # NestJS TestingModule factory + Prisma test client
├── helpers.ts                      # clearDatabase() utility
└── api.integration.test.ts         # All integration tests
```

### Environment

Add to `.env.example`:
```
DATABASE_URL_TEST=postgresql://postgres:postgres@localhost:5433/statecore_test
```

Tests read `DATABASE_URL_TEST` (not `DATABASE_URL`) so dev data is never touched.

### DB lifecycle

- `beforeAll`: create NestJS app, run `prisma migrate deploy` against test DB
- `beforeEach`: call `clearDatabase()` to truncate all tables
- `afterAll`: close app and disconnect Prisma

## Test Cases (6)

| # | Test | Expected |
|---|------|----------|
| 1 | `POST /scopes` with `{ name: "test-scope" }` | 201, body has `id`, `name: "test-scope"` |
| 2 | `GET /scopes` after creating one | 200, `items` array with 1 scope |
| 3 | `POST /scopes/:id/active` | 200, `activeScopeId` equals scope id |
| 4 | `POST /memory/events` with stream event | 201, body has `id`, `content`, `type: "stream"` |
| 5 | `GET /memory/fast-view?scopeId=<id>` | 200, body has `scopeId`, `fastLayerContext` |
| 6 | `GET /memory/fast-view` without scopeId | 400, `{ error: "scopeId required" }` |

All requests use header `x-user-id: test-user`.

## Dependencies to add

- `supertest` + `@types/supertest` — HTTP assertion client
- `@nestjs/testing` — NestJS test module

## Out of Scope

- Worker/queue integration tests
- LLM-dependent paths (digest, answer, runtime turn)
- Full endpoint coverage (30+ endpoints)
- Performance testing
