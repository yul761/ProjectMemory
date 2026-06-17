# Configurable StateCore Platform — Design Spec

**Date:** 2026-06-17
**Scope:** Extend StateCore from a project-management-only memory engine into a multi-domain AI memory platform by adding a domain config layer, async LLM classification, retention expiry, and a notification webhook stub for daily reminders.

---

## Problem Statement

StateCore's extractKind taxonomy (decision/constraint/todo/note/noise) is hardcoded for project management. Other AI assistant use cases — personal life, fitness, learning — have fundamentally different information types and retention requirements. A personal life assistant should remember long-term goals and protect them from drift, but let feelings expire after 7 days. A fitness app should permanently protect injury facts. These behaviours cannot be expressed with the current rigid taxonomy.

---

## Design Principles

**Engine stays unchanged.** `protectedStateMerge`, `factRegistry`, `consistencyCheck`, `pgvector`, and the multi-scope architecture are not modified.

**Config drives behaviour.** Each domain provides a TypeScript config file declaring entity types, retention policies, an LLM classification prompt, and optional reminder prompt. The engine reads config at runtime; no code changes are needed to add a new domain.

**Parallel, not replacement.** The existing `extractKind` regex continues to drive `protectedStateMerge` synchronously. The new `classify_event` LLM classifier runs asynchronously and writes to new DB fields — the two systems are fully independent.

**Template is API-level only.** Apps pass `template` when creating a scope; end users never see or choose a template. Backward compatible: existing scopes without `template` default to `"project"`.

---

## Architecture Overview

```
POST /memory/events
    ↓ (synchronous, unchanged)
extractKind regex → features.kind → protectedStateMerge → DigestState
    ↓ (async, new)
classify_event job ──→ LLM (domain classificationSystemPrompt)
                   ──→ MemoryEvent.classifiedType / classifiedImportance / expiresAt

Daily Worker (new)
    expire_events job    → DELETE WHERE expiresAt < now()
    daily_remind job     → LLM generates reminders → POST scope.notificationWebhook
```

---

## Part 1: Domain Config Layer

### New Files

```
packages/core/src/domain-configs/
  types.ts          DomainConfig and EntityTypeConfig interfaces
  index.ts          getDomainConfig(template: string): DomainConfig
  project.ts        existing behaviour formalised
  personal.ts       personal life assistant
  health.ts         fitness and health
  learning.ts       study assistant
```

### `types.ts`

```typescript
export interface DomainConfig {
  name: string;
  description: string;
  entityTypes: EntityTypeConfig[];
  classificationSystemPrompt: string;
  digestFocusHint: string;
  dailyReminderPrompt?: string;    // only present for non-project templates
  conflictPatterns?: string[];     // extra conflict signals beyond replacement-language
}

export interface EntityTypeConfig {
  name: string;
  description: string;
  retention: "permanent" | "long-term" | "medium" | "short" | "discard";
  driftProtected: boolean;         // whether to push into factRegistry
  conflictDetectable: boolean;     // whether to run conflict detection against existing facts
  autoExpireAfterDays?: number;    // required when retention is "short" or "medium"
}
```

### `index.ts`

```typescript
import { projectConfig }  from "./project";
import { personalConfig } from "./personal";
import { healthConfig }   from "./health";
import { learningConfig } from "./learning";
import type { DomainConfig } from "./types";

const configs: Record<string, DomainConfig> = {
  project:  projectConfig,
  personal: personalConfig,
  health:   healthConfig,
  learning: learningConfig,
};

export function getDomainConfig(template: string): DomainConfig {
  return configs[template] ?? configs["project"];
}
```

### Schema Changes

```sql
-- Migration: 20260617000000_domain_templates

ALTER TABLE "ProjectScope"
  ADD COLUMN "template"             TEXT NOT NULL DEFAULT 'project',
  ADD COLUMN "notificationWebhook"  TEXT;          -- Expo push token URL, set by mobile app

ALTER TABLE "MemoryEvent"
  ADD COLUMN "classifiedType"       TEXT,
  ADD COLUMN "classifiedImportance" FLOAT,
  ADD COLUMN "expiresAt"            TIMESTAMP(3);

CREATE INDEX "MemoryEvent_expiresAt_idx" ON "MemoryEvent"("expiresAt")
  WHERE "expiresAt" IS NOT NULL;
```

Prisma schema additions:

