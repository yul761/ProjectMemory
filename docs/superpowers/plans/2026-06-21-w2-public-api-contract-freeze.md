# W2 — Public API Contract Freeze (`/v1`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose a frozen `/v1` public API subset (dual-mounted alongside legacy paths so peripherals keep working), guarded by a JSON-schema snapshot test, and fix the one contract/implementation mismatch.

**Architecture:** No NestJS global versioning. Each public handler is mounted at BOTH its legacy path and a `/v1`-prefixed path via the route decorator's array form (`@Post(["/x", "/v1/x"])`) — one handler, two paths. A `PublicV1Contracts` registry in `@statecore/contracts` is the single source of truth for the frozen surface; a snapshot test serializes it via `zod-to-json-schema` and fails on any change. Internal/debug endpoints stay single-mounted (legacy only).

**Tech Stack:** TypeScript (strict), NestJS, Zod, `zod-to-json-schema`, vitest, supertest, Prisma/Postgres.

## Global Constraints

- Core readiness scope is `packages/*`, `apps/api`, `apps/worker` only — do not modify `apps/cli`, `apps/adapter-telegram`, `apps/adapter-mcp`, `apps/demo-web`. (Their legacy paths must keep working — verified by leaving legacy routes intact.)
- No `any` (repo lints `@typescript-eslint/no-explicit-any`).
- Freeze discipline for the public subset (documented, enforced by the snapshot diff): never remove/rename/retype an existing field; new fields always optional; enums are open sets.
- The public `/v1` subset is exactly these 13 handlers — no more, no less:
  `POST /scopes`, `GET /scopes`, `POST /scopes/:id/active`, `GET /state`,
  `POST /memory/events`, `POST /memory/retrieve`, `POST /memory/answer`,
  `POST /memory/digest`, `POST /memory/runtime/turn`,
  `POST /reminders`, `GET /reminders`, `POST /reminders/:id/cancel`, `GET /health`.
- Conventional-commit messages, each ending with exactly:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Integration tests need the provisioned Postgres test DB (`statecore_test`); see Task 1 prerequisite.

## Implementation notes (refinements over the spec)

Two location refinements over `docs/superpowers/specs/2026-06-21-w2-public-api-contract-freeze-design.md`, made for sound engineering reasons:
1. `PublicV1Contracts` is defined directly in `packages/contracts/src/index.ts` (next to the existing `PublicRuntimeContracts` etc.), NOT in a new `public-v1.ts`. All schemas are already in scope there; a separate file that imports them and is re-exported by `index.ts` would create an import cycle.
2. The snapshot test lives in `apps/api` (which already has vitest + CI wiring) rather than in `packages/contracts` (which has no test runner). It imports `PublicV1Contracts` from `@statecore/contracts`. This avoids adding a whole test-runner + CI step to the pure-schema package.

## File Structure

- `packages/contracts/src/index.ts` — make `RetrieveInput.query` optional (Task 1); add `PublicV1Contracts` registry (Task 2). (Modify)
- `apps/api/package.json` — add `zod-to-json-schema` dependency (Task 2). (Modify)
- `apps/api/src/public-v1-contract.snapshot.test.ts` — snapshot test of the frozen surface (Task 2). (Create)
- `apps/api/src/__snapshots__/public-v1-contract.snapshot.test.ts.snap` — committed snapshot (Task 2, generated). (Create)
- `apps/api/src/scopes.controller.ts`, `memory.controller.ts`, `reminders.controller.ts`, `health.controller.ts` — dual-mount the 13 handlers (Task 3). (Modify)
- `apps/api/src/auth.middleware.ts` — also skip auth for `/v1/health` (Task 3). (Modify)
- `apps/api/src/test/v1-routing.integration.test.ts` — dual-mount routing test (Task 3). (Create)
- `docs/api.md` — `/v1` section (Task 4). (Modify)

---

### Task 1: Make `RetrieveInput.query` optional (contract ↔ implementation alignment)

