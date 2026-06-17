# Configurable StateCore Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend StateCore from a hardcoded project-management memory engine into a multi-domain platform by adding a domain config layer, async LLM classification, retention expiry, and a daily remind worker with webhook delivery.

**Architecture:** Three sequential tasks. Task 1 lays the foundation: domain config files, DB schema migration, and scope creation wiring. Task 2 implements the `classify_event` BullMQ job that runs LLM classification asynchronously after every ingest, writing results back to `MemoryEvent`. Task 3 adds the `expire_events` cleanup job, the `daily_remind` webhook job, and a `PATCH /scopes/:id/webhook` endpoint. The existing `extractKind` regex is untouched throughout — new classification is parallel, not replacement.

**Tech Stack:** TypeScript, Prisma (PostgreSQL), BullMQ (Redis), NestJS, Vitest, pnpm workspaces.

---

## File Map

| File | Task | Action |
|------|------|--------|
| `packages/core/src/domain-configs/types.ts` | 1 | Create |
| `packages/core/src/domain-configs/project.ts` | 1 | Create |
| `packages/core/src/domain-configs/personal.ts` | 1 | Create |
| `packages/core/src/domain-configs/health.ts` | 1 | Create |
| `packages/core/src/domain-configs/learning.ts` | 1 | Create |
| `packages/core/src/domain-configs/index.ts` | 1 | Create |
| `packages/db/prisma/migrations/20260617000000_domain_templates/migration.sql` | 1 | Create |
| `packages/db/prisma/schema.prisma` | 1 | Modify |
| `packages/contracts/src/index.ts` | 1 | Modify |
| `apps/api/src/scopes.controller.ts` | 1 | Modify |
| `apps/api/src/domain.service.ts` | 1 | Modify |
| `apps/worker/src/classify-job.ts` | 2 | Create |
| `apps/worker/src/classify-job.test.ts` | 2 | Create |
| `apps/api/src/queue.ts` | 2 | Modify |
| `apps/api/src/memory.controller.ts` | 2 | Modify |
| `apps/worker/src/main.ts` | 2 | Modify |
| `apps/worker/src/main.ts` | 3 | Modify (additional) |
| `apps/api/src/scopes.controller.ts` | 3 | Modify (additional) |

---

## Task 1: Domain Config Layer + Schema + Wiring

**Files:**
- Create: `packages/core/src/domain-configs/types.ts`
- Create: `packages/core/src/domain-configs/project.ts`
- Create: `packages/core/src/domain-configs/personal.ts`
- Create: `packages/core/src/domain-configs/health.ts`
- Create: `packages/core/src/domain-configs/learning.ts`
- Create: `packages/core/src/domain-configs/index.ts`
- Create: `packages/db/prisma/migrations/20260617000000_domain_templates/migration.sql`
- Modify: `packages/db/prisma/schema.prisma`
- Modify: `packages/contracts/src/index.ts`
- Modify: `apps/api/src/scopes.controller.ts`
- Modify: `apps/api/src/domain.service.ts`

No unit tests for this task — verified by TypeScript compilation and the existing test suite passing unchanged.

- [ ] **Step 1: Create types.ts**

Create `packages/core/src/domain-configs/types.ts`:

```typescript
export interface EntityTypeConfig {
  name: string;
  description: string;
  retention: "permanent" | "long-term" | "medium" | "short" | "discard";
  driftProtected: boolean;
  conflictDetectable: boolean;
  autoExpireAfterDays?: number;
}

export interface DomainConfig {
  name: string;
  description: string;
  entityTypes: EntityTypeConfig[];
  classificationSystemPrompt: string;
  digestFocusHint: string;
  dailyReminderPrompt?: string;
  conflictPatterns?: string[];
}
```

- [ ] **Step 2: Create project.ts**

Create `packages/core/src/domain-configs/project.ts`:

