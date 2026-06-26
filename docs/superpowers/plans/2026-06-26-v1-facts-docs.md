# Document memory-facts endpoints in public /v1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Additively add `GET /v1/memory/facts` and `POST /v1/memory/facts/forget` to StateCore's frozen `/v1` public contract + generated OpenAPI (with query-param support for `scopeId`).

**Architecture:** Add two entries to `PublicV1Contracts` (+ two small zod schemas), extend the OpenAPI generator to emit query parameters from an optional `query` schema on a contract entry, and re-bless both frozen snapshots. Contracts + generator + the two snapshot tests are tightly coupled (adding the contract entries makes the generator emit 15 ops, which breaks the "13" assertions until the generator + tests are updated together), so they are ONE task.

**Tech Stack:** TypeScript, zod, zod-to-json-schema, vitest. pnpm workspaces (`@statecore/contracts`, `@statecore/api`).

## Global Constraints

- **Additive only — do not modify the existing 13 endpoints' entries** (the other `/v1` surface stays byte-identical; only two new endpoints + new query-param emission).
- **Paths stay `/v1`. `info.version` stays `"1.0.0"` — do NOT bump.** No package-version 1.1.0 freeze in this change.
- Endpoint behavior/implementation is NOT changed (the routes are already implemented + deployed) — this is contract registration + docs only.
- `GET /v1/memory/facts` takes a required `scopeId` query parameter; `POST /v1/memory/facts/forget` takes a `ForgetFactInput` body and returns `{ ok: boolean }`.
- Query-param support is minimal: top-level fields of a `z.object()` `query` schema → OpenAPI `parameters[in=query]`; `required` = field is not optional. No nested/complex query expansion.
- Snapshots are re-blessed the standard vitest way (`-u`); the diff must show ONLY the two new endpoints (and the new query parameter), with the existing 13 unchanged.

---

## File Structure

- **Modify** `packages/contracts/src/index.ts` — add `ScopeIdQuery`, `MemoryForgetOutput`; add 2 entries to `PublicV1Contracts`.
- **Modify** `apps/api/src/openapi.ts` — emit query parameters from an optional `io.query`.
- **Modify** `apps/api/src/openapi.test.ts` — op count 13→15; add a query-param assertion.
- **Modify** `apps/api/src/public-v1-contract.snapshot.test.ts` — endpoint count 13→15 (+ 2 keys).
- **Regenerate** `apps/api/src/__snapshots__/openapi.test.ts.snap` and `apps/api/src/__snapshots__/public-v1-contract.snapshot.test.ts.snap` via `vitest -u`.

---

### Task 1: Register + document the two endpoints

**Files:**
- Modify: `packages/contracts/src/index.ts` (near `MemoryFactsOutput`/`ForgetFactInput` ~L163-181; `PublicV1Contracts` ~L660-679)
- Modify: `apps/api/src/openapi.ts` (the param-building block ~L77-83)
- Modify: `apps/api/src/openapi.test.ts` (op-count assertion ~L16-24)
- Modify: `apps/api/src/public-v1-contract.snapshot.test.ts` (endpoint list ~L14-32)
- Regenerate: the two `__snapshots__/*.snap` files

**Interfaces:**
- Consumes: existing `MemoryFactsOutput`, `ForgetFactInput` (already in contracts).
- Produces: `ScopeIdQuery`, `MemoryForgetOutput`; `PublicV1Contracts` entries `"GET /memory/facts"` (with `query`) and `"POST /memory/facts/forget"`; OpenAPI generator that emits `parameters[in=query]` from `io.query`.

- [ ] **Step 1: Write the failing assertions (tests first)**

In `apps/api/src/openapi.test.ts`, change the op-count test (currently `expect(opCount).toBe(13)`) to `15`, and ADD a query-param test inside the same `describe`:
```typescript
  it("documents exactly the 15 /v1 operations", () => {
    const opCount = Object.values(paths).reduce(
      (n, methods) => n + Object.keys(methods).length,
      0
    );
    expect(opCount).toBe(15);
    expect(Object.keys(paths).every((p) => p.startsWith("/v1/"))).toBe(true);
  });

  it("emits scopeId as a required query parameter on GET /v1/memory/facts", () => {
    const op = paths["/v1/memory/facts"].get as { parameters?: Array<{ name: string; in: string; required?: boolean }> };
    const scopeId = op.parameters?.find((p) => p.name === "scopeId" && p.in === "query");
    expect(scopeId).toBeDefined();
    expect(scopeId?.required).toBe(true);
  });
```
(Replace the old `"documents exactly the 13 /v1 operations"` test with the `15` version above; keep the rest of the file.)

In `apps/api/src/public-v1-contract.snapshot.test.ts`, update the endpoint list (currently 13) to include the two new keys (keep the `.sort()`):
```typescript
  it("has exactly the 15 designated endpoints", () => {
    expect(Object.keys(PublicV1Contracts).sort()).toEqual(
      [
        "GET /health",
        "GET /memory/facts",
        "GET /reminders",
        "GET /scopes",
        "GET /state",
        "POST /memory/answer",
        "POST /memory/digest",
        "POST /memory/events",
        "POST /memory/facts/forget",
        "POST /memory/retrieve",
        "POST /memory/runtime/turn",
        "POST /reminders",
        "POST /reminders/:id/cancel",
        "POST /scopes",
        "POST /scopes/:id/active"
      ].sort()
    );
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @statecore/api test openapi.test && pnpm --filter @statecore/api test public-v1-contract`
Expected: FAIL — the contract still has 13 entries / the generator emits 13 ops / no scopeId query param.

- [ ] **Step 3: Add the two contract schemas + PublicV1Contracts entries**