**Prerequisite (one-time, per `apps/api/src/test/README.md`):**
```bash
docker compose -f docker-compose.local.yml up -d postgres
docker exec statecore-postgres-1 psql -U postgres -c "CREATE DATABASE statecore_test"   # ignore error if it already exists
DATABASE_URL="postgresql://postgres:postgres@localhost:5434/statecore_test" \
  pnpm --filter @statecore/db prisma migrate deploy
```

**Files:**
- Modify: `packages/contracts/src/index.ts:116`
- Test: `apps/api/src/test/retrieve-no-query.integration.test.ts` (Create)

**Interfaces:**
- Produces: `RetrieveInput` with `query?: string` (optional). `RetrieveService.retrieve(scopeId, limit, query?)` already treats query as optional (returns recent events when absent) — this only aligns the contract.

- [ ] **Step 1: Write the failing integration test**

Create `apps/api/src/test/retrieve-no-query.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { createTestApp } from "./setup";
import { clearDatabase } from "./helpers";

const USER = "retrieve-user";

describe("POST /memory/retrieve without query", () => {
  let app: INestApplication;
  beforeAll(async () => { app = await createTestApp(); }, 30000);
  beforeEach(async () => { await clearDatabase(); });
  afterAll(async () => { await app.close(); });

  it("accepts a request with no query and returns recent events", async () => {
    const scopeRes = await request(app.getHttpServer())
      .post("/scopes").set("x-user-id", USER).send({ name: "s" });
    const scopeId = scopeRes.body.id as string;

    await request(app.getHttpServer())
      .post("/memory/events").set("x-user-id", USER)
      .send({ scopeId, type: "stream", source: "api", content: "hello world" });

    const res = await request(app.getHttpServer())
      .post("/memory/retrieve").set("x-user-id", USER)
      .send({ scopeId, limit: 5 }); // no query

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.matches)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @statecore/api test -- retrieve-no-query`
Expected: FAIL — status is 400 (Zod rejects the missing required `query`), not 200.

- [ ] **Step 3: Make `query` optional**

In `packages/contracts/src/index.ts`, change line 116 inside `RetrieveInput`:

```ts
  query: z.string().min(1).optional(),
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @statecore/api test -- retrieve-no-query`
Expected: PASS (status 200, `matches` is an array).

- [ ] **Step 5: Confirm no regression in retrieve tests + typecheck**

Run: `pnpm --filter @statecore/core test -- retrieve && pnpm --filter @statecore/api exec tsc --noEmit`
Expected: PASS / no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/index.ts apps/api/src/test/retrieve-no-query.integration.test.ts
git commit -m "$(cat <<'EOF'
fix(contracts): make RetrieveInput.query optional to match RetrieveService

RetrieveService.retrieve already treats query as optional (returns recent
events when absent), but the contract required it (min(1)), so a no-query
retrieve 400'd. Align the contract; add an integration test for the no-query path.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `PublicV1Contracts` registry + JSON-schema snapshot test

**Files:**
- Modify: `packages/contracts/src/index.ts` (add `PublicV1Contracts` after the existing `*Contracts` groups, near line 684)
- Modify: `apps/api/package.json` (add `zod-to-json-schema` dependency)
- Create: `apps/api/src/public-v1-contract.snapshot.test.ts`
- Generated + committed: `apps/api/src/__snapshots__/public-v1-contract.snapshot.test.ts.snap`

**Interfaces:**
- Consumes: existing exported schemas in `packages/contracts/src/index.ts` (`ScopeCreateInput`, `ScopeOutput`, `ScopeListOutput`, `ScopeActivationOutput`, `StateOutput`, `MemoryEventInput`, `MemoryEventOutput`, `RetrieveInput`, `RetrieveOutput`, `AnswerInput`, `AnswerOutput`, `DigestRequestInput`, `DigestEnqueueOutput`, `RuntimeTurnInput`, `RuntimeTurnOutput`, `ReminderCreateInput`, `ReminderOutput`, `ReminderListOutput`, `ReminderCancelOutput`, `HealthOutput`).
- Produces: `PublicV1Contracts` — a `Record<string, { request?: ZodType; response: ZodType }>` keyed by `"<METHOD> <path>"`, exported from `@statecore/contracts`.

