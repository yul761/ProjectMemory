# W3 — Quality & Observability Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make API errors observable and correctly-coded (invalid input → 400, unexpected → logged 500), stop swallowing background-queue failures, add unit tests for two untested core files, and close the W2 test-tail follow-ups.

**Architecture:** A single `ZodError` branch in the existing `GlobalErrorFilter` maps all validation failures to 400 and logs unexpected errors via the existing `@statecore/core` pino `logger`; the same logger replaces the silent queue `.catch(() => {})`. Two pure-unit test files cover `model-provider.ts` and `working-memory.service.ts`. Small W2 follow-ups round it out.

**Tech Stack:** TypeScript (strict), NestJS, Zod, pino (`logger` from `@statecore/core`), vitest, supertest.

## Global Constraints

- Core readiness scope is `packages/*`, `apps/api`, `apps/worker` only — do not modify `apps/cli`, `apps/adapter-telegram`, `apps/adapter-mcp`, `apps/demo-web`.
- No `any` (repo lints `@typescript-eslint/no-explicit-any`). In tests, type mocks precisely or with `unknown`.
- Use the existing logger: `import { logger } from "@statecore/core"` (pino). Do not add a new logging library.
- ZodError → HTTP 400, body `{ error: "Validation failed", details: <issues> }`. HttpException branch unchanged. Unexpected (500) path calls `logger.error`.
- Keep queue enqueues non-blocking for ingest (still fire-and-forget, just logged on failure).
- Test output must be pristine — mock `logger.error` where a tested path logs, so no stray pino lines print.
- Conventional-commit messages, each ending with exactly:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Integration tests need the provisioned Postgres test DB (`statecore_test`); see Task 5 prerequisite.

## File Structure

- `apps/api/src/error.filter.ts` — add ZodError→400 branch + 500 logging (Task 1). (Modify)
- `apps/api/src/error.filter.test.ts` — ZodError + logging cases (Task 1). (Modify)
- `apps/api/src/memory.controller.ts` — log queue enqueue failures (Task 2). (Modify)
- `packages/core/src/model-provider.test.ts` — unit tests (Task 3). (Create)
- `packages/core/src/working-memory.service.test.ts` — unit tests (Task 4). (Create)
- `apps/api/src/reminders.controller.ts` — wrap responses in `parseOutput` (Task 5). (Modify)
- `apps/api/src/test/retrieve-no-query.integration.test.ts` — strengthen assertion (Task 5). (Modify)
- `apps/api/src/test/v1-routing.integration.test.ts` — more excluded-endpoint cases (Task 5). (Modify)

---

### Task 1: `GlobalErrorFilter` — ZodError → 400 + log unexpected 500s

**Files:**
- Modify: `apps/api/src/error.filter.ts`
- Test: `apps/api/src/error.filter.test.ts`

**Interfaces:**
- Produces: `GlobalErrorFilter` now returns 400 `{ error: "Validation failed", details }` for `ZodError`, and calls `logger.error({ err }, "Unhandled exception")` on the 500 path.

- [ ] **Step 1: Add failing tests for ZodError→400 and 500-logging**

In `apps/api/src/error.filter.test.ts`, add `z`, `ZodError`, and the core `logger` to imports, mock `logger.error` in `beforeEach` (keeps output pristine), and add two tests:

```ts
import { z, ZodError } from "zod";
import { logger } from "@statecore/core";
```

In the `describe("GlobalErrorFilter", ...)` block, change `beforeEach` to also spy on the logger, and add an `afterEach` restore:

```ts
  beforeEach(() => {
    filter = new GlobalErrorFilter();
    vi.spyOn(logger, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps ZodError to 400 with validation details", () => {
    const { host, status, json } = makeHost();
    const parsed = z.object({ scopeId: z.string() }).safeParse({});
    const error = (parsed as { success: false; error: ZodError }).error;
    filter.catch(error, host);
    expect(status).toHaveBeenCalledWith(400);
    const payload = json.mock.calls[0][0] as { error: string; details: unknown[] };
    expect(payload.error).toBe("Validation failed");
    expect(Array.isArray(payload.details)).toBe(true);
    expect(payload.details.length).toBeGreaterThanOrEqual(1);
  });

  it("logs unexpected (500) errors via logger.error", () => {
    const { host } = makeHost();
    filter.catch(new Error("database exploded"), host);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @statecore/api test -- error.filter`
