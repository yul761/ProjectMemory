# P0 — OpenAPI Generation for `/v1` + `/docs` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate an OpenAPI 3.0 document for the frozen `/v1` public subset from `PublicV1Contracts`, serve it at `GET /openapi.json`, and serve an interactive Scalar UI at `/docs` — both auth-exempt.

**Architecture:** A pure generator (`buildOpenApiDocument()`) maps each `PublicV1Contracts` entry to an OpenAPI path/operation (zod → JSON Schema via `target: "openApi3"`), guarded by a snapshot test. A NestJS controller serves the JSON; Scalar's express middleware serves `/docs` from `main.ts`; auth + rate-limit middleware are extended to exempt both.

**Tech Stack:** NestJS/Express, Zod, `zod-to-json-schema@3.25.2` (`target: "openApi3"`), `@scalar/express-api-reference`, vitest, supertest.

## Global Constraints

- Scope: only the 13 `/v1` public endpoints (derive from `PublicV1Contracts`); do not document internal/unversioned endpoints.
- No `any` (repo lints `@typescript-eslint/no-explicit-any`); use `unknown` + targeted casts (the contract snapshot test's `zodToJsonSchema as unknown as (...)` cast pattern is the precedent for the TS2589 deep-type issue).
- Auth (`x-user-id`) is modeled as an `apiKey` header security scheme applied globally; `GET /v1/health` is `security: []`.
- `/openapi.json` and `/docs` must be reachable WITHOUT an `x-user-id` header (auth- and rate-limit-exempt).
- Output is an OpenAPI **3.0.x** document. No committed static `openapi.json` file.
- Conventional-commit messages, each ending with exactly:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Integration tests need the provisioned Postgres test DB (`statecore_test`); see Task 2 prerequisite.

## Test-harness note (affects Task 2 verification)

`apps/api/src/test/setup.ts#createTestApp` builds the app from `AppModule` only — it does NOT run `main.ts`'s bootstrap. Therefore the `GET /openapi.json` controller IS exercised by the supertest harness, but the Scalar `/docs` middleware (mounted via `app.use` in `main.ts`) is NOT. So `/openapi.json` is integration-tested; `/docs` is verified by a smoke command, not the vitest harness.

## File Structure

- `apps/api/src/openapi.ts` — `buildOpenApiDocument()` generator (Task 1). (Create)
- `apps/api/src/openapi.test.ts` — unit + snapshot test (Task 1). (Create)
- `apps/api/package.json` — move `zod-to-json-schema` to dependencies (Task 1); add `@scalar/express-api-reference` (Task 2). (Modify)
- `apps/api/src/openapi.controller.ts` — `GET /openapi.json` (Task 2). (Create)
- `apps/api/src/app.module.ts` — register `OpenApiController` (Task 2). (Modify)
- `apps/api/src/main.ts` — mount Scalar at `/docs` + rate-limit exemption (Task 2). (Modify)
- `apps/api/src/auth.middleware.ts` — exempt `/openapi.json` and `/docs` (Task 2). (Modify)
- `apps/api/src/test/openapi.integration.test.ts` — `/openapi.json` integration test (Task 2). (Create)

---

### Task 1: OpenAPI generator + snapshot/unit test

**Files:**
- Create: `apps/api/src/openapi.ts`
- Create: `apps/api/src/openapi.test.ts`
- Modify: `apps/api/package.json` (move `zod-to-json-schema` dev → dependencies) + `pnpm-lock.yaml`

**Interfaces:**
- Consumes: `PublicV1Contracts` from `@statecore/contracts` — a `Record<"<METHOD> <path>", { request?: ZodTypeAny; response: ZodTypeAny }>` (13 entries; paths use `:id` style; some `response` schemas are `.pick()`/`.omit()` ZodObjects).
- Produces: `buildOpenApiDocument(): Record<string, unknown>` — an OpenAPI 3.0.x document (built once, cached).

- [ ] **Step 1: Write the failing unit/snapshot test**

Create `apps/api/src/openapi.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildOpenApiDocument } from "./openapi";

type SecuritySchemes = { apiKey?: { type: string; in: string; name: string } };
type Op = { security?: unknown[] };

describe("buildOpenApiDocument", () => {
  const doc = buildOpenApiDocument();
  const paths = doc.paths as Record<string, Record<string, Op>>;

  it("is an OpenAPI 3.0.x document", () => {
    expect(String(doc.openapi)).toMatch(/^3\.0\./);
    expect(typeof doc.info).toBe("object");
  });

  it("documents exactly the 13 /v1 operations", () => {
    const opCount = Object.values(paths).reduce(
      (n, methods) => n + Object.keys(methods).length,
      0
    );
    expect(opCount).toBe(13);
    // every documented path is under /v1
    expect(Object.keys(paths).every((p) => p.startsWith("/v1/"))).toBe(true);
  });

  it("declares the x-user-id apiKey security scheme, applied globally", () => {
    const schemes = (doc.components as { securitySchemes: SecuritySchemes }).securitySchemes;
    expect(schemes.apiKey).toEqual({ type: "apiKey", in: "header", name: "x-user-id" });
    expect(doc.security).toEqual([{ apiKey: [] }]);
  });

  it("marks GET /v1/health as public (security: [])", () => {
    expect(paths["/v1/health"].get.security).toEqual([]);
  });

  it("converts :id path params to {id} with a path parameter", () => {
    const op = paths["/v1/scopes/{id}/active"].post as { parameters?: Array<{ name: string; in: string }> };
    expect(op.parameters?.some((p) => p.name === "id" && p.in === "path")).toBe(true);
  });

  it("matches the committed snapshot", () => {
    expect(doc).toMatchSnapshot();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @statecore/api test -- openapi.test`
Expected: FAIL — `./openapi` module does not exist yet.

- [ ] **Step 3: Implement the generator**

Create `apps/api/src/openapi.ts`:

```ts
import type { ZodTypeAny } from "zod";
import { PublicV1Contracts } from "@statecore/contracts";

type JsonObject = Record<string, unknown>;

// zod-to-json-schema's return type is deeply recursive (TS2589); erase it like
// the contract snapshot test does. Runtime behavior is unchanged.
import { zodToJsonSchema } from "zod-to-json-schema";
const toJsonSchema = zodToJsonSchema as unknown as (
  schema: ZodTypeAny,
  opts: { target: "openApi3"; $refStrategy: "none" }
) => unknown;

function jsonSchema(schema: ZodTypeAny): unknown {
  return toJsonSchema(schema, { target: "openApi3", $refStrategy: "none" });
}

function tagFor(path: string): string {
  const seg = path.split("/").filter(Boolean)[0] ?? "default";
  return seg === "state" ? "scopes" : seg;
}

function operationId(method: string, path: string): string {
  const slug = path.replace(/[:/{}]/g, " ").trim().split(/\s+/).filter(Boolean).join("_") || "root";
  return `${method.toLowerCase()}_${slug}`;
}

const errorSchema = {
  type: "object",
  properties: { error: { type: "string" }, details: { type: "array", items: {} } },
  required: ["error"]
};

let cached: JsonObject | null = null;

export function buildOpenApiDocument(): JsonObject {
  if (cached) return cached;

  const paths: Record<string, JsonObject> = {};

  for (const [endpoint, io] of Object.entries(PublicV1Contracts)) {
    const spaceIdx = endpoint.indexOf(" ");
    const method = endpoint.slice(0, spaceIdx);
    const rawPath = endpoint.slice(spaceIdx + 1);
    const v1Path = "/v1" + rawPath.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
    const lower = method.toLowerCase();
    const successCode = method === "GET" ? "200" : "201";

    const op: JsonObject = {
      operationId: operationId(method, rawPath),
      tags: [tagFor(rawPath)],
      responses: {
        [successCode]: {
          description: "Success",
          content: { "application/json": { schema: jsonSchema(io.response as ZodTypeAny) } }
        },
        "400": {
          description: "Validation failed",
          content: { "application/json": { schema: errorSchema } }
        }
      }
    };

    const params = [...v1Path.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => ({
      name: m[1],
      in: "path",
      required: true,
      schema: { type: "string" }
    }));
    if (params.length) op.parameters = params;

    if ("request" in io && io.request) {
      op.requestBody = {
        required: true,
        content: { "application/json": { schema: jsonSchema(io.request as ZodTypeAny) } }
      };
    }

    if (v1Path === "/v1/health") op.security = [];

    paths[v1Path] = { ...(paths[v1Path] ?? {}), [lower]: op };
  }

  cached = {
    openapi: "3.0.3",
    info: {
      title: "StateCore API",
      version: "1.0.0",
      description: "Frozen public /v1 surface of the StateCore memory runtime."
    },
    servers: [{ url: "/" }],
    components: {
      securitySchemes: {
        apiKey: { type: "apiKey", in: "header", name: "x-user-id" }
      }
    },
    security: [{ apiKey: [] }],
    paths
  };
  return cached;
}
```

- [ ] **Step 4: Move `zod-to-json-schema` to runtime dependencies**

It is now imported by runtime code (`openapi.ts`), not just the test. Run:
`pnpm --filter @statecore/api remove zod-to-json-schema && pnpm --filter @statecore/api add zod-to-json-schema`
Expected: `apps/api/package.json` lists `zod-to-json-schema` under `dependencies` (not `devDependencies`); lockfile updates.

- [ ] **Step 5: Run the test; generate + sanity-check the snapshot**

Run: `pnpm --filter @statecore/api test -- openapi.test`
Expected: PASS. On first run the snapshot file
`apps/api/src/__snapshots__/openapi.test.ts.snap` is written. Open it and confirm
it contains `/v1/scopes`, `/v1/memory/runtime/turn`, `/v1/health`, and the
`securitySchemes.apiKey` block.

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @statecore/api exec tsc --noEmit`
Expected: no type errors.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/openapi.ts apps/api/src/openapi.test.ts \
  apps/api/src/__snapshots__/openapi.test.ts.snap \
  apps/api/package.json pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
feat(api): generate OpenAPI 3.0 for the /v1 public surface from PublicV1Contracts

buildOpenApiDocument() maps the 13 frozen /v1 endpoints to an OpenAPI 3.0 doc
(zod -> openApi3 JSON Schema), with an x-user-id apiKey security scheme and a
public /v1/health. Snapshot + unit tested. Moves zod-to-json-schema to runtime
dependencies (now used outside tests).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Serve `/openapi.json` + Scalar `/docs`, auth-exempt

**Prerequisite (one-time, per `apps/api/src/test/README.md`):**
```bash
docker compose -f docker-compose.local.yml up -d postgres
docker exec statecore-postgres-1 psql -U postgres -c "CREATE DATABASE statecore_test"   # ignore error if it already exists
DATABASE_URL="postgresql://postgres:postgres@localhost:5434/statecore_test" \
  pnpm --filter @statecore/db prisma migrate deploy
```

**Files:**
- Create: `apps/api/src/openapi.controller.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/src/main.ts`
- Modify: `apps/api/src/auth.middleware.ts`
- Modify: `apps/api/package.json` (add `@scalar/express-api-reference`) + `pnpm-lock.yaml`
- Create: `apps/api/src/test/openapi.integration.test.ts`

**Interfaces:**
- Consumes: `buildOpenApiDocument()` from `./openapi` (Task 1).

- [ ] **Step 1: Write the failing integration test**

Create `apps/api/src/test/openapi.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { createTestApp } from "./setup";

describe("GET /openapi.json", () => {
  let app: INestApplication;
  beforeAll(async () => { app = await createTestApp(); }, 30000);
  afterAll(async () => { await app.close(); });

  it("is reachable without auth and returns a valid OpenAPI 3.0 doc", async () => {
    const res = await request(app.getHttpServer()).get("/openapi.json"); // no x-user-id
    expect(res.status).toBe(200);
    expect(String(res.body.openapi)).toMatch(/^3\.0\./);
    expect(res.body.paths["/v1/scopes"]).toBeDefined();
    expect(res.body.components.securitySchemes.apiKey.name).toBe("x-user-id");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @statecore/api test -- openapi.integration`
Expected: FAIL — `/openapi.json` is not routed yet (likely 404, or 401/blocked by auth).

- [ ] **Step 3: Add the controller**

Create `apps/api/src/openapi.controller.ts`:

```ts
import { Controller, Get } from "@nestjs/common";
import { buildOpenApiDocument } from "./openapi";

@Controller()
export class OpenApiController {
  @Get("/openapi.json")
  getOpenApi() {
    return buildOpenApiDocument();
  }
}
```

- [ ] **Step 4: Register the controller**

In `apps/api/src/app.module.ts`, import and add `OpenApiController` to the `controllers` array:

```ts
import { OpenApiController } from "./openapi.controller";
```
and include `OpenApiController` in the `controllers: [...]` list (e.g. after `HealthController`).

- [ ] **Step 5: Exempt `/openapi.json` and `/docs` from auth**

In `apps/api/src/auth.middleware.ts`, extend the skip condition:

```ts
  const path = req.originalUrl.split("?")[0];
  if (
    path === "/health" ||
    path === "/v1/health" ||
    path === "/openapi.json" ||
    path === "/docs" ||
    path.startsWith("/docs/")
  ) {
    return next();
  }
```

- [ ] **Step 6: Run the integration test to verify `/openapi.json` passes**

Run: `pnpm --filter @statecore/api test -- openapi.integration`
Expected: PASS (200, valid OpenAPI, `/v1/scopes` present, apiKey name `x-user-id`).

- [ ] **Step 7: Add Scalar and mount `/docs` (+ rate-limit exemption) in main.ts**

Run: `pnpm --filter @statecore/api add @scalar/express-api-reference`

In `apps/api/src/main.ts`:
- add the import: `import { apiReference } from "@scalar/express-api-reference";`
- in `rateLimitMiddleware`, broaden the first skip from `if (req.path === "/health")` to:

```ts
  if (req.path === "/health" || req.path === "/openapi.json" || req.path === "/docs" || req.path.startsWith("/docs/")) {
    next();
    return;
  }
```

- in `bootstrap()`, after `app.use(rateLimitMiddleware);` and before `await app.listen(...)`, mount Scalar pointing at the JSON endpoint:

```ts
  app.use("/docs", apiReference({ url: "/openapi.json" }));
```

Note: confirm the option name against the installed package's types. If `{ url }` is rejected, use `{ spec: { url: "/openapi.json" } }` (older Scalar express API). Do not invent other options.

- [ ] **Step 8: Typecheck + full api suite (no regression)**

Run: `pnpm --filter @statecore/api exec tsc --noEmit && pnpm --filter @statecore/api test`
Expected: no type errors; full suite green (incl. the new openapi integration test).

- [ ] **Step 9: Smoke-verify `/docs` against a running server**

(`/docs` is mounted in `main.ts`, which the vitest harness does not run, so verify it live.) With the app dependencies up and env configured, start the API and curl `/docs`:

Run: `STATECORE_MODE= pnpm --filter @statecore/api start &` then, once listening, `curl -s -o /dev/null -w "%{http_code}" http://localhost:3002/docs`
Expected: `200`. (Also `curl -s http://localhost:3002/openapi.json | head -c 40` shows the JSON.) Stop the server afterward.
If the local env cannot start the full server, record that `/docs` was not smoke-verified here and note it will be checked in a running deployment — do NOT weaken the route or fake the result.

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/openapi.controller.ts apps/api/src/app.module.ts \
  apps/api/src/main.ts apps/api/src/auth.middleware.ts \
  apps/api/package.json pnpm-lock.yaml \
  apps/api/src/test/openapi.integration.test.ts
git commit -m "$(cat <<'EOF'
feat(api): serve /openapi.json and an interactive Scalar UI at /docs

GET /openapi.json (NestJS controller) returns the generated /v1 OpenAPI doc;
/docs serves Scalar pointing at it. Both are exempt from auth and rate limiting
so the API reference is publicly reachable. Integration-tested (/openapi.json
no-auth 200); /docs smoke-verified against a running server.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- Generator from `PublicV1Contracts`, OpenAPI 3.0, openApi3 target, `/v1` paths, tags, success+400 responses, apiKey scheme, public health → Task 1. ✓
- Snapshot + unit assertions (13 ops, security scheme, health public, path param) → Task 1. ✓
- `GET /openapi.json` controller → Task 2. ✓
- Scalar `/docs` → Task 2. ✓
- auth + rate-limit exemptions for `/openapi.json` and `/docs` → Task 2 Steps 5, 7. ✓
- `zod-to-json-schema` dev→deps; add `@scalar/express-api-reference` → Tasks 1/2. ✓
- Integration test (`/openapi.json` no-auth 200) + `/docs` smoke → Task 2. ✓

**Placeholder scan:** No TBD/TODO; complete code for the generator, controller, test, and every edit. The only "verify against installed types" note is for an external lib's option name, with an explicit fallback. ✓

**Type consistency:** `buildOpenApiDocument(): Record<string, unknown>` defined in Task 1 and consumed by the Task 2 controller; `PublicV1Contracts` shape matches its W2 definition; no `any` (zodToJsonSchema cast via `unknown`, matching the existing snapshot-test precedent). ✓