- [ ] **Step 1: Add the `PublicV1Contracts` registry**

In `packages/contracts/src/index.ts`, after the `DemoWebContracts` block (around line 684), add:

```ts
// The frozen public /v1 API surface — the single source of truth for what
// external layers (hosted version, GPT-API layer) may depend on. Guarded by
// apps/api/src/public-v1-contract.snapshot.test.ts. Additive-optional changes
// are allowed; removals/renames/retypes/required-additions are breaking.
export const PublicV1Contracts = {
  "POST /scopes": { request: ScopeCreateInput, response: ScopeOutput },
  "GET /scopes": { response: ScopeListOutput },
  "POST /scopes/:id/active": { response: ScopeActivationOutput },
  "GET /state": { response: StateOutput },
  "POST /memory/events": { request: MemoryEventInput, response: MemoryEventOutput },
  "POST /memory/retrieve": { request: RetrieveInput, response: RetrieveOutput },
  "POST /memory/answer": { request: AnswerInput, response: AnswerOutput },
  "POST /memory/digest": { request: DigestRequestInput, response: DigestEnqueueOutput },
  "POST /memory/runtime/turn": { request: RuntimeTurnInput, response: RuntimeTurnOutput },
  "POST /reminders": { request: ReminderCreateInput, response: ReminderOutput },
  "GET /reminders": { response: ReminderListOutput },
  "POST /reminders/:id/cancel": { response: ReminderCancelOutput },
  "GET /health": { response: HealthOutput }
} as const;
```

- [ ] **Step 2: Add the `zod-to-json-schema` dependency to apps/api**

Run: `pnpm --filter @statecore/api add zod-to-json-schema`
Expected: `apps/api/package.json` gains `zod-to-json-schema` under dependencies; lockfile updates. (It is already present transitively in `pnpm-lock.yaml`, so resolution is fast.)

- [ ] **Step 3: Write the snapshot test**

Create `apps/api/src/public-v1-contract.snapshot.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ZodTypeAny } from "zod";
import { PublicV1Contracts } from "@statecore/contracts";

describe("public /v1 contract surface (frozen)", () => {
  it("has exactly the 13 designated endpoints", () => {
    expect(Object.keys(PublicV1Contracts).sort()).toEqual(
      [
        "GET /health",
        "GET /reminders",
        "GET /scopes",
        "GET /state",
        "POST /memory/answer",
        "POST /memory/digest",
        "POST /memory/events",
        "POST /memory/retrieve",
        "POST /memory/runtime/turn",
        "POST /reminders",
        "POST /reminders/:id/cancel",
        "POST /scopes",
        "POST /scopes/:id/active"
      ].sort()
    );
  });

  it("matches the committed JSON-schema snapshot", () => {
    const surface: Record<string, { request?: unknown; response: unknown }> = {};
    for (const [endpoint, io] of Object.entries(PublicV1Contracts)) {
      const entry: { request?: unknown; response: unknown } = {
        response: zodToJsonSchema(io.response as ZodTypeAny, { target: "jsonSchema7" })
      };
      if ("request" in io && io.request) {
        entry.request = zodToJsonSchema(io.request as ZodTypeAny, { target: "jsonSchema7" });
      }
      surface[endpoint] = entry;
    }
    expect(surface).toMatchSnapshot();
  });
});
```

- [ ] **Step 4: Generate the snapshot and verify it passes**

Run: `pnpm --filter @statecore/api test -- public-v1-contract`
Expected: PASS. On first run vitest writes
`apps/api/src/__snapshots__/public-v1-contract.snapshot.test.ts.snap` containing all 13 endpoints. Open it and confirm it lists the 13 endpoint keys.

- [ ] **Step 5: Prove the snapshot catches a breaking change**

