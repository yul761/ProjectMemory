# S5 /v1 Input Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. (NOTE: this plan is being executed by a single background worktree agent end-to-end, then whole-branch reviewed — do all tasks in order, TDD, committing per task.)

**Goal:** Malformed and oversized request bodies return clean 4xx (not 500), and the JSON body has an explicit, configurable size limit.

**Architecture:** Extract a shared `configureApp(app, { maxBodyBytes })` that sets the JSON body-parser limit + global error filter, called by both `main.ts` bootstrap and the test `createTestApp`. Harden `GlobalErrorFilter` to map body-parser errors (oversized → 413, malformed JSON → 400). Pure api-layer change; no DB/worker/contract touch.

**Tech Stack:** NestJS v10.4.4 (`@nestjs/platform-express`), Express body-parser, Zod, vitest + supertest.

## Global Constraints

- Tests: `pnpm --filter @statecore/api test` (vitest). Integration harness: `apps/api/src/test/setup.ts` (`createTestApp`) + supertest, pattern in `apps/api/src/test/openapi.integration.test.ts`.
- NO breaking /v1: error responses are NOT in the OpenAPI contract — the OpenAPI snapshot tests (`apps/api/src/__snapshots__/*.snap`) MUST stay byte-identical (green, no `-u`).
- Body limit default = **1048576 bytes (1 MB)**, configurable via env `MAX_REQUEST_BODY_BYTES`.
- Do NOT introduce a global Zod ValidationPipe or rewrite the per-endpoint `.parse()` calls (YAGNI — they already yield clean 400s).
- Keep existing `GlobalErrorFilter` behavior intact: `ZodError`→400 `{error:"Validation failed", details}`, `HttpException`→its status, unknown→500 `{error:"Internal server error"}` (logged).

---

### Task 1: Harden GlobalErrorFilter for body-parser errors (unit-tested)

**Files:**
- Modify: `apps/api/src/error.filter.ts`
- Modify: `apps/api/src/error.filter.test.ts` (extend the existing suite)

**Interfaces:**
- Produces: `GlobalErrorFilter.catch` additionally maps body-parser errors. A body-parser error is detected by `err.type === "entity.too.large"` → 413, or (`err.type === "entity.parse.failed"` or `err instanceof SyntaxError` with a numeric `err.status`/`err.statusCode`) → 400.

- [ ] **Step 1: Write the failing tests (extend error.filter.test.ts)**

Add these cases to the existing `describe("GlobalErrorFilter", ...)` (the `makeHost`/`filter` helpers already exist):

```typescript
  it("maps an oversized-body error (entity.too.large) to 413", () => {
    const { host, status, json } = makeHost();
    filter.catch({ type: "entity.too.large", status: 413, message: "request entity too large" }, host);
    expect(status).toHaveBeenCalledWith(413);
    expect(json).toHaveBeenCalledWith({ error: "Request body too large" });
  });

  it("maps a malformed-JSON body-parser error (entity.parse.failed) to 400", () => {
    const { host, status, json } = makeHost();
    filter.catch({ type: "entity.parse.failed", status: 400, message: "Unexpected token" }, host);
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({ error: "Malformed JSON body" });
  });

  it("maps a body-parser SyntaxError to 400", () => {
    const { host, status, json } = makeHost();
    const err = Object.assign(new SyntaxError("Unexpected token } in JSON"), { type: "entity.parse.failed", status: 400 });
    filter.catch(err, host);
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({ error: "Malformed JSON body" });
  });

  it("does not leak internals for an oversized error (no raw message echoed)", () => {
    const { host, json } = makeHost();
    filter.catch({ type: "entity.too.large", status: 413, message: "request entity too large; limit 1048576" }, host);
    const payload = json.mock.calls[0][0] as { error: string };
    expect(payload.error).toBe("Request body too large");
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @statecore/api test error.filter`
Expected: the 4 new cases FAIL (current filter sends those to 500).

- [ ] **Step 3: Implement the body-parser branch in `error.filter.ts`**

Insert the body-parser handling AFTER the `ZodError` branch and BEFORE the `HttpException` branch (so an explicit body-parser type wins, but real HttpExceptions still map by status). Use a narrow type guard on `type`:

```typescript
    const bodyParserType = (exception as { type?: unknown })?.type;
    if (bodyParserType === "entity.too.large") {
      res.status(413).json({ error: "Request body too large" });
      return;
    }
    if (bodyParserType === "entity.parse.failed" || exception instanceof SyntaxError) {
      res.status(400).json({ error: "Malformed JSON body" });
      return;
    }
```

(Keep the existing `ZodError` branch above this, and `HttpException` + unknown-500 below it. The `instanceof SyntaxError` guard is a safety net for body-parser parse failures that may arrive as a bare SyntaxError.)

- [ ] **Step 4: Run to verify pass + full suite**

Run: `pnpm --filter @statecore/api test error.filter`
Expected: PASS (existing + 4 new).
Run: `pnpm --filter @statecore/api test`
Expected: full api suite PASS, OpenAPI snapshots unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/error.filter.ts apps/api/src/error.filter.test.ts
git commit -m "feat(api): map oversized/malformed request bodies to 413/400 in GlobalErrorFilter"
```

---

### Task 2: Explicit configurable body-size limit + shared app config + integration tests

**Files:**
- Create: `apps/api/src/configure-app.ts`
- Modify: `apps/api/src/env.ts` (add `MAX_REQUEST_BODY_BYTES`)
- Modify: `apps/api/src/main.ts` (use `configureApp`)
- Modify: `apps/api/src/test/setup.ts` (`createTestApp` uses `configureApp`, accepts optional limit override)
- Create: `apps/api/src/test/input-hardening.integration.test.ts`

**Interfaces:**
- Consumes: the hardened `GlobalErrorFilter` from Task 1.
- Produces: `configureApp(app: NestExpressApplication, opts: { maxBodyBytes: number }): void` (sets JSON body-parser limit + global error filter); `createTestApp(opts?: { maxBodyBytes?: number }): Promise<INestApplication>`; `apiEnv.maxRequestBodyBytes: number`.

- [ ] **Step 1: Add the env field**

In `apps/api/src/env.ts`: add to the schema object `MAX_REQUEST_BODY_BYTES: z.string().optional(),` and to the parsed `apiEnv` object `maxRequestBodyBytes: Number(env.MAX_REQUEST_BODY_BYTES || 1048576),`. Mind trailing commas / last-field placement.

- [ ] **Step 2: Create `apps/api/src/configure-app.ts`**

```typescript
import type { NestExpressApplication } from "@nestjs/platform-express";
import { GlobalErrorFilter } from "./error.filter";

// Single source of truth for HTTP-layer app wiring, used by both production
// bootstrap (main.ts) and the integration test app (test/setup.ts), so tests
// exercise the same body-size limit + error mapping as production.
export function configureApp(app: NestExpressApplication, opts: { maxBodyBytes: number }): void {
  app.useBodyParser("json", { limit: opts.maxBodyBytes });
  app.useGlobalFilters(new GlobalErrorFilter());
}
```

- [ ] **Step 3: Wire `configureApp` into `main.ts`**

In `bootstrap()`, type the app as `NestExpressApplication` and replace the standalone `app.useGlobalFilters(new GlobalErrorFilter());` with a `configureApp` call. Concretely:
```typescript
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { configureApp } from "./configure-app";
// ...
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ["log", "error", "warn"] });
  app.enableCors({ origin: "*" });
  configureApp(app, { maxBodyBytes: apiEnv.maxRequestBodyBytes });
  // ...keep the /docs/scalar.js + /docs + listen lines; remove the old useGlobalFilters line (now inside configureApp)
```
Keep the existing `/docs` handlers and `app.listen(apiEnv.port)`.

- [ ] **Step 4: Update `createTestApp` to use `configureApp`**

In `apps/api/src/test/setup.ts`:
```typescript
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "../app.module";
import { configureApp } from "../configure-app";