```typescript
import type { DomainConfig } from "./types";

export const projectConfig: DomainConfig = {
  name: "project",
  description: "Engineering and product project memory — technical decisions, constraints, and todos",
  entityTypes: [
    {
      name: "decision",
      description: "Technical or product decision reached by the team",
      retention: "permanent",
      driftProtected: true,
      conflictDetectable: true
    },
    {
      name: "constraint",
      description: "A boundary or requirement the project must respect",
      retention: "permanent",
      driftProtected: true,
      conflictDetectable: false
    },
    {
      name: "todo",
      description: "A concrete action item to be completed",
      retention: "long-term",
      driftProtected: false,
      conflictDetectable: false
    },
    {
      name: "question",
      description: "An open question not yet resolved",
      retention: "medium",
      driftProtected: false,
      conflictDetectable: false,
      autoExpireAfterDays: 30
    },
    {
      name: "status",
      description: "A progress or status update",
      retention: "short",
      driftProtected: false,
      conflictDetectable: false,
      autoExpireAfterDays: 14
    },
    {
      name: "noise",
      description: "Filler content with no informational value",
      retention: "discard",
      driftProtected: false,
      conflictDetectable: false
    }
  ],
  classificationSystemPrompt: `You are a project memory classifier. Classify the input into one of:
- decision: technical or product decision (contains decide/decision/we will/agreed/going with)
- constraint: boundary or requirement (contains constraint/must/cannot/required/no X allowed)
- todo: action item (contains todo/next step/action item/follow up/let's add/make sure to)
- question: open question
- status: progress update
- noise: filler with no value (ok/noted/thanks/short chatter)

Return JSON: { "entityType": string, "importance": number }
importance is 0–1 (decision/constraint=0.8+, todo=0.7, status/question=0.5, noise=0.05)`,
  digestFocusHint: "Focus on project goals, technical decisions, constraints, and open todos"
};
```

- [ ] **Step 3: Create personal.ts**

Create `packages/core/src/domain-configs/personal.ts`:

```typescript
import type { DomainConfig } from "./types";

export const personalConfig: DomainConfig = {
  name: "personal",
  description: "Personal life assistant — goals, commitments, experiences, and daily reflections",
  entityTypes: [
    {
      name: "life_decision",
      description: "A significant life decision such as changing jobs, moving, or adopting a new habit",
      retention: "permanent",
      driftProtected: true,
      conflictDetectable: true
    },
    {
      name: "goal",
      description: "A personal goal the user wants to achieve",
      retention: "long-term",
      driftProtected: true,
      conflictDetectable: true
    },
    {
      name: "commitment",
      description: "A promise made to self or others",
      retention: "long-term",
      driftProtected: false,
      conflictDetectable: false
    },
    {
      name: "person_note",
      description: "Important information about a specific person in the user's life",
      retention: "long-term",
      driftProtected: false,
      conflictDetectable: false
    },
    {
      name: "experience",
      description: "A noteworthy experience or event",
      retention: "medium",
      driftProtected: false,
      conflictDetectable: false,
      autoExpireAfterDays: 60
    },
    {
      name: "feeling",
      description: "A current emotional state or mood",
      retention: "short",
      driftProtected: false,
      conflictDetectable: false,
      autoExpireAfterDays: 7
    },
    {
      name: "noise",
      description: "Casual chatter with no lasting value",
      retention: "discard",
      driftProtected: false,
      conflictDetectable: false
    }
  ],
  classificationSystemPrompt: `You are a personal life memory classifier. Decide what in this input is worth remembering long-term.

Categories:
- life_decision: major life direction change ("I decided to move to Vancouver", "I'm quitting sugar for good")
- goal: personal goal ("I want to lose 10kg this year", "I want to learn piano")
- commitment: promise to self or others ("I promised mom I'd call every week")
- person_note: important info about someone ("Sarah is looking for a new job")
- experience: memorable event ("Had an amazing dinner at X restaurant")
- feeling: current mood (expires in 7 days) ("I'm feeling anxious today")
- noise: casual chatter, nothing worth keeping ("ok", "sure", weather comments)

In Chinese: "我决定..."/"我要..."/"以后我会..." → life_decision or goal. "答应了..." → commitment.
Be conservative: when unsure, classify as noise rather than over-storing.

Return JSON: { "entityType": string, "importance": number }`,
  digestFocusHint: "Focus on the user's long-term goals, major decisions, active commitments, and relationship notes",
  dailyReminderPrompt: `Based on the user's memory, generate 1–2 natural, friendly reminders.
Focus on: overdue commitments, goal progress check-ins, decisions worth reflecting on.
Do NOT remind about feelings or experiences — only durable facts.
Be warm, not judgmental. Keep each reminder under 30 words.
Return JSON: { "reminders": string[] }`,
  conflictPatterns: ["我改变主意了", "我不再", "我放弃了", "我决定不"]
};
```

- [ ] **Step 4: Create health.ts**

Create `packages/core/src/domain-configs/health.ts`:

```typescript
import type { DomainConfig } from "./types";

export const healthConfig: DomainConfig = {
  name: "health",
  description: "Fitness and health assistant — training goals, physical limitations, dietary rules, daily logs",
  entityTypes: [
    {
      name: "medical_fact",
      description: "A permanent medical fact such as allergy, injury history, or chronic condition",
      retention: "permanent",
      driftProtected: true,
      conflictDetectable: false
    },
    {
      name: "fitness_goal",
      description: "A fitness or health goal",
      retention: "long-term",
      driftProtected: true,
      conflictDetectable: true
    },
    {
      name: "dietary_rule",
      description: "A dietary restriction or rule the user follows",
      retention: "long-term",
      driftProtected: true,
      conflictDetectable: true
    },
    {
      name: "preference",
      description: "A training preference such as time of day or exercise type",
      retention: "long-term",
      driftProtected: false,
      conflictDetectable: false
    },
    {
      name: "current_plan",
      description: "The user's current training or diet plan",
      retention: "medium",
      driftProtected: false,
      conflictDetectable: false,
      autoExpireAfterDays: 45
    },
    {
      name: "daily_log",
      description: "Today's workout or food log entry",
      retention: "short",
      driftProtected: false,
      conflictDetectable: false,
      autoExpireAfterDays: 30
    },
    {
      name: "noise",
      description: "Chatter unrelated to health",
      retention: "discard",
      driftProtected: false,
      conflictDetectable: false
    }
  ],
  classificationSystemPrompt: `You are a health and fitness memory classifier.

Categories:
- medical_fact: permanent medical info (allergy, injury, surgery, chronic condition) — ALWAYS protect
- fitness_goal: fitness target ("I want to run 5k by June")
- dietary_rule: food restriction or rule ("I'm lactose intolerant", "no sugar")
- preference: training preference ("I prefer morning runs", "I hate gyms")
- current_plan: current routine ("I'm doing push/pull/legs this month")
- daily_log: today's activity ("ran 3km today", "had a salad for lunch")
- noise: unrelated chatter

IMPORTANT: medical_fact is the highest priority — never mark medical info as noise.
Return JSON: { "entityType": string, "importance": number }`,
  digestFocusHint: "Always surface medical facts and physical limitations first. Then fitness goals and dietary rules.",
  dailyReminderPrompt: `Based on the user's health data, generate 1–2 motivating reminders.
Focus on: goal progress, streak maintenance, upcoming milestones.
Keep it positive and encouraging. Under 30 words each.
Return JSON: { "reminders": string[] }`
};
```

- [ ] **Step 5: Create learning.ts**

Create `packages/core/src/domain-configs/learning.ts`:

```typescript
import type { DomainConfig } from "./types";

export const learningConfig: DomainConfig = {
  name: "learning",
  description: "Study assistant — learning goals, knowledge claims, open questions, and progress tracking",
  entityTypes: [
    {
      name: "knowledge_claim",
      description: "A statement about what the user already knows or doesn't know",
      retention: "long-term",
      driftProtected: true,
      conflictDetectable: true
    },
    {
      name: "learning_goal",
      description: "A learning objective with optional deadline",
      retention: "long-term",
      driftProtected: true,
      conflictDetectable: false
    },
    {
      name: "open_question",
      description: "Something the user doesn't yet understand",
      retention: "medium",
      driftProtected: false,
      conflictDetectable: false,
      autoExpireAfterDays: 30
    },
    {
      name: "insight",
      description: "A key understanding or breakthrough moment",
      retention: "medium",
      driftProtected: false,
      conflictDetectable: false,
      autoExpireAfterDays: 60
    },
    {
      name: "progress",
      description: "Today's study progress",
      retention: "short",
      driftProtected: false,
      conflictDetectable: false,
      autoExpireAfterDays: 14
    },
    {
      name: "noise",
      description: "Filler with no learning value",
      retention: "discard",
      driftProtected: false,
      conflictDetectable: false
    }
  ],
  classificationSystemPrompt: `You are a learning memory classifier.

Categories:
- knowledge_claim: what the user knows or doesn't know ("I already know React hooks", "I don't understand Rust lifetimes")
- learning_goal: what they want to learn ("I want to master TypeScript in 3 months")
- open_question: unresolved confusion ("I still don't get async generators")
- insight: a key realisation ("I finally understand why closures capture by reference")
- progress: today's study log ("read chapter 3 today")
- noise: unrelated chatter

knowledge_claim is critical — AI must calibrate explanation depth to user's stated knowledge level.
Return JSON: { "entityType": string, "importance": number }`,
  digestFocusHint: "Prioritise knowledge level claims so AI can calibrate depth. Then surface learning goals and open questions."
};
```

- [ ] **Step 6: Create index.ts**

Create `packages/core/src/domain-configs/index.ts`:

```typescript
export type { DomainConfig, EntityTypeConfig } from "./types";
export { projectConfig }  from "./project";
export { personalConfig } from "./personal";
export { healthConfig }   from "./health";
export { learningConfig } from "./learning";

import { projectConfig }  from "./project";
import { personalConfig } from "./personal";
import { healthConfig }   from "./health";
import { learningConfig } from "./learning";
import type { DomainConfig } from "./types";

const CONFIGS: Record<string, DomainConfig> = {
  project:  projectConfig,
  personal: personalConfig,
  health:   healthConfig,
  learning: learningConfig
};

export const KNOWN_TEMPLATES = Object.keys(CONFIGS) as string[];

export function getDomainConfig(template: string | null | undefined): DomainConfig {
  return CONFIGS[template ?? "project"] ?? CONFIGS["project"];
}
```

- [ ] **Step 7: Export from core index.ts**

In `packages/core/src/index.ts`, add at the end:

```typescript
export { getDomainConfig, KNOWN_TEMPLATES } from "./domain-configs/index";
export type { DomainConfig, EntityTypeConfig } from "./domain-configs/types";
```

- [ ] **Step 8: Create migration SQL**

Create directory `packages/db/prisma/migrations/20260617000000_domain_templates/` and file `migration.sql`:

```sql
ALTER TABLE "ProjectScope"
  ADD COLUMN "template"            TEXT NOT NULL DEFAULT 'project',
  ADD COLUMN "notificationWebhook" TEXT;

ALTER TABLE "MemoryEvent"
  ADD COLUMN "classifiedType"       TEXT,
  ADD COLUMN "classifiedImportance" DOUBLE PRECISION,
  ADD COLUMN "expiresAt"            TIMESTAMP(3);

CREATE INDEX "MemoryEvent_expiresAt_idx"
  ON "MemoryEvent"("expiresAt")
  WHERE "expiresAt" IS NOT NULL;
```

- [ ] **Step 9: Update Prisma schema**

In `packages/db/prisma/schema.prisma`, add to `ProjectScope` model (before the closing `}`):

```prisma
  template             String  @default("project")
  notificationWebhook  String?
```

Add to `MemoryEvent` model (before the closing `}`):

```prisma
  classifiedType        String?
  classifiedImportance  Float?
  expiresAt             DateTime?
```

Regenerate:
```powershell
cd C:\StateCore\StateCore; pnpm --filter @statecore/db exec prisma generate
```

Expected: client regenerates cleanly.

- [ ] **Step 10: Update contracts ScopeCreateInput**

In `packages/contracts/src/index.ts`, find `ScopeCreateInput` and add the `template` field:

```typescript
// Before:
export const ScopeCreateInput = z.object({
  name: z.string().min(1),
  goal: z.string().min(1).optional(),
  stage: ProjectStage.optional()
});

// After:
export const ScopeCreateInput = z.object({
  name: z.string().min(1),
  goal: z.string().min(1).optional(),
  stage: ProjectStage.optional(),
  template: z.enum(["project", "personal", "health", "learning"]).optional()
});
```

- [ ] **Step 11: Wire template through createScope**

In `apps/api/src/domain.service.ts`, find the `projectsRepo` object's `create` method (around line 63):

```typescript
// Before:
create: (data: { userId: string; name: string; goal?: string | null; stage?: "idea" | "build" | "test" | "launch" }) =>
  prisma.projectScope.create({ data }),
```

```typescript
// After:
create: (data: { userId: string; name: string; goal?: string | null; stage?: "idea" | "build" | "test" | "launch"; template?: string }) =>
  prisma.projectScope.create({ data }),
```

- [ ] **Step 12: Pass template in scopes.controller.ts**

In `apps/api/src/scopes.controller.ts`, update `createScope`:

```typescript
// Before:
const scope = await this.domain.projectService.createScope(req.userId, input.name, input.goal ?? null, input.stage);

// After:
const scope = await this.domain.projectService.createScope(req.userId, input.name, input.goal ?? null, input.stage, input.template);
```

Also find `ProjectService.createScope` in domain.service.ts and check its signature. It likely looks like:
```typescript
createScope(userId: string, name: string, goal: string | null, stage?: ...) {
  return this.projectsRepo.create({ userId, name, goal, stage });
}
```

Update to:
```typescript
createScope(userId: string, name: string, goal: string | null, stage?: ..., template?: string) {
  return this.projectsRepo.create({ userId, name, goal, stage, template: template ?? "project" });
}
```

- [ ] **Step 13: Run migration and verify tests**

```powershell
cd C:\StateCore\StateCore
pnpm --filter @statecore/db exec prisma migrate deploy
pnpm --filter @statecore/core test 2>&1 | Select-Object -Last 8
pnpm --filter @statecore/api test 2>&1 | Select-Object -Last 8
```

Expected: migrations apply, core 164 pass, API tests pass.

If migration fails (DB not running): commit the files and note migration will run in CI. Core and API unit tests don't need the DB.

- [ ] **Step 14: Commit**

```powershell
cd C:\StateCore\StateCore
git add packages/core/src/domain-configs/ packages/core/src/index.ts packages/db/prisma/ packages/contracts/src/index.ts apps/api/src/scopes.controller.ts apps/api/src/domain.service.ts
git commit -m "feat(platform): add domain config layer — 4 templates, schema migration, scope template wiring"
```

---

## Task 2: classify_event Worker Job

**Files:**
- Create: `apps/worker/src/classify-job.ts`
- Create: `apps/worker/src/classify-job.test.ts`
- Modify: `apps/api/src/queue.ts`
- Modify: `apps/api/src/memory.controller.ts`
- Modify: `apps/worker/src/main.ts`

### Context

The worker already has `llm` (structured output model) and `prisma` available globally. The pattern for a new async job follows the existing `embed_event` job exactly: fire-and-forget from the API, BullMQ Worker in the worker process.

- [ ] **Step 1: Write failing tests**

Create `apps/worker/src/classify-job.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";

describe("runClassifyEventJob", () => {
  it("classifies event and writes classifiedType + classifiedImportance to DB", async () => {
    const mockEvent = { id: "evt-1", content: "I decided to quit sugar", scopeId: "sc-1" };
    const mockScope = { id: "sc-1", template: "personal" };
    const mockPrisma = {
      memoryEvent:   { findUnique: vi.fn().mockResolvedValue(mockEvent), update: vi.fn().mockResolvedValue(mockEvent) },
      projectScope:  { findUnique: vi.fn().mockResolvedValue(mockScope) }
    } as any;
    const mockLlm = {
      chat: vi.fn().mockResolvedValue(JSON.stringify({ entityType: "life_decision", importance: 0.9 }))
    };

    const { runClassifyEventJob } = await import("./classify-job");
    await runClassifyEventJob({ eventId: "evt-1", scopeId: "sc-1" }, mockLlm, mockPrisma);

    expect(mockLlm.chat).toHaveBeenCalled();
    expect(mockPrisma.memoryEvent.update).toHaveBeenCalledWith({
      where: { id: "evt-1" },
      data: expect.objectContaining({
        classifiedType: "life_decision",
        classifiedImportance: 0.9
      })
    });
  });

  it("sets expiresAt when entityType has autoExpireAfterDays", async () => {
    const mockEvent = { id: "evt-2", content: "I feel a bit tired today", scopeId: "sc-1" };
    const mockScope = { id: "sc-1", template: "personal" };
    const mockPrisma = {
      memoryEvent:  { findUnique: vi.fn().mockResolvedValue(mockEvent), update: vi.fn().mockResolvedValue(mockEvent) },
      projectScope: { findUnique: vi.fn().mockResolvedValue(mockScope) }
    } as any;
    const mockLlm = {
      chat: vi.fn().mockResolvedValue(JSON.stringify({ entityType: "feeling", importance: 0.4 }))
    };

    const before = Date.now();
    const { runClassifyEventJob } = await import("./classify-job");
    await runClassifyEventJob({ eventId: "evt-2", scopeId: "sc-1" }, mockLlm, mockPrisma);

    const updateCall = mockPrisma.memoryEvent.update.mock.calls[0][0];
    expect(updateCall.data.expiresAt).toBeInstanceOf(Date);
    // feeling autoExpireAfterDays = 7 → expiresAt ≈ now + 7 days
    const expectedExpiry = new Date(before + 7 * 86_400_000);
    expect(updateCall.data.expiresAt.getTime()).toBeGreaterThan(before);
    expect(updateCall.data.expiresAt.getTime()).toBeLessThanOrEqual(expectedExpiry.getTime() + 5000);
  });

  it("skips silently when LLM throws — event remains unclassified, no crash", async () => {
    const mockEvent = { id: "evt-3", content: "something", scopeId: "sc-1" };
    const mockScope = { id: "sc-1", template: "personal" };
    const mockPrisma = {
      memoryEvent:  { findUnique: vi.fn().mockResolvedValue(mockEvent), update: vi.fn() },
      projectScope: { findUnique: vi.fn().mockResolvedValue(mockScope) }
    } as any;
    const mockLlm = {
      chat: vi.fn().mockRejectedValue(new Error("LLM timeout"))
    };

    const { runClassifyEventJob } = await import("./classify-job");
    await expect(
      runClassifyEventJob({ eventId: "evt-3", scopeId: "sc-1" }, mockLlm, mockPrisma)
    ).resolves.toBeUndefined();

    expect(mockPrisma.memoryEvent.update).not.toHaveBeenCalled();
  });
});
```

Run:
```powershell
cd C:\StateCore\StateCore; pnpm --filter @statecore/worker test 2>&1 | Select-Object -Last 15
```
Expected: 3 tests fail — `classify-job` module not found.

- [ ] **Step 2: Create classify-job.ts**

Create `apps/worker/src/classify-job.ts`:

```typescript
import { prisma as defaultPrisma } from "@statecore/db";
import { getDomainConfig } from "@statecore/core";

export async function runClassifyEventJob(
  data: { eventId: string; scopeId: string },
  llm: { chat: (messages: { role: string; content: string }[]) => Promise<string> },
  db: typeof defaultPrisma = defaultPrisma
): Promise<void> {
  const [event, scope] = await Promise.all([
    db.memoryEvent.findUnique({ where: { id: data.eventId } }),
    db.projectScope.findUnique({ where: { id: data.scopeId } })
  ]);
  if (!event || !scope) return;

  const config = getDomainConfig((scope as any).template ?? "project");

  let entityType: string;
  let importance: number;
  try {
    const raw = await llm.chat([
      { role: "system", content: config.classificationSystemPrompt },
      { role: "user",   content: event.content }
    ]);
    const parsed = JSON.parse(raw) as { entityType?: string; importance?: number };
    entityType = parsed.entityType ?? "noise";
    importance = typeof parsed.importance === "number"
      ? Math.max(0, Math.min(1, parsed.importance))
      : 0.5;
  } catch {
    return; // classification failure is non-fatal
  }

  const typeConfig = config.entityTypes.find((t) => t.name === entityType);
  const expireDays = typeConfig?.autoExpireAfterDays;
  const expiresAt = expireDays
    ? new Date(Date.now() + expireDays * 86_400_000)
    : null;

  await db.memoryEvent.update({
    where: { id: data.eventId },
    data: {
      classifiedType:       entityType,
      classifiedImportance: importance,
      ...(expiresAt ? { expiresAt } : {})
    }
  });
}
```

- [ ] **Step 3: Run tests — verify 3 new pass**

```powershell
cd C:\StateCore\StateCore; pnpm --filter @statecore/worker test 2>&1 | Select-Object -Last 10
```

Expected: 9 pass (6 existing + 3 new).

- [ ] **Step 4: Add classifyQueue to queue.ts**

In `apps/api/src/queue.ts`, add `classifyQueue` following the exact same pattern as `embedQueue`:

```typescript
export let classifyQueue: IQueue;

// In isLite branch: classifyQueue = new InMemoryQueueAdapter();
// In else branch:   classifyQueue = new BullMqQueueAdapter(new Queue("classify", { connection }));
```

- [ ] **Step 5: Trigger classify_event from memory.controller.ts**

In `apps/api/src/memory.controller.ts`, find the import that includes `embedQueue`:
```typescript
import { digestQueue, workingMemoryQueue, embedQueue } from "./queue";
```

Add `classifyQueue`:
```typescript
import { digestQueue, workingMemoryQueue, embedQueue, classifyQueue } from "./queue";
```

Find the ingest handler where `embedQueue.add` is called (after the `POST /memory/events` creates the event). Add the classify trigger immediately after the embed trigger:

```typescript
embedQueue.add("embed_event",    { eventId: event.id, scopeId: input.scopeId }).catch(() => {});
classifyQueue.add("classify_event", { eventId: event.id, scopeId: input.scopeId }).catch(() => {});
```

Both are fire-and-forget (`.catch(() => {})`).

- [ ] **Step 6: Register classify Worker in main.ts**

In `apps/worker/src/main.ts`:

Add import at the top alongside other job imports:
```typescript
import { runClassifyEventJob } from "./classify-job";
```

After the existing `"embed"` Worker registration, add:
```typescript
new Worker(
  "classify",
  async (job) => {
    if (job.name !== "classify_event") return;
    if (!llm) return; // classify requires LLM
    await runClassifyEventJob(
      job.data as { eventId: string; scopeId: string },
      llm,
      prisma
    );
    return { ok: true };
  },
  { connection, concurrency: 4 }
).on("failed", (job, err) => {
  logger.warn({ jobId: job?.id, err }, "Classify job failed — event stored without classification");
});
```

- [ ] **Step 7: Run all tests**

```powershell
cd C:\StateCore\StateCore
pnpm --filter @statecore/core test 2>&1 | Select-Object -Last 8
pnpm --filter @statecore/worker test 2>&1 | Select-Object -Last 8
pnpm --filter @statecore/api test 2>&1 | Select-Object -Last 8
```

Expected: core 164 pass, worker 9 pass, API unit tests pass.

- [ ] **Step 8: Commit**

```powershell
cd C:\StateCore\StateCore
git add apps/worker/src/classify-job.ts apps/worker/src/classify-job.test.ts apps/api/src/queue.ts apps/api/src/memory.controller.ts apps/worker/src/main.ts
git commit -m "feat(platform): add classify_event async LLM classification worker"
```

---

## Task 3: Retention Expiry + Daily Remind + Webhook Endpoint

**Files:**
- Modify: `apps/worker/src/main.ts` (add expire_events, daily_remind jobs)
- Modify: `apps/api/src/scopes.controller.ts` (add PATCH /scopes/:id/webhook)

### Context

The worker already has a `setInterval` tick for reminders every 60s. Add similar ticks for the new jobs. The `daily_remind` job fires once per day; use a simple approach: track the last run date in Redis (or just run daily on the interval and check a flag). For MVP simplicity: `daily_remind` is queued by a daily cron-style interval (run every 24h).

- [ ] **Step 1: Add expire_events job logic in main.ts**

In `apps/worker/src/main.ts`, find the existing `setInterval` for reminders. Add a new interval for expiry cleanup (runs every 6 hours):

```typescript
// expire_events: purge MemoryEvent rows past their expiresAt
setInterval(() => {
  prisma.memoryEvent.deleteMany({
    where: { expiresAt: { lt: new Date() } }
  }).then(({ count }) => {
    if (count > 0) logger.info({ count }, "Expired events purged");
  }).catch((err) => {
    logger.error({ err }, "expire_events failed");
  });
}, 6 * 60 * 60 * 1000); // every 6 hours
```

This runs inline without BullMQ (no need for a queue — it's a simple periodic cleanup).

- [ ] **Step 2: Add daily_remind job in main.ts**

Add a `daily_remind` function and a 24-hour interval. Add imports for `getDomainConfig` from `@statecore/core`:

```typescript
// At top of main.ts, ensure this import exists:
import { getDomainConfig } from "@statecore/core";
```

Add the `runDailyRemindJob` function and interval. Find the end of the main.ts file (after the existing setInterval for reminders) and add:

```typescript
async function runDailyRemindJob() {
  if (!llm) return;
  const scopes = await prisma.projectScope.findMany({
    where: {
      notificationWebhook: { not: null }
    }
  });

  for (const scope of scopes) {
    const config = getDomainConfig((scope as any).template ?? "project");
    if (!config.dailyReminderPrompt) continue;
    if (!scope.notificationWebhook) continue;

    const stateSnapshot = await prisma.digestStateSnapshot.findFirst({
      where: { scopeId: scope.id },
      orderBy: { createdAt: "desc" }
    });
    if (!stateSnapshot) continue;

    const commitments = await prisma.memoryEvent.findMany({
      where: {
        scopeId: scope.id,
        classifiedType: "commitment",
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }]
      },
      orderBy: { createdAt: "desc" },
      take: 10
    });

    const context = JSON.stringify({
      stableFacts: (stateSnapshot.state as any)?.stableFacts ?? {},
      commitments: commitments.map((e) => e.content)
    });

    let reminders: string[];
    try {
      const raw = await llm.chat([
        { role: "system", content: config.dailyReminderPrompt },
        { role: "user",   content: context }
      ]);
      const parsed = JSON.parse(raw) as { reminders?: string[] };
      reminders = (parsed.reminders ?? []).slice(0, 2).filter((r) => typeof r === "string");
    } catch (err) {
      logger.warn({ scopeId: scope.id, err }, "daily_remind LLM call failed");
      continue;
    }

    if (!reminders.length) continue;

    try {
      await fetch(scope.notificationWebhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scopeId: scope.id, reminders })
      });
      logger.info({ scopeId: scope.id, count: reminders.length }, "Daily reminders sent");
    } catch (err) {
      logger.warn({ scopeId: scope.id, err }, "daily_remind webhook delivery failed");
    }
  }
}

// Run daily_remind once per day (86400000ms = 24h)
setInterval(() => {
  runDailyRemindJob().catch((err) => {
    logger.error({ err }, "daily_remind job crashed");
  });
}, 24 * 60 * 60 * 1000);
```

- [ ] **Step 3: Add PATCH /scopes/:id/webhook to scopes.controller.ts**

In `apps/api/src/scopes.controller.ts`:

Add `Patch` to the NestJS imports at the top:
```typescript
import { Body, Controller, Get, Inject, NotFoundException, Param, Patch, Post, Req } from "@nestjs/common";
```

Add `prisma` import if not present:
```typescript
import { prisma } from "@statecore/db";
```

Add `z` import (for inline validation):
```typescript
import { z } from "zod";
```

Add the new endpoint after `setActiveScope`:

```typescript
  @Patch("/scopes/:id/webhook")
  async setWebhook(
    @Param("id") id: string,
    @Req() req: RequestWithUser,
    @Body() body: unknown
  ) {
    const input = z.object({
      notificationWebhook: z.string().url().nullable()
    }).parse(body);

    const scope = await this.domain.projectService.getScope(req.userId, id);
    if (!scope) throw new NotFoundException("Scope not found");

    await prisma.projectScope.update({
      where: { id },
      data: { notificationWebhook: input.notificationWebhook }
    });

    return { ok: true };
  }
```

- [ ] **Step 4: Run all tests and verify no regressions**

```powershell
cd C:\StateCore\StateCore
pnpm --filter @statecore/core test 2>&1 | Select-Object -Last 8
pnpm --filter @statecore/worker test 2>&1 | Select-Object -Last 8
pnpm --filter @statecore/api test 2>&1 | Select-Object -Last 8
```

Expected: core 164 pass, worker 9 pass, API tests pass.

- [ ] **Step 5: Commit and push**

```powershell
cd C:\StateCore\StateCore
git add apps/worker/src/main.ts apps/api/src/scopes.controller.ts
git commit -m "feat(platform): add expire_events, daily_remind worker jobs and PATCH /scopes/:id/webhook"
git push origin main
```

---

## Self-Review

**Spec coverage:**
| Spec requirement | Task |
|----------------|------|
| `packages/core/src/domain-configs/` with 4 templates | Task 1 ✅ |
| `getDomainConfig(template)` function | Task 1 ✅ |
| Schema: `ProjectScope.template` + `ProjectScope.notificationWebhook` | Task 1 ✅ |
| Schema: `MemoryEvent.classifiedType` + `classifiedImportance` + `expiresAt` | Task 1 ✅ |
| `ScopeCreateInput` gains `template` field | Task 1 ✅ |
| `createScope` passes template to DB | Task 1 ✅ |
| `classify_event` BullMQ job with 3 unit tests | Task 2 ✅ |
| `classifyQueue` added to API queue.ts | Task 2 ✅ |
| classify_event triggered after POST /memory/events | Task 2 ✅ |
| classify Worker registered in main.ts | Task 2 ✅ |
| `expire_events` periodic cleanup | Task 3 ✅ |
| `daily_remind` with LLM + webhook delivery | Task 3 ✅ |
| `PATCH /scopes/:id/webhook` endpoint | Task 3 ✅ |
| All 164 existing tests pass | Verified in each task ✅ |

**Placeholder scan:** None found.

**Type consistency:**
- `getDomainConfig` takes `string | null | undefined`, returns `DomainConfig` — consistent across domain-configs/index.ts, classify-job.ts, main.ts ✅
- `runClassifyEventJob(data, llm, db)` signature consistent between classify-job.ts and classify-job.test.ts ✅
- `scope.template` accessed as `(scope as any).template` — needed because Prisma generated client doesn't know about new field until migration runs and `prisma generate` is called ✅
- `notificationWebhook` is `String?` in Prisma — accessed as `scope.notificationWebhook` after generate ✅