Temporarily edit `packages/contracts/src/index.ts` to remove a field from a public schema (e.g. delete the `answer:` line from `AnswerOutput`), re-run `pnpm --filter @statecore/api test -- public-v1-contract`, and confirm the snapshot test now FAILS with a diff. Then restore the field exactly and re-run to confirm PASS. Record both in the report; do NOT commit the temporary edit (`git diff packages/contracts/src/index.ts` must show only the `PublicV1Contracts` addition).

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm --filter @statecore/api exec tsc --noEmit`
Expected: no type errors.

```bash
git add packages/contracts/src/index.ts apps/api/package.json pnpm-lock.yaml \
  apps/api/src/public-v1-contract.snapshot.test.ts \
  apps/api/src/__snapshots__/public-v1-contract.snapshot.test.ts.snap
git commit -m "$(cat <<'EOF'
feat(contracts): add PublicV1Contracts registry + JSON-schema snapshot guard

PublicV1Contracts is the single source of truth for the frozen /v1 surface
(13 endpoints). A zod-to-json-schema snapshot test in apps/api fails on any
change to the surface, so removals/renames/retypes/required-additions are
caught in CI; additive-optional changes are accepted by regenerating (-u).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Dual-mount the 13 public handlers at `/v1` + routing test

**Files:**
- Modify: `apps/api/src/scopes.controller.ts` (lines 13, 26, 40, 72)
- Modify: `apps/api/src/memory.controller.ts` (lines 504, 620, 820, 845, 881)
- Modify: `apps/api/src/reminders.controller.ts` (lines 11, 35, 59)
- Modify: `apps/api/src/health.controller.ts` (line 39)
- Modify: `apps/api/src/auth.middleware.ts` (line 15)
- Create: `apps/api/src/test/v1-routing.integration.test.ts`

**Interfaces:**
- Consumes: nothing new. Each NestJS route decorator accepts `string | string[]`; passing `["<legacy>", "/v1<legacy>"]` mounts the same handler at both paths.

- [ ] **Step 1: Write the failing routing test**

Create `apps/api/src/test/v1-routing.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { createTestApp } from "./setup";
import { clearDatabase } from "./helpers";

const USER = "v1-user";

describe("/v1 dual-mount routing", () => {
  let app: INestApplication;
  beforeAll(async () => { app = await createTestApp(); }, 30000);
  beforeEach(async () => { await clearDatabase(); });
  afterAll(async () => { await app.close(); });

  it("serves health at both /health and /v1/health without auth", async () => {
    const legacy = await request(app.getHttpServer()).get("/health");
    const v1 = await request(app.getHttpServer()).get("/v1/health");
    expect(legacy.status).toBe(200);
    expect(v1.status).toBe(200);
  });

  it("serves scope create + list under /v1", async () => {
    const created = await request(app.getHttpServer())
      .post("/v1/scopes").set("x-user-id", USER).send({ name: "v1-scope" });
    expect(created.status).toBe(201);

    const listed = await request(app.getHttpServer())
      .get("/v1/scopes").set("x-user-id", USER);
    expect(listed.status).toBe(200);
    expect(listed.body.items).toHaveLength(1);
  });

  it("serves the same scope to both legacy and /v1 paths", async () => {
    await request(app.getHttpServer())
      .post("/scopes").set("x-user-id", USER).send({ name: "shared" });
    const viaV1 = await request(app.getHttpServer())
      .get("/v1/scopes").set("x-user-id", USER);
    expect(viaV1.body.items).toHaveLength(1);
  });

  it("does NOT mount excluded internal endpoints under /v1", async () => {
    // working-state is internal; legacy path exists, /v1 path must 404.
    const v1 = await request(app.getHttpServer())
      .get("/v1/memory/working-state?scopeId=00000000-0000-0000-0000-000000000000")
      .set("x-user-id", USER);
    expect(v1.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @statecore/api test -- v1-routing`
Expected: FAIL — `/v1/health` and `/v1/scopes` are not mounted yet (404), so the health and scope assertions fail.

