# P0 — OpenAPI Generation for `/v1` + `/docs` — Design

Date: 2026-06-21
Status: Approved (brainstorming) → ready for implementation planning
Context: First foundation piece for the hosted version (see
[[statecore-layered-product-direction]]), but it lives in the **open-source core**
repo — it is derived from the already-frozen public contract and benefits
self-hosters too. Also resolves the "do we have swagger?" gap.

## Context

W2 froze a 13-handler public `/v1` subset and defined `PublicV1Contracts` (in
`packages/contracts/src/index.ts`) as its single source of truth, guarded by a
zod-to-json-schema snapshot test. There is currently no OpenAPI spec and no API
reference UI. The hosted version's docs site and SDK pipelines will consume an
OpenAPI document; generating it here, from the existing contract source, unblocks
that and gives self-hosters interactive docs.

Stack facts: NestJS on Express; `zod-to-json-schema@3.25.2` (supports
`target: "openApi3"`); auth (`auth.middleware.ts`, `forRoutes("*")`) and rate-limit
(`main.ts`) middleware currently exempt only `/health` (+ `/v1/health` for auth).

## Decisions (from brainstorming)

- **Runtime generation + snapshot test.** A generator function builds the doc;
  served at runtime via `GET /openapi.json` and `/docs`. No committed
  `openapi.json` artifact (SDK pipelines pull the endpoint or call the generator).
  A snapshot test guards the generated doc.
- **Scalar** for the `/docs` UI (`@scalar/express-api-reference`) — modern,
  interactive, single dependency.

## Components

### 1. Generator — `apps/api/src/openapi.ts` (new)

`buildOpenApiDocument(): OpenAPIObject` — builds an OpenAPI 3.0 document from
`PublicV1Contracts`, built once and cached.

- For each `"<METHOD> <path>"` entry: document the **public `/v1` path** (prefix
  `/v1`; convert `:id` → `{id}` and declare it as a required string path
  parameter); group operations by resource via `tags`
  (scopes / memory / reminders / health); derive a stable `operationId`.
- Schemas via `zodToJsonSchema(schema, { target: "openApi3", $refStrategy: "none" })`
  (inline). `request` (when present) → `requestBody` (application/json).
- Success response: `200` for GET, `201` for POST (matches actual NestJS
  behavior), with the response schema. Plus a shared `400` response
  (`{ error: string, details?: array }`) reflecting the W3 validation-error shape.
- `components.securitySchemes.apiKey` = `{ type: "apiKey", in: "header", name: "x-user-id" }`,
  applied globally; `GET /v1/health` overrides with `security: []` (no auth).
- `info` (title "StateCore API", version "1.0.0" / the `/v1` label) and a
  `servers` entry.

### 2. Serving — `GET /openapi.json` + `/docs`

- `GET /openapi.json` returns `buildOpenApiDocument()`. Implemented as a small
  NestJS controller (`OpenApiController`) so it lives with the app.
- `/docs` served via Scalar's express middleware mounted in `main.ts`
  (`app.use("/docs", apiReference({ url: "/openapi.json" }))`), pointing at the
  JSON endpoint.

### 3. Middleware exemptions

- `auth.middleware.ts`: extend the skip set (currently `/health`, `/v1/health`)
  to also skip `/openapi.json` and `/docs` (prefix match for `/docs` assets).
- `main.ts` rate-limit: skip `/openapi.json` and `/docs` too (currently skips
  only `/health`).

### 4. Dependency changes

- Add `@scalar/express-api-reference` (runtime dependency).
- **Move `zod-to-json-schema` from `devDependencies` back to `dependencies`** in
  `apps/api/package.json` — W3 made it dev-only (snapshot test); `openapi.ts` now
  uses it at runtime.

## Testing

- `apps/api/src/openapi.test.ts` (unit): snapshot of `buildOpenApiDocument()`;
  assertions that it contains exactly the 13 `/v1` operations, the `apiKey`
  security scheme, and that `GET /v1/health` has `security: []`.
- Integration (existing supertest harness): `GET /openapi.json` → 200 **without**
  an `x-user-id` header (auth-exempt) and is valid JSON with `openapi: "3.x"`;
  `GET /docs` → 200 HTML.

## Out of scope

- A committed static `openapi.json` file.
- Query parameters not present in the contracts (e.g. reminders list
  `status`/`limit`/`cursor`) — documented as a known omission, added later.
- Richer responses (401/404 per-endpoint), SDK generation, and the hosted docs
  site (Docusaurus/Mintlify) — those belong to the hosted layer.
- Documenting internal/unversioned endpoints (only the frozen `/v1` subset).

## Acceptance

- `/docs` opens in a browser (no auth) showing the 13 `/v1` endpoints with
  try-it; `/openapi.json` is a valid OpenAPI 3.0 document; the snapshot test
  guards it; `pnpm --filter @statecore/api test` and core tests stay green.

## Next step

Decompose into ~3 tasks (generator + snapshot/unit test; serving controller +
Scalar + middleware exemptions; dependency wiring + integration verification) via
writing-plans.