Expected: FAIL — ZodError currently hits the 500 branch (status 500, not 400); `logger.error` is never called.

- [ ] **Step 3: Implement the filter changes**

Replace `apps/api/src/error.filter.ts` with:

```ts
import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from "@nestjs/common";
import type { Response } from "express";
import { ZodError } from "zod";
import { logger } from "@statecore/core";

@Catch()
export class GlobalErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    if (exception instanceof ZodError) {
      res.status(400).json({ error: "Validation failed", details: exception.issues });
      return;
    }
    if (exception instanceof HttpException) {
      res.status(exception.getStatus()).json({ error: exception.message });
      return;
    }
    logger.error({ err: exception }, "Unhandled exception");
    res.status(500).json({ error: "Internal server error" });
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @statecore/api test -- error.filter`
Expected: PASS (all GlobalErrorFilter tests, including the two new ones; output pristine — no stray pino lines).

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @statecore/api exec tsc --noEmit`
Expected: no type errors.

```bash
git add apps/api/src/error.filter.ts apps/api/src/error.filter.test.ts
git commit -m "$(cat <<'EOF'
fix(api): map ZodError to 400 and log unexpected errors in GlobalErrorFilter

Invalid request bodies (unguarded Zod .parse() in controllers) previously
surfaced as HTTP 500; they now return 400 with validation details. Unexpected
errors are logged via the core pino logger instead of being silently dropped.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Log background-queue enqueue failures

**Files:**
- Modify: `apps/api/src/memory.controller.ts:523-524` (and its `@statecore/core` import)

**Interfaces:**
- Consumes: `logger` from `@statecore/core`.

- [ ] **Step 1: Add `logger` to the core import**

In `apps/api/src/memory.controller.ts`, the import block ending at line 44 imports from `@statecore/core`. Add `logger` to that import list (alphabetical/with the others).

- [ ] **Step 2: Replace the silent catches**

Replace lines 523-524:

```ts
    embedQueue.add("embed_event", { eventId: event.id, scopeId: input.scopeId })
      .catch((err) => logger.error({ err, eventId: event.id }, "embed_event enqueue failed"));
    classifyQueue.add("classify_event", { eventId: event.id, scopeId: input.scopeId })
      .catch((err) => logger.error({ err, eventId: event.id }, "classify_event enqueue failed"));
```

- [ ] **Step 3: Verify no silent catch remains + typecheck**

Run: `grep -n "catch(() => {})" apps/api/src/memory.controller.ts`
Expected: no output (the two silent catches are gone).

Run: `pnpm --filter @statecore/api exec tsc --noEmit`
Expected: no type errors.

(This is a logging-only change with no isolated unit seam — the singleton `embedQueue`/`classifyQueue` are module imports; behavior is verified by the grep + typecheck. The ingest path stays non-blocking.)

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/memory.controller.ts
git commit -m "$(cat <<'EOF'
fix(api): log background-queue enqueue failures instead of swallowing them

embed_event / classify_event enqueues stay fire-and-forget (non-blocking for
ingest) but now log via the core pino logger on failure, so dropped embedding/
classification work is visible.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Unit tests for `model-provider.ts`

**Files:**
- Create: `packages/core/src/model-provider.test.ts`

**Interfaces:**
- Consumes (from `./model-provider`): `createModelProvider`, `createChatModelClient`, `createEmbeddingModelClient`, `LlmClient`, `EmbeddingClient`. `LlmClient.chat(messages: { role: "system" | "user"; content: string }[], options?)`; `EmbeddingClient.embed(input: string[])`.

- [ ] **Step 1: Write the failing test file**