```prisma
model ProjectScope {
  // ... existing fields unchanged ...
  template             String  @default("project")
  notificationWebhook  String?
}

model MemoryEvent {
  // ... existing fields unchanged ...
  classifiedType        String?
  classifiedImportance  Float?
  expiresAt             DateTime?
}
```

### API Change

`POST /scopes` body gains an optional `template` field (validated against known templates; unknown values rejected with 400):

```typescript
// packages/contracts/src/index.ts — ScopeInput schema
template: z.enum(["project", "personal", "health", "learning"]).optional()
```

---

## Part 2: classify_event Worker Job

### Trigger

Triggered from `apps/api/src/memory.controller.ts` after successful event creation, alongside the existing `embed_event` trigger:

```typescript
embedQueue.add("embed_event",    { eventId: event.id, scopeId }).catch(() => {});
embedQueue.add("classify_event", { eventId: event.id, scopeId }).catch(() => {});
```

Both are fire-and-forget. Neither blocks the HTTP response.

### New file: `apps/worker/src/classify-job.ts`

```typescript
import { prisma } from "@statecore/db";
import { getDomainConfig } from "@statecore/core";
import type { EmbeddingModel } from "@statecore/core";

interface ClassifyResult {
  entityType: string;
  importance: number;         // 0–1
  expiresAt: Date | null;
}

export async function runClassifyEventJob(
  data: { eventId: string; scopeId: string },
  llm: { chat: (messages: { role: string; content: string }[]) => Promise<string> },
  db: typeof prisma = prisma
): Promise<void> {
  const [event, scope] = await Promise.all([
    db.memoryEvent.findUnique({ where: { id: data.eventId } }),
    db.projectScope.findUnique({ where: { id: data.scopeId } })
  ]);
  if (!event || !scope) return;

  const config = getDomainConfig(scope.template ?? "project");

  let result: ClassifyResult;
  try {
    const raw = await llm.chat([
      { role: "system", content: config.classificationSystemPrompt },
      { role: "user",   content: event.content }
    ]);
    const parsed = JSON.parse(raw) as { entityType?: string; importance?: number };
    const entityType = parsed.entityType ?? "noise";
    const importance = typeof parsed.importance === "number"
      ? Math.max(0, Math.min(1, parsed.importance))
      : 0.5;

    const typeConfig = config.entityTypes.find(t => t.name === entityType);
    const expireDays = typeConfig?.autoExpireAfterDays;
    const expiresAt = expireDays
      ? new Date(Date.now() + expireDays * 86_400_000)
      : null;

    result = { entityType, importance, expiresAt };
  } catch {
    return; // classification failure is non-fatal — event stored without classification
  }

  await db.memoryEvent.update({
    where: { id: data.eventId },
    data: {
      classifiedType:       result.entityType,
      classifiedImportance: result.importance,
      expiresAt:            result.expiresAt
    }
  });
}
```

### Worker registration in `apps/worker/src/main.ts`

Add alongside the existing `"embed"` Worker:

```typescript
import { runClassifyEventJob } from "./classify-job";

new Worker(
  "classify",
  async (job) => {
    if (job.name !== "classify_event") return;
    await runClassifyEventJob(job.data as { eventId: string; scopeId: string }, llm!);
    return { ok: true };
  },
  { connection, concurrency: 4 }
).on("failed", (job, err) => {
  logger.warn({ jobId: job?.id, err }, "Classify job failed");
});
```

Add `classifyQueue` to `apps/api/src/queue.ts` (same pattern as `embedQueue`).

### Tests

`apps/worker/src/classify-job.test.ts` — 3 unit tests (no real LLM):

1. Classifies event, writes classifiedType + classifiedImportance to DB
2. Sets expiresAt when entityType has autoExpireAfterDays
3. Skips silently when LLM throws (event remains unclassified, no crash)

---

## Part 3: Retention Expiry + Daily Remind

### expire_events job