- [ ] **Step 3: Dual-mount the scopes handlers**

In `apps/api/src/scopes.controller.ts`:
- line 13: `@Post("/scopes")` → `@Post(["/scopes", "/v1/scopes"])`
- line 26: `@Get("/scopes")` → `@Get(["/scopes", "/v1/scopes"])`
- line 40: `@Post("/scopes/:id/active")` → `@Post(["/scopes/:id/active", "/v1/scopes/:id/active"])`
- line 72: `@Get("/state")` → `@Get(["/state", "/v1/state"])`

- [ ] **Step 4: Dual-mount the memory handlers**

In `apps/api/src/memory.controller.ts`:
- line 504: `@Post("/memory/events")` → `@Post(["/memory/events", "/v1/memory/events"])`
- line 620: `@Post("/memory/digest")` → `@Post(["/memory/digest", "/v1/memory/digest"])`
- line 820: `@Post("/memory/retrieve")` → `@Post(["/memory/retrieve", "/v1/memory/retrieve"])`
- line 845: `@Post("/memory/answer")` → `@Post(["/memory/answer", "/v1/memory/answer"])`
- line 881: `@Post("/memory/runtime/turn")` → `@Post(["/memory/runtime/turn", "/v1/memory/runtime/turn"])`

- [ ] **Step 5: Dual-mount the reminders + health handlers**

In `apps/api/src/reminders.controller.ts`:
- line 11: `@Post("/reminders")` → `@Post(["/reminders", "/v1/reminders"])`
- line 35: `@Get("/reminders")` → `@Get(["/reminders", "/v1/reminders"])`
- line 59: `@Post("/reminders/:id/cancel")` → `@Post(["/reminders/:id/cancel", "/v1/reminders/:id/cancel"])`

In `apps/api/src/health.controller.ts`:
- line 39: `@Get("/health")` → `@Get(["/health", "/v1/health"])`

- [ ] **Step 6: Skip auth for `/v1/health` too**

In `apps/api/src/auth.middleware.ts`, replace line 15's condition:

```ts
  const path = req.originalUrl.split("?")[0];
  if (path === "/health" || path === "/v1/health") {
    return next();
  }
```

- [ ] **Step 7: Run the routing test to verify it passes**

Run: `pnpm --filter @statecore/api test -- v1-routing`
Expected: PASS (all 4 cases: health both paths no-auth, /v1 scope create+list, shared state, excluded endpoint 404 under /v1).

- [ ] **Step 8: Full api suite + typecheck (no regression)**

Run: `pnpm --filter @statecore/api test && pnpm --filter @statecore/api exec tsc --noEmit`
Expected: PASS / no type errors.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/scopes.controller.ts apps/api/src/memory.controller.ts \
  apps/api/src/reminders.controller.ts apps/api/src/health.controller.ts \
  apps/api/src/auth.middleware.ts apps/api/src/test/v1-routing.integration.test.ts
git commit -m "$(cat <<'EOF'
feat(api): dual-mount the public subset at /v1 (legacy paths preserved)

The 13 public handlers now answer at both their legacy path and a /v1-prefixed
path via the route decorator's array form, so the hosted/GPT layers can depend
on /v1 while peripherals keep using legacy paths unchanged. Auth now also skips
/v1/health. Internal endpoints stay legacy-only. Routing integration test added.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Document the `/v1` public surface in `docs/api.md`

**Files:**
- Modify: `docs/api.md` (append a `## API versioning (/v1)` section)

**Interfaces:**
- Consumes: the 13-endpoint subset and freeze rules from this plan's Global Constraints.

- [ ] **Step 1: Read the current docs/api.md head to match its style**

Run: `sed -n '1,30p' docs/api.md`
Expected: see the existing heading style/format to match.

- [ ] **Step 2: Append the `/v1` section**

Append to `docs/api.md`:

```markdown
## API versioning (/v1)

StateCore exposes a **frozen public API subset** under the `/v1` prefix. External
layers (the hosted version, the GPT-API integration layer) should depend ONLY on
`/v1`. Every `/v1` endpoint is also served at its legacy unversioned path for
backward compatibility; reference integrations (`cli`, `adapter-mcp`,
`adapter-telegram`) continue to use the legacy paths.

### Frozen public subset

| Method | `/v1` path |
|---|---|
| POST | `/v1/scopes` |
| GET | `/v1/scopes` |
| POST | `/v1/scopes/:id/active` |
| GET | `/v1/state` |
| POST | `/v1/memory/events` |
| POST | `/v1/memory/retrieve` |
| POST | `/v1/memory/answer` |
| POST | `/v1/memory/digest` |
| POST | `/v1/memory/runtime/turn` |
| POST | `/v1/reminders` |
| GET | `/v1/reminders` |
| POST | `/v1/reminders/:id/cancel` |
| GET | `/v1/health` |

The source of truth is `PublicV1Contracts` in `@statecore/contracts`, guarded by
the snapshot test `apps/api/src/public-v1-contract.snapshot.test.ts`.

### Compatibility rules (additively-compatible freeze)

For the public subset:

1. Existing fields are never removed, renamed, or retyped.
2. New fields are always optional — never newly required.
3. Enums are open sets; clients must tolerate unknown values.

The snapshot test fails on any change to the surface. An intentional,
additive-only change is accepted by regenerating the snapshot
(`pnpm --filter @statecore/api test -- public-v1-contract -u`). A
removal/rename/retype/required-addition is a breaking change — do not ship it
under `/v1`.

### Not part of `/v1`

All other endpoints (diagnostics, `fast-view`, `layer-status`, `working-state`,
`stable-state`, `state/history`, `relationship-context`, `check-contradiction`,
`embed/backfill`, `digest/rebuild`, `digests`, the `GET /memory/events` list,
`scopes/:id/webhook`, demo, metrics) are **internal**: unversioned, legacy-path
only, and may change without notice.
```

- [ ] **Step 3: Commit**

```bash
git add docs/api.md
git commit -m "$(cat <<'EOF'
docs(api): document the frozen /v1 public subset and compatibility rules

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- `/v1` subset defined + dual-mount mechanism → Task 3 (+ Global Constraints list). ✓
- Don't break peripherals → legacy paths preserved (path arrays keep legacy first); no peripheral files touched. ✓
- `RetrieveInput.query` fix → Task 1. ✓
- `PublicV1Contracts` source of truth + snapshot test → Task 2. ✓
- Freeze discipline documented → Task 4. ✓
- Internal endpoints stay unversioned/changeable → Task 3 (left single-mounted) + Task 4 (documented). ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code/commands. ✓

**Type consistency:** `PublicV1Contracts` is `Record<"<METHOD> <path>", { request?: ZodType; response: ZodType }>` in Task 2 (definition) and consumed identically by the snapshot test (Task 2). The 13 endpoint keys in the registry, the `has exactly the 13` test, and the Task 3 route edits, and the Task 4 docs table all list the same 13 paths. ✓

---

### Task 5: Narrow frozen response schemas for retrieve/answer/runtime-turn (final-review #1) + dep cleanup

The final whole-branch review flagged that freezing `POST /memory/retrieve`, `/memory/answer`, `/memory/runtime/turn` also freezes their diagnostic/ranking internals (labeled "Debug surface", still evolving per roadmap). Decision: narrow the FROZEN response schemas for these three to their stable top-level fields. The HTTP responses are unchanged (the shared handlers still return the full objects); only what `PublicV1Contracts` declares as frozen — and what the snapshot guards — is trimmed, so diagnostic sub-objects can evolve without a breaking-change dance. Also moves the test-only `zod-to-json-schema` dep to devDependencies.

**Files:**
- Modify: `packages/contracts/src/index.ts` (3 `PublicV1Contracts` entries)
- Modify: `apps/api/package.json` (move `zod-to-json-schema` to devDependencies) + `pnpm-lock.yaml`
- Regenerate: `apps/api/src/__snapshots__/public-v1-contract.snapshot.test.ts.snap`
- Modify: `docs/api.md` (note diagnostic sub-objects are returned but not frozen)

**Interfaces:**
- Consumes: existing `RetrieveOutput`, `AnswerOutput`, `RuntimeTurnOutput` (Zod objects support `.pick()`/`.omit()`, returning new ZodObjects that `zod-to-json-schema` serializes).

- [ ] **Step 1: Narrow the three registry entries**

In `packages/contracts/src/index.ts`, inside `PublicV1Contracts`, replace the three entries and add an explanatory comment:

```ts
  // Narrowed to stable top-level fields: the diagnostic/ranking sub-objects
  // (RetrieveOutput.retrieval, AnswerOutput.evidence, RuntimeTurnOutput
  // layerAlignment/retrievalPlan/version/notes/warnings/evidence) are still
  // returned in the HTTP response but are intentionally NOT part of the frozen
  // /v1 contract, so they can evolve without a breaking change.
  "POST /memory/retrieve": { request: RetrieveInput, response: RetrieveOutput.omit({ retrieval: true }) },
  "POST /memory/answer": { request: AnswerInput, response: AnswerOutput.pick({ answer: true }) },
  "POST /memory/runtime/turn": { request: RuntimeTurnInput, response: RuntimeTurnOutput.pick({ answer: true, answerMode: true, writeTier: true, digestTriggered: true }) },