Create `packages/core/src/model-provider.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createModelProvider,
  createChatModelClient,
  createEmbeddingModelClient,
  LlmClient,
  EmbeddingClient
} from "./model-provider";

const baseConfig = {
  provider: "openai-compatible",
  apiKey: "k",
  baseUrl: "http://example.test",
  model: "m",
  embeddingModel: "e"
};

describe("createModelProvider", () => {
  it("returns null for null/undefined config", () => {
    expect(createModelProvider(null)).toBeNull();
    expect(createModelProvider(undefined)).toBeNull();
  });

  it("returns a factory with chat, structuredOutput and embedding", () => {
    const provider = createModelProvider(baseConfig);
    expect(provider).not.toBeNull();
    expect(provider?.provider).toBe("openai-compatible");
    expect(typeof provider?.chat.chat).toBe("function");
    expect(typeof provider?.structuredOutput.chat).toBe("function");
    expect(provider?.embedding).not.toBeNull();
  });

  it("leaves embedding null when no embeddingModel is configured", () => {
    const provider = createModelProvider({ ...baseConfig, embeddingModel: undefined });
    expect(provider?.embedding).toBeNull();
  });
});

describe("client factories", () => {
  it("createChatModelClient returns null for null config", () => {
    expect(createChatModelClient(null)).toBeNull();
  });

  it("createEmbeddingModelClient returns null when model is empty", () => {
    expect(createEmbeddingModelClient({ baseUrl: "http://example.test", model: "" })).toBeNull();
  });
});

describe("LlmClient.chat", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns the message content on a successful response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "hello" } }] })
    }));
    const client = new LlmClient({ baseUrl: "http://example.test", model: "m" });
    await expect(client.chat([{ role: "user", content: "hi" }])).resolves.toBe("hello");
  });

  it("throws after retries when the response is not ok", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "boom"
    }));
    const client = new LlmClient({ baseUrl: "http://example.test", model: "m" });
    await expect(client.chat([{ role: "user", content: "hi" }])).rejects.toThrow(/LLM error 500/);
  }, 10000);
});

describe("EmbeddingClient.embed", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns vectors on a successful response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.1, 0.2] }] })
    }));
    const client = new EmbeddingClient({ baseUrl: "http://example.test", model: "e" });
    await expect(client.embed(["hi"])).resolves.toEqual([[0.1, 0.2]]);
  });
});
```

Note: the two-success-path tests are instant. The not-ok test exercises the 3× retry/backoff (~1.8s), hence the 10000ms per-test timeout.

- [ ] **Step 2: Run to verify it fails (file/exports resolve, behaviour asserted)**

Run: `pnpm --filter @statecore/core test -- model-provider`
Expected: the suite runs (no implementation to write — this is characterization of existing code). If any export name or `chat` signature differs from the file, the test fails to compile/run — STOP and reconcile against `packages/core/src/model-provider.ts` (do not invent names).

- [ ] **Step 3: Confirm green + typecheck**

Run: `pnpm --filter @statecore/core test -- model-provider && pnpm --filter @statecore/core exec tsc --noEmit`
Expected: PASS / no type errors. (These tests characterize already-correct code, so they should pass once they line up with the real signatures.)

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/model-provider.test.ts
git commit -m "$(cat <<'EOF'
test(core): cover model-provider factory + client success/error paths

createModelProvider null/factory/embedding-null branches, the chat and
embedding client success paths (mocked fetch), and the LlmClient not-ok retry
failure. Closes a core-coverage gap.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Unit tests for `working-memory.service.ts`

**Files:**
- Create: `packages/core/src/working-memory.service.test.ts`

**Interfaces:**
- Consumes (from `./working-memory.service`): `WorkingMemoryService`, types `WorkingMemoryRepo`, `WorkingMemorySnapshot`. `WorkingMemoryService(repo, options?)`; `getLatest(scopeId)` → `repo.findLatest`; `updateFromEvents(scopeId, events, scopeGoal?)` extracts state, compiles view, and calls `repo.upsert({ scopeId, version: (prev?.version ?? 0) + 1, state, view })`.

- [ ] **Step 1: Write the failing test file**