In `packages/contracts/src/index.ts`, after `ForgetFactInput` (~L181) add:
```typescript
export const ScopeIdQuery = z.object({ scopeId: z.string().uuid() });
export const MemoryForgetOutput = z.object({ ok: z.boolean() });
```
In the `PublicV1Contracts` object (~L660-679), add these two entries (e.g. right after `"POST /memory/runtime/turn": {...}`):
```typescript
  "GET /memory/facts": { query: ScopeIdQuery, response: MemoryFactsOutput },
  "POST /memory/facts/forget": { request: ForgetFactInput, response: MemoryForgetOutput },
```

- [ ] **Step 4: Extend the OpenAPI generator for query params**

In `apps/api/src/openapi.ts`, replace the param-building block (currently L77-83, the `const params = [...].map(...)` + `if (params.length) op.parameters = params;`) with:
```typescript
    const params: JsonObject[] = [...v1Path.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => ({
      name: m[1],
      in: "path",
      required: true,
      schema: { type: "string" }
    }));

    if ("query" in io && io.query) {
      const shape = (io.query as { shape: Record<string, ZodTypeAny> }).shape;
      for (const [name, fieldSchema] of Object.entries(shape)) {
        params.push({
          name,
          in: "query",
          required: !(fieldSchema as { isOptional: () => boolean }).isOptional(),
          schema: jsonSchema(fieldSchema)
        });
      }
    }

    if (params.length) op.parameters = params;
```
(The `io` in the loop is a `PublicV1Contracts` entry; mirror the existing `"request" in io` guard pattern for `"query" in io`.)

- [ ] **Step 5: Build contracts, then run the two tests + regenerate snapshots**

Run: `pnpm --filter @statecore/contracts build`
Then regenerate both snapshots and run the tests:
Run: `pnpm --filter @statecore/api test openapi.test -- -u`
Run: `pnpm --filter @statecore/api test public-v1-contract -- -u`
Expected: PASS; the `__snapshots__/openapi.test.ts.snap` and `__snapshots__/public-v1-contract.snapshot.test.ts.snap` files are updated.

- [ ] **Step 6: Review the snapshot diffs (additive only)**

Run: `git diff apps/api/src/__snapshots__/`
Expected: the diff ADDS only the two new endpoints' path/operation (the GET with a `scopeId` query parameter, the POST with a `ForgetFactInput` body + `{ok}` response) and the two new contract-surface entries. The existing 13 endpoints' operations/entries are UNCHANGED in the diff. If any existing entry changed, stop and investigate (the change must be purely additive).

- [ ] **Step 7: Run the full api suite + build**

Run: `pnpm --filter @statecore/api test`
Expected: green (real Postgres on localhost:5434 up for DB-touching specs).
Run: `pnpm --filter @statecore/contracts build && pnpm --filter @statecore/api build`
Expected: succeeds.

- [ ] **Step 8: Commit**

```bash
git add packages/contracts/src/index.ts apps/api/src/openapi.ts apps/api/src/openapi.test.ts apps/api/src/public-v1-contract.snapshot.test.ts apps/api/src/__snapshots__/
git commit -m "feat(contracts): document GET /v1/memory/facts + POST /v1/memory/facts/forget (additive)"
```

---

## Post-implementation verification

- `/openapi.json` (built from `PublicV1Contracts`) now has `/v1/memory/facts` (GET, with a `scopeId` query parameter) and `/v1/memory/facts/forget` (POST, `ForgetFactInput` body, `{ok}` response); the existing 13 are unchanged; `info.version` is still `1.0.0`.

## Deploy (controller-driven, two stages)

**Stage A — StateCore (Droplet 1, `ssh statecore`, TWO compose files):** after merge + push:
1. `cd /root/StateCore && git pull` (no migration).
2. `docker compose --env-file .env.production -f docker-compose.prod.yml -f compose.deploy.yml up -d --build api`.
3. Smoke: `curl -s http://127.0.0.1:3002/openapi.json | grep -c "memory/facts"` → should be ≥ 2; confirm the two paths + the GET scopeId query param are present.

**Stage B — statecore-cloud docs (controller-driven, NOT a TDD task — generated content):** after Stage A:
1. Run `sync-openapi` against the now-updated core `/openapi.json` (the script defaults to `http://localhost:3002/openapi.json`; point `STATECORE_OPENAPI_URL` at the deployed core, or run against a local core). It rewrites the security scheme to `Authorization: Bearer sc_live_...` and writes `apps/docs/openapi/openapi.json`.
2. Review the git diff (only the two new endpoints).
3. `pnpm --filter @statecore-cloud/docs gen-api-docs` (Docusaurus regenerates markdown).
4. Commit + push the updated `openapi.json` + generated docs.
5. Deploy: rebuild the cloud `docs` container on Droplet 1; verify `https://docs.statecore.io` shows the two endpoints.

---

## Self-Review

**Spec coverage:** §1 contracts (ScopeIdQuery + MemoryForgetOutput + 2 PublicV1Contracts entries) → Task 1 Steps 3. §2 generator query support → Step 4. §3 snapshots (13→15 + re-bless) → Steps 1,5,6. §4 cloud docs → Deploy Stage B (controller-driven). Testing → Steps 1-7. info.version unchanged / paths /v1 / additive-only → Global Constraints + Step 6 diff review.

**Placeholder scan:** none — concrete code/commands throughout.

**Type consistency:** `ScopeIdQuery`/`MemoryForgetOutput` consistent (contract + generator reads `io.query.shape`); endpoint keys `"GET /memory/facts"` / `"POST /memory/facts/forget"` consistent across the contract entry, both snapshot tests, and the generator output paths `/v1/memory/facts` + `/v1/memory/facts/forget`.
