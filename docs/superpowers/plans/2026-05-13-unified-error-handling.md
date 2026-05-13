# Unified Error Handling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace all `return { error: "..." }` patterns in API controllers with proper NestJS exceptions so errors return correct HTTP status codes.

**Architecture:** Add a global `GlobalErrorFilter` that serializes `HttpException` subclasses to `{ error: message }` format with correct status codes. Then replace 33 controller `return { error }` calls with `throw new NotFoundException/BadRequestException`. Response body format stays `{ error: "..." }` — only HTTP status codes change.

**Tech Stack:** NestJS (`@nestjs/common` exceptions, `ExceptionFilter`), Vitest for filter unit tests.

---

## File Map

| File | Change |
|------|--------|
| `apps/api/src/error.filter.ts` | Create — global exception filter |
| `apps/api/src/error.filter.test.ts` | Create — unit tests for filter |
| `apps/api/src/main.ts` | Modify — register filter |
| `apps/api/src/memory.controller.ts` | Modify — 31 return→throw replacements + add NotFoundException import |
| `apps/api/src/scopes.controller.ts` | Modify — 1 return→throw + add NotFoundException import |
| `apps/api/src/reminders.controller.ts` | Modify — 1 return→throw + add NotFoundException import |

---

## Task 1: GlobalErrorFilter + registration

**Files:**
- Modify: `apps/api/package.json` — add vitest
- Create: `apps/api/src/error.filter.ts`
- Create: `apps/api/src/error.filter.test.ts`
- Modify: `apps/api/src/main.ts`

- [ ] **Step 1: Add vitest to api package**

`apps/api` has no test runner. Add it:

```bash
cd apps/api && pnpm add -D vitest@^2.1.8
```

Then add `"test": "vitest run"` to scripts in `apps/api/package.json`:

```json
{
  "scripts": {
    "dev": "tsx watch src/main.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/main.js",
    "test": "vitest run"
  }
}
```

- [ ] **Step 2: Write the failing test**

Create `apps/api/src/error.filter.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NotFoundException, BadRequestException, HttpException } from "@nestjs/common";
import type { ArgumentsHost } from "@nestjs/common";
import { GlobalErrorFilter } from "./error.filter";

function makeHost(): { host: ArgumentsHost; status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const host = {
    switchToHttp: () => ({ getResponse: () => ({ status, json: json as unknown }) })
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

describe("GlobalErrorFilter", () => {
  let filter: GlobalErrorFilter;

  beforeEach(() => {
    filter = new GlobalErrorFilter();
  });

  it("maps NotFoundException to 404 with error message", () => {
    const { host, status, json } = makeHost();
    filter.catch(new NotFoundException("Scope not found"), host);
    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({ error: "Scope not found" });
  });

  it("maps BadRequestException to 400 with error message", () => {
    const { host, status, json } = makeHost();
    filter.catch(new BadRequestException("scopeId required"), host);
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({ error: "scopeId required" });
  });

  it("maps unknown errors to 500 with generic message", () => {
    const { host, status, json } = makeHost();
    filter.catch(new Error("database exploded"), host);
    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({ error: "Internal server error" });
  });

  it("maps generic HttpException to correct status", () => {
    const { host, status, json } = makeHost();
    filter.catch(new HttpException("custom error", 422), host);
    expect(status).toHaveBeenCalledWith(422);
    expect(json).toHaveBeenCalledWith({ error: "custom error" });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd apps/api && pnpm test
```
Expected: FAIL — `GlobalErrorFilter` not found.

- [ ] **Step 4: Create error.filter.ts**

```typescript
import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from "@nestjs/common";
import type { Response } from "express";

@Catch()
export class GlobalErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    if (exception instanceof HttpException) {
      res.status(exception.getStatus()).json({ error: exception.message });
    } else {
      res.status(500).json({ error: "Internal server error" });
    }
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd apps/api && pnpm test
```
Expected: 4 tests PASS.

- [ ] **Step 6: Register filter in main.ts**

In `apps/api/src/main.ts`, add import and registration. Change the `bootstrap` function:

```typescript
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { Request, Response, NextFunction } from "express";
import { AppModule } from "./app.module";
import { apiEnv } from "./env";
import { GlobalErrorFilter } from "./error.filter";
```

Then in `bootstrap()`, add the filter before `app.listen`:

```typescript
async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: ["log", "error", "warn"] });
  app.use(rateLimitMiddleware);
  app.useGlobalFilters(new GlobalErrorFilter());
  await app.listen(apiEnv.port);
}
```

- [ ] **Step 7: Commit**

```bash
git add apps/api/package.json apps/api/src/error.filter.ts apps/api/src/error.filter.test.ts apps/api/src/main.ts pnpm-lock.yaml
git commit -m "feat(api): add GlobalErrorFilter for consistent error responses"
```

---

## Task 2: memory.controller.ts replacements

**Files:**
- Modify: `apps/api/src/memory.controller.ts`

There are 2 repeating error patterns. Replace them all using exact string matching:

- [ ] **Step 1: Add NotFoundException to import**

Current line 1:
```typescript
import { BadRequestException, Body, Controller, Get, Inject, Param, Post, Query, Req } from "@nestjs/common";
```

Replace with:
```typescript
import { BadRequestException, Body, Controller, Get, Inject, NotFoundException, Param, Post, Query, Req } from "@nestjs/common";
```

- [ ] **Step 2: Replace all "Scope not found" returns**

Find every instance of:
```typescript
return { error: "Scope not found" };
```

Replace each with:
```typescript
throw new NotFoundException("Scope not found");
```

There are 16 instances in this file (lines 490, 523, 552, 566, 591, 617, 636, 656, 680, 712, 729, 749, 772, 808, and 2 more). Use find-and-replace-all in the editor or run:

```bash
# From repo root — verify count first
grep -n 'return { error: "Scope not found" }' apps/api/src/memory.controller.ts | wc -l
```
Expected output: `16`

Then replace all occurrences.

- [ ] **Step 3: Replace all "scopeId required" returns**

Find every instance of:
```typescript
return { error: "scopeId required" };
```

Replace each with:
```typescript
throw new BadRequestException("scopeId required");
```

Verify count:
```bash
grep -n 'return { error: "scopeId required" }' apps/api/src/memory.controller.ts | wc -l
```
Expected output: `8`

- [ ] **Step 4: Replace the "key required" return**

Find:
```typescript
return { error: "key required for document events" };
```

Replace with:
```typescript
throw new BadRequestException("key required for document events");
```

- [ ] **Step 5: Verify no error returns remain in memory.controller.ts**

```bash
grep -n 'return { error:' apps/api/src/memory.controller.ts
```
Expected: no output (zero matches).

- [ ] **Step 6: Verify TypeScript compiles**

```bash
cd apps/api && pnpm build
```
Expected: clean build, no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/memory.controller.ts
git commit -m "feat(api): replace error returns with exceptions in memory.controller"
```

---

## Task 3: scopes.controller.ts + reminders.controller.ts

**Files:**
- Modify: `apps/api/src/scopes.controller.ts`
- Modify: `apps/api/src/reminders.controller.ts`

- [ ] **Step 1: Fix scopes.controller.ts**

Change import line 1 from:
```typescript
import { Body, Controller, Get, Inject, Param, Post, Req } from "@nestjs/common";
```
To:
```typescript
import { Body, Controller, Get, Inject, NotFoundException, Param, Post, Req } from "@nestjs/common";
```

Change line 42 from:
```typescript
    return { error: "Scope not found" };
```
To:
```typescript
    throw new NotFoundException("Scope not found");
```

- [ ] **Step 2: Fix reminders.controller.ts**

Change import line 1 from:
```typescript
import { Body, Controller, Get, Inject, Param, Post, Query, Req } from "@nestjs/common";
```
To:
```typescript
import { Body, Controller, Get, Inject, NotFoundException, Param, Post, Query, Req } from "@nestjs/common";
```

Change line 16 from:
```typescript
      if (!scope) return { error: "Scope not found" };
```
To:
```typescript
      if (!scope) throw new NotFoundException("Scope not found");
```

- [ ] **Step 3: Verify no error returns remain anywhere**

```bash
grep -rn 'return { error:' apps/api/src/
```
Expected: zero matches.

- [ ] **Step 4: Full build + test**

```bash
cd apps/api && pnpm build && pnpm test
```
Expected: clean build, all tests pass (including the 4 filter tests from Task 1).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/scopes.controller.ts apps/api/src/reminders.controller.ts
git commit -m "feat(api): replace error returns with exceptions in scopes and reminders controllers"
```