Create `packages/core/src/working-memory.service.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { WorkingMemoryService } from "./working-memory.service";
import type { WorkingMemoryRepo, WorkingMemorySnapshot } from "./working-memory.service";

function makeRepo(latest: WorkingMemorySnapshot | null) {
  const findLatest = vi.fn(async (_scopeId: string): Promise<WorkingMemorySnapshot | null> => latest);
  const upsert = vi.fn(
    async (input: Parameters<WorkingMemoryRepo["upsert"]>[0]): Promise<WorkingMemorySnapshot> => ({
      id: "wm1",
      scopeId: input.scopeId,
      version: input.version,
      state: input.state,
      view: input.view,
      createdAt: new Date(0),
      updatedAt: new Date(0)
    })
  );
  const repo: WorkingMemoryRepo = { findLatest, upsert };
  return { repo, findLatest, upsert };
}

describe("WorkingMemoryService", () => {
  it("getLatest delegates to repo.findLatest", async () => {
    const { repo, findLatest } = makeRepo(null);
    const service = new WorkingMemoryService(repo);
    const result = await service.getLatest("scope-1");
    expect(findLatest).toHaveBeenCalledWith("scope-1");
    expect(result).toBeNull();
  });

  it("updateFromEvents starts at version 1 when there is no previous snapshot", async () => {
    const { repo, upsert } = makeRepo(null);
    const service = new WorkingMemoryService(repo);
    const snapshot = await service.updateFromEvents("scope-1", [], "ship it");
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ scopeId: "scope-1", version: 1 })
    );
    expect(snapshot.version).toBe(1);
  });

  it("updateFromEvents applies a refineState option when provided", async () => {
    const { repo, upsert } = makeRepo(null);
    const refineState = vi.fn(async (input: { state: unknown }) => input.state);
    const service = new WorkingMemoryService(repo, { refineState });
    await service.updateFromEvents("scope-1", [], null);
    expect(refineState).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run to verify it runs and passes against existing code**

Run: `pnpm --filter @statecore/core test -- working-memory.service`
Expected: PASS (3 tests). These characterize existing behaviour. If the `refineState` option's input type differs, adjust the mock's parameter type to match `WorkingMemoryServiceOptions["refineState"]` in `working-memory.service.ts` — do not loosen to `any`.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @statecore/core exec tsc --noEmit`
Expected: no type errors.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/working-memory.service.test.ts
git commit -m "$(cat <<'EOF'
test(core): cover WorkingMemoryService delegation + versioning

getLatest delegation, version starts at 1 with no previous snapshot, and the
refineState option is invoked. Closes a core-coverage gap.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: W2 test-tail cleanup + reminders `parseOutput` + loose-end verification

**Prerequisite (one-time, per `apps/api/src/test/README.md`):**
```bash
docker compose -f docker-compose.local.yml up -d postgres
docker exec statecore-postgres-1 psql -U postgres -c "CREATE DATABASE statecore_test"   # ignore error if it already exists
DATABASE_URL="postgresql://postgres:postgres@localhost:5434/statecore_test" \
  pnpm --filter @statecore/db prisma migrate deploy
```

**Files:**
- Modify: `apps/api/src/reminders.controller.ts`
- Modify: `apps/api/src/test/retrieve-no-query.integration.test.ts`
- Modify: `apps/api/src/test/v1-routing.integration.test.ts`

**Interfaces:**
- Consumes: `parseOutput` from `./output`; `ReminderOutput`, `ReminderListOutput`, `ReminderCancelOutput` from `@statecore/contracts`. These schemas match the reminder handlers' existing response shapes (`{id, scopeId, dueAt, text, status, createdAt}`, `{items, nextCursor}`, `{ok}`).

- [ ] **Step 1: Wrap reminder responses in `parseOutput`**

In `apps/api/src/reminders.controller.ts`, extend the imports:

```ts
import { ReminderCreateInput, ReminderStatus, ReminderOutput, ReminderListOutput, ReminderCancelOutput } from "@statecore/contracts";
import { parseOutput } from "./output";
```

Wrap the three returns:

```ts
    return parseOutput(ReminderOutput, {
      id: reminder.id,
      scopeId: reminder.scopeId ?? null,
      dueAt: reminder.dueAt.toISOString(),
      text: reminder.text,
      status: reminder.status,
      createdAt: reminder.createdAt.toISOString()
    });
```

```ts
    return parseOutput(ReminderListOutput, {
      items: items.map((reminder) => ({
        id: reminder.id,
        scopeId: reminder.scopeId ?? null,
        dueAt: reminder.dueAt.toISOString(),
        text: reminder.text,
        status: reminder.status,
        createdAt: reminder.createdAt.toISOString()
      })),
      nextCursor
    });
```

```ts
    return parseOutput(ReminderCancelOutput, { ok });
```

- [ ] **Step 2: Strengthen the retrieve-no-query assertion**

In `apps/api/src/test/retrieve-no-query.integration.test.ts`, guard the scope-create status and assert the ingested event is actually returned. Replace the scope-create line and the final assertions:

```ts
    const scopeRes = await request(app.getHttpServer())
      .post("/scopes").set("x-user-id", USER).send({ name: "s" });
    expect(scopeRes.status).toBe(201);
    const scopeId = scopeRes.body.id as string;
```

```ts
    expect(res.status).toBe(201);
    expect(Array.isArray(res.body.events)).toBe(true);
    expect(res.body.events.length).toBeGreaterThanOrEqual(1);
```

- [ ] **Step 3: Broaden the /v1 exclusion coverage**

In `apps/api/src/test/v1-routing.integration.test.ts`, add to the existing "does NOT mount excluded internal endpoints under /v1" test (after the working-state assertion) two more excluded endpoints:

```ts
    const checkContradiction = await request(app.getHttpServer())
      .get("/v1/memory/check-contradiction").set("x-user-id", USER);
    expect(checkContradiction.status).toBe(404);

    const digestRebuild = await request(app.getHttpServer())
      .get("/v1/memory/digest/rebuild").set("x-user-id", USER);
    expect(digestRebuild.status).toBe(404);
```

- [ ] **Step 4: Run the affected suites**

Run: `pnpm --filter @statecore/api test -- reminders retrieve-no-query v1-routing`
Expected: PASS. If reminder integration tests exist elsewhere, the full run in Step 5 covers them.

- [ ] **Step 5: Verify loose ends + full api suite (no regression)**

Run: `pnpm --filter @statecore/api test`
Expected: PASS (full suite). This run exercises the fact-registry path (via retrieve) and the api integration tests — confirming the "partial" loose ends are functional. Record in the report: full suite green ⇒ fact-registry + integration tests verified working; no code gap found.

Run: `pnpm --filter @statecore/api exec tsc --noEmit`
Expected: no type errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/reminders.controller.ts \
  apps/api/src/test/retrieve-no-query.integration.test.ts \
  apps/api/src/test/v1-routing.integration.test.ts
git commit -m "$(cat <<'EOF'
test(api): close W2 follow-ups — reminders parseOutput + stronger assertions

Wrap reminder responses in parseOutput so the frozen contract is runtime-
enforced; assert the no-query retrieve actually returns events; broaden the /v1
exclusion test to more internal endpoints. Verified fact-registry + integration
tests functional via the full api suite.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- ZodError→400 + 500 logging in GlobalErrorFilter → Task 1. ✓
- Queue-error observability → Task 2. ✓
- model-provider.ts tests → Task 3. ✓
- working-memory.service.ts tests → Task 4. ✓
- W2 follow-ups (retrieve assertion, /v1-exclusion, reminders parseOutput) → Task 5. ✓
- Loose-ends verification (fact-registry, integration) → Task 5 Step 5. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code/commands. ✓

**Type consistency:** `logger` (pino) from `@statecore/core` used identically in Tasks 1 & 2. Reminder schema names (`ReminderOutput`/`ReminderListOutput`/`ReminderCancelOutput`) match the contracts. `LlmClient.chat(messages, options?)` and `EmbeddingClient.embed(string[])` match the file. `WorkingMemoryRepo`/`WorkingMemorySnapshot` types come from the service module. ✓