Runs daily in the existing `reminder` Worker tick (or a new dedicated tick — implementer's choice):

```typescript
async function runExpireEventsJob() {
  const deleted = await prisma.memoryEvent.deleteMany({
    where: { expiresAt: { lt: new Date() } }
  });
  logger.info({ count: deleted.count }, "Expired events purged");
}
```

Only events with non-null `expiresAt` in the past are deleted. `permanent` and `long-term` entity types never have `expiresAt` set, so they are never deleted by this job.

### daily_remind job

Runs daily (e.g., 8 PM user-local-time approximated as a fixed UTC hour for MVP):

```typescript
async function runDailyRemindJob(data: { scopeId: string }) {
  const scope = await prisma.projectScope.findUnique({ where: { id: data.scopeId } });
  if (!scope?.notificationWebhook) return;

  const config = getDomainConfig(scope.template ?? "project");
  if (!config.dailyReminderPrompt) return;  // project template has none

  const stateSnapshot = await prisma.digestStateSnapshot.findFirst({
    where: { scopeId: data.scopeId },
    orderBy: { createdAt: "desc" }
  });
  if (!stateSnapshot) return;

  const commitments = await prisma.memoryEvent.findMany({
    where: {
      scopeId: data.scopeId,
      classifiedType: "commitment",
      expiresAt: { gt: new Date() }
    },
    orderBy: { createdAt: "desc" },
    take: 10
  });

  const context = JSON.stringify({
    stableFacts: (stateSnapshot.state as any)?.stableFacts ?? {},
    commitments: commitments.map(e => e.content)
  });

  let reminders: string[];
  try {
    const raw = await llm.chat([
      { role: "system", content: config.dailyReminderPrompt },
      { role: "user",   content: context }
    ]);
    const parsed = JSON.parse(raw) as { reminders?: string[] };
    reminders = parsed.reminders?.slice(0, 2) ?? [];
  } catch {
    return;
  }

  if (!reminders.length) return;

  // POST to webhook — mobile app registers Expo push token URL here
  await fetch(scope.notificationWebhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scopeId: data.scopeId, reminders })
  }).catch(() => {}); // webhook failure is non-fatal
}
```

**Webhook contract** (what the mobile app receives):
```json
{
  "scopeId": "uuid",
  "reminders": ["你上周说想减少咖啡因，今天坚持了吗？"]
}
```

Mobile app registers by calling `PATCH /scopes/:id` with `{ notificationWebhook: "https://..." }`.

### New endpoint

```typescript
// apps/api/src/scopes.controller.ts — add PATCH /scopes/:id
@Patch("/scopes/:id/active")  // already exists — add new route
@Patch("/scopes/:id/webhook")
async setWebhook(
  @Param("id") id: string,
  @Req() req: RequestWithUser,
  @Body() body: { notificationWebhook: string }
) {
  const scope = await this.domain.scopes.findById(id, req.userId);
  if (!scope) throw new NotFoundException();
  await prisma.projectScope.update({
    where: { id },
    data: { notificationWebhook: body.notificationWebhook }
  });
  return { ok: true };
}
```

---

## File Map

| File | Action |
|------|--------|
| `packages/core/src/domain-configs/types.ts` | Create |
| `packages/core/src/domain-configs/index.ts` | Create |
| `packages/core/src/domain-configs/project.ts` | Create |
| `packages/core/src/domain-configs/personal.ts` | Create |
| `packages/core/src/domain-configs/health.ts` | Create |
| `packages/core/src/domain-configs/learning.ts` | Create |
| `packages/db/prisma/schema.prisma` | Modify — template/webhook on Scope, classified*/expiresAt on Event |
| `packages/db/prisma/migrations/20260617000000_domain_templates/migration.sql` | Create |
| `packages/contracts/src/index.ts` | Modify — template field in ScopeInput |
| `apps/api/src/queue.ts` | Modify — add classifyQueue |
| `apps/api/src/memory.controller.ts` | Modify — trigger classify_event after ingest |
| `apps/api/src/scopes.controller.ts` | Modify — add PATCH /scopes/:id/webhook |
| `apps/worker/src/classify-job.ts` | Create |
| `apps/worker/src/classify-job.test.ts` | Create |
| `apps/worker/src/main.ts` | Modify — register classify Worker, expire_events, daily_remind jobs |

---

## Success Criteria

1. `POST /scopes { "template": "health" }` succeeds; scope.template = "health"
2. After `POST /memory/events` with content "我决定戒糖", the event's `classifiedType` is set within 5 seconds
3. Event with `autoExpireAfterDays: 7` gets `expiresAt` set; `expire_events` job deletes it after the date passes
4. `daily_remind` job fires for a scope with `notificationWebhook` set and `personal` template; webhook receives JSON with reminders
5. `project`-template scope: no `classify_event` classification is wrong (LLM still classifies it, just with project prompt)
6. All existing 164 core tests still pass
7. New tests: 3 classify-job unit tests pass

---

## Out of Scope

- Actual Expo Push notification delivery (deferred to mobile app build)
- User-facing template selection UI
- Custom domain configs via API (only built-in templates supported)
- Changing `protectedStateMerge` to use `classifiedType` instead of `extractKind` (future work)