```

(Leave the other 10 entries unchanged. Requests stay full — accepting more input later is additive.)

- [ ] **Step 2: Move `zod-to-json-schema` to devDependencies**

Run: `pnpm --filter @statecore/api remove zod-to-json-schema && pnpm --filter @statecore/api add -D zod-to-json-schema`
Expected: `apps/api/package.json` now lists `zod-to-json-schema` under `devDependencies`, not `dependencies`; lockfile updates.

- [ ] **Step 3: Regenerate the snapshot (intentional, additive-removal of frozen fields)**

Run: `pnpm --filter @statecore/api test -- public-v1-contract -u`
Expected: PASS; the snapshot file updates. Open
`apps/api/src/__snapshots__/public-v1-contract.snapshot.test.ts.snap` and confirm:
- `POST /memory/runtime/turn` response now lists only `answer`, `answerMode`, `writeTier`, `digestTriggered` (no `layerAlignment`, no `retrievalPlan`).
- `POST /memory/retrieve` response no longer has `retrieval`.
- `POST /memory/answer` response has only `answer` (no `evidence`).

- [ ] **Step 4: Run the test normally + typecheck**

Run: `pnpm --filter @statecore/api test -- public-v1-contract && pnpm --filter @statecore/api exec tsc --noEmit`
Expected: PASS (both the 13-key test and the snapshot test); no type errors.

- [ ] **Step 5: Note the narrowing in docs/api.md**

In `docs/api.md`, under the `## API versioning (/v1)` section's "Compatibility rules" subsection, append:

```markdown
> **Diagnostic fields are not frozen.** `POST /v1/memory/retrieve`,
> `/v1/memory/answer`, and `/v1/memory/runtime/turn` return additional
> diagnostic/ranking fields (e.g. `retrieval`, `evidence`, `layerAlignment`,
> `retrievalPlan`) that are **not** part of the frozen contract and may change
> without notice. Only the stable top-level fields of these endpoints are frozen.
```

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/index.ts apps/api/package.json pnpm-lock.yaml \
  apps/api/src/__snapshots__/public-v1-contract.snapshot.test.ts.snap docs/api.md
git commit -m "$(cat <<'EOF'
refactor(contracts): freeze only stable top-level fields for retrieve/answer/turn

Narrows the /v1 frozen response schemas for retrieve, answer, and runtime/turn
to their stable top-level fields; diagnostic/ranking sub-objects are still
returned but excluded from the frozen contract so they can evolve without a
breaking change (final-review #1). Also moves test-only zod-to-json-schema to
devDependencies and documents the non-frozen diagnostic fields.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```
