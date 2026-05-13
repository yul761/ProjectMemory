# Unified Error Handling Design

**Date:** 2026-05-13
**Status:** Approved

## Problem

24 API endpoints return `{ error: "..." }` with HTTP 200 instead of appropriate 4xx status codes. This is misleading — callers cannot distinguish success from error by status code alone.

## Goal

All API errors return correct HTTP status codes with consistent `{ error: "..." }` response format. No breaking changes to response body format.

## Approach

Two changes:

### 1. Global Exception Filter

New file: `apps/api/src/error.filter.ts`

Catches all `HttpException` subclasses and serializes as `{ error: message }` with correct status code. Catches unknown errors as 500. Registered globally in `apps/api/src/main.ts`.

```typescript
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

Register in `main.ts`:
```typescript
app.useGlobalFilters(new GlobalErrorFilter());
```

### 2. Controller Error Replacements

Replace all direct `return { error: "..." }` with appropriate NestJS exceptions:

| Error message | Exception | HTTP status |
|--------------|-----------|-------------|
| "Scope not found" | `NotFoundException` | 404 |
| "scopeId required" | `BadRequestException` | 400 |
| "key required for document events" | `BadRequestException` | 400 |

**Do not change:**
- `BadRequestException` throws for LLM disabled checks (already correct)
- Auth middleware (returns 401/500 directly — middleware bypasses exception filter)
- Rate limit middleware (returns 429 directly — same reason)

## Files Modified

| File | Change |
|------|--------|
| `apps/api/src/error.filter.ts` | Create — global exception filter |
| `apps/api/src/main.ts` | Register filter with `app.useGlobalFilters()` |
| `apps/api/src/memory.controller.ts` | Replace 31 error returns with exceptions |
| `apps/api/src/scopes.controller.ts` | Replace 1 error return with exception |
| `apps/api/src/reminders.controller.ts` | Replace 1 error return with exception |

## Response Format

Before (all errors):
```json
HTTP 200
{ "error": "Scope not found" }
```

After:
```json
HTTP 404
{ "error": "Scope not found" }
```

The `{ error: "..." }` shape is preserved. Only the HTTP status code changes.

## Out of Scope

- Changing error messages
- Adding error codes or detail fields
- Changing middleware error handling (auth, rate limit)
- Zod validation error formatting