export async function createTestApp(opts: { maxBodyBytes?: number } = {}): Promise<INestApplication> {
  const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = module.createNestApplication<NestExpressApplication>();
  configureApp(app, { maxBodyBytes: opts.maxBodyBytes ?? 1048576 });
  await app.init();
  return app;
}
```
(Existing callers pass no args — the default 1 MB keeps them working.)

- [ ] **Step 5: Write the integration tests (TDD — write before confirming behavior)**

Create `apps/api/src/test/input-hardening.integration.test.ts`. Use a SMALL limit so the oversized test needs only a small payload:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { createTestApp } from "./setup";

describe("input hardening", () => {
  let app: INestApplication;
  beforeAll(async () => { app = await createTestApp({ maxBodyBytes: 1024 }); }, 30000);
  afterAll(async () => { await app.close(); });

  it("rejects an oversized JSON body with 413", async () => {
    const big = { scopeId: "x".repeat(2000) };
    const res = await request(app.getHttpServer())
      .post("/memory/events")
      .set("x-user-id", "local-dev-user")
      .send(big);
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: "Request body too large" });
  });

  it("rejects a malformed JSON body with 400", async () => {
    const res = await request(app.getHttpServer())
      .post("/memory/events")
      .set("x-user-id", "local-dev-user")
      .set("content-type", "application/json")
      .send('{ "scopeId": ');  // malformed JSON string
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Malformed JSON body" });
  });
});
```

- [ ] **Step 6: Run the integration tests — RESOLVE the body-parser-routing question empirically**

Run: `pnpm --filter @statecore/api test input-hardening`
Expected: PASS.

**If they FAIL because body-parser errors bypass the Nest `GlobalErrorFilter`** (Express middleware errors can route to Express's default error handler instead of Nest's exception filter — symptom: status may be right but `res.body` is HTML / not our `{error}` shape, or status is 500): add an Express error-handling middleware INSIDE `configureApp` that catches body-parser errors and sends our JSON shape. Insert in `configure-app.ts` after `useBodyParser`:
```typescript
  app.use((err: any, _req: any, res: any, next: any) => {
    if (err?.type === "entity.too.large") return res.status(413).json({ error: "Request body too large" });
    if (err?.type === "entity.parse.failed" || err instanceof SyntaxError) return res.status(400).json({ error: "Malformed JSON body" });
    return next(err);
  });
```
(NestExpressApplication `app.use` registers Express middleware; a 4-arg function is an Express error handler.) Re-run until green. Report which path was needed (Nest filter caught them, or the Express error middleware was required) — the unit tests from Task 1 stay valid either way.

- [ ] **Step 7: Run the full api suite**

Run: `pnpm --filter @statecore/api test`
Expected: all PASS, OpenAPI snapshots byte-identical.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/configure-app.ts apps/api/src/env.ts apps/api/src/main.ts apps/api/src/test/setup.ts apps/api/src/test/input-hardening.integration.test.ts
git commit -m "feat(api): explicit configurable request body size limit (default 1MB)"
```

---

## Self-Review

**Spec coverage:**
- Spec §1 (configurable body limit, env `MAX_REQUEST_BODY_BYTES` default 1MB, set in bootstrap) → Task 2 (env + configureApp + main.ts). ✓
- Spec §2 (GlobalErrorFilter: entity.too.large→413, entity.parse.failed/SyntaxError→400, keep ZodError/HttpException/500) → Task 1. ✓
- Spec testing (unit filter cases + integration oversized→413/malformed→400; snapshots unchanged) → Task 1 unit + Task 2 integration; both tasks run full suite. ✓
- Spec YAGNI (no ValidationPipe) → honored; only filter + body limit touched. ✓
- The Nest-version body-limit-API choice (spec said "implementer picks per version") → resolved: Nest 10.4.4 supports `app.useBodyParser` (Task 2 Step 2). ✓
- The body-parser-error-routing uncertainty (spec implied robustness) → Task 2 Step 6 resolves empirically with an explicit Express-error-middleware fallback. ✓

**Placeholder scan:** No TBD/vague steps — all code shown. The one conditional (Task 2 Step 6 fallback) shows the exact middleware to add and the symptom that triggers it. ✓

**Type consistency:** `configureApp(app: NestExpressApplication, { maxBodyBytes })` and `createTestApp(opts?: { maxBodyBytes? })` and `apiEnv.maxRequestBodyBytes` are used consistently across Tasks 2's files. `GlobalErrorFilter` reused unchanged in signature; Task 1 only adds branches. ✓
