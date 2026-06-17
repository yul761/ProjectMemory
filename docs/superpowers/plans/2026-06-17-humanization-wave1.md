# Humanization Wave 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the foundational "AI knows you" layer: personal_detail entity type auto-extraction, a relationship context builder service, and default personas — giving consuming apps everything they need to make AI responses feel warm and personal.

**Architecture:** Three sequential tasks. Task 1 extends the domain config files with new entity types and persona prompts (no DB changes). Task 2 builds the `buildRelationshipContext()` core function with unit tests. Task 3 wires the API endpoint and exports. No schema migrations required — reads from `MemoryEvent.classifiedType` already added by the domain config task.

**Tech Stack:** TypeScript, Prisma (read-only queries), Vitest, NestJS (one new route), pnpm workspaces.

---

## File Map

| File | Task | Action |
|------|------|--------|
| `packages/core/src/domain-configs/types.ts` | 1 | Modify — add `defaultPersonaPrompt?: string` |
| `packages/core/src/domain-configs/personal.ts` | 1 | Modify — add 2 entity types + updated classify prompt + persona |
| `packages/core/src/domain-configs/health.ts` | 1 | Modify — add health persona |
| `packages/core/src/relationship-context.ts` | 2 | Create |
| `packages/core/src/relationship-context.test.ts` | 2 | Create |
| `packages/core/src/index.ts` | 2 | Modify — export new types + function |
| `apps/api/src/memory.controller.ts` | 3 | Modify — add GET /memory/relationship-context/:scopeId |

---

## Task 1: Domain Config Updates

**Files:**
- Modify: `packages/core/src/domain-configs/types.ts`
- Modify: `packages/core/src/domain-configs/personal.ts`
- Modify: `packages/core/src/domain-configs/health.ts`

No unit tests — verified by TypeScript compilation and existing 164 tests passing.

- [ ] **Step 1: Add `defaultPersonaPrompt` to DomainConfig interface**

In `packages/core/src/domain-configs/types.ts`, find the `DomainConfig` interface and add one optional field after `conflictPatterns`:

```typescript
export interface DomainConfig {
  name: string;
  description: string;
  entityTypes: EntityTypeConfig[];
  classificationSystemPrompt: string;
  digestFocusHint: string;
  dailyReminderPrompt?: string;
  conflictPatterns?: string[];
  defaultPersonaPrompt?: string;   // ADD THIS LINE
}
```

- [ ] **Step 2: Update personal.ts — add entity types**

In `packages/core/src/domain-configs/personal.ts`, find the `entityTypes` array. Add two new entries BEFORE the `noise` entry:

```typescript
    { name: "personal_detail",
      description: "Small personal facts: name, pets, job, location, hobbies, family, daily routines, preferences",
      retention: "permanent",
      driftProtected: true,
      conflictDetectable: false },
    { name: "emotional_pattern",
      description: "Recurring emotional or situational patterns (anxious before deadlines, energized by exercise)",
      retention: "long-term",
      driftProtected: false,
      conflictDetectable: false,
      autoExpireAfterDays: 90 },
```

- [ ] **Step 3: Update personal.ts — classification prompt**

In `packages/core/src/domain-configs/personal.ts`, replace the entire `classificationSystemPrompt` string with:

```typescript
  classificationSystemPrompt: `You are a personal life memory classifier. Decide what in this input is worth remembering long-term.

Categories:
- personal_detail: small facts ABOUT THE PERSON themselves (name, pets, job, city, hobbies, family, dietary preferences, daily routines)
  Examples: "my dog's name is Max", "I'm a teacher", "I live in Beijing", "I don't eat meat", "I hate Mondays"
  These are permanent identity facts, not decisions or goals.
- life_decision: major life direction change ("I decided to move to Vancouver", "I'm quitting sugar for good")
- goal: personal goal ("I want to lose 10kg this year", "I want to learn piano")
- commitment: promise to self or others ("I promised mom I'd call every week")
- person_note: important info about someone ELSE ("Sarah is looking for a new job")
- experience: memorable event ("Had an amazing dinner at X restaurant")
- feeling: current mood (expires in 7 days) ("I'm feeling anxious today")
- emotional_pattern: recurring pattern across many interactions ("I always feel stressed on Sundays")
- noise: casual chatter, nothing worth keeping ("ok", "sure", weather comments)

In Chinese: "我叫..." → personal_detail. "我有..." (pet/possession) → personal_detail. "我是..." (job/identity) → personal_detail.
"我决定..."/"我要..." → life_decision or goal. "答应了..." → commitment.
Be conservative: when unsure between personal_detail and noise, prefer personal_detail for genuine self-descriptions.

Return JSON: { "entityType": string, "importance": number }`,
```

- [ ] **Step 4: Update personal.ts — add persona**

In `packages/core/src/domain-configs/personal.ts`, after `conflictPatterns`, add `defaultPersonaPrompt`:

```typescript
  defaultPersonaPrompt: `You are a warm, attentive personal AI companion.
You remember the small things that matter to this person.
You respond like a thoughtful friend: genuine, occasionally curious, never preachy.
You naturally reference what you know about them — their name, their cat, their goals — without it feeling like a database lookup.
When someone's mood seems different from usual, you notice it gently.
You check in on things that mattered — not every message, but when it feels right.
Keep responses concise unless the person clearly wants to talk.`
```

- [ ] **Step 5: Update health.ts — add persona**

In `packages/core/src/domain-configs/health.ts`, after `dailyReminderPrompt`, add:

```typescript
  defaultPersonaPrompt: `You are a supportive health and fitness companion.
You know this person's physical limitations and always respect them — never suggest exercises that could aggravate known injuries.
You are encouraging but realistic: you celebrate genuine progress and gently hold them to their stated goals.
You remember their specific targets and constraints and factor them into every suggestion.`
```

- [ ] **Step 6: Verify TypeScript compiles cleanly**

```powershell
cd C:\StateCore\StateCore; pnpm --filter @statecore/core exec tsc --noEmit 2>&1 | Select-Object -Last 10
```

Expected: no errors.

- [ ] **Step 7: Run tests to confirm no regressions**

```powershell
cd C:\StateCore\StateCore; pnpm --filter @statecore/core test 2>&1 | Select-Object -Last 8
```

Expected: 164 pass (unchanged).

- [ ] **Step 8: Commit**

```powershell
cd C:\StateCore\StateCore
git add packages/core/src/domain-configs/types.ts packages/core/src/domain-configs/personal.ts packages/core/src/domain-configs/health.ts
git commit -m "feat(humanization): add personal_detail entity type, emotional_pattern, and default personas"
```

---

## Task 2: Relationship Context Builder

**Files:**
- Create: `packages/core/src/relationship-context.ts`
- Create: `packages/core/src/relationship-context.test.ts`
- Modify: `packages/core/src/index.ts`

### Context
`MemoryEvent.classifiedType` and `MemoryEvent.expiresAt` exist in the DB schema (added by domain config task). `DigestStateSnapshot.state` contains the full `DigestState` JSON. `ProjectScope.template` contains the domain template name. All reads — no writes.

- [ ] **Step 1: Write failing tests**

Create `packages/core/src/relationship-context.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";

const baseScope = { id: "sc-1", template: "personal" };

function makeEvent(overrides: {
  id: string;
  content: string;
  classifiedType?: string;
  createdAt?: Date;
  expiresAt?: Date | null;
}) {
  return {
    id: overrides.id,
    content: overrides.content,
    classifiedType: overrides.classifiedType ?? null,
    createdAt: overrides.createdAt ?? new Date("2026-06-01T10:00:00Z"),
    expiresAt: overrides.expiresAt ?? null,
    scopeId: "sc-1"
  };
}

describe("buildRelationshipContext", () => {
  it("returns durationDays=0 and empty arrays when scope has no events", async () => {
    const mockDb = {
      projectScope: { findUnique: vi.fn().mockResolvedValue(baseScope) },
      memoryEvent: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) },
      digestStateSnapshot: { findFirst: vi.fn().mockResolvedValue(null) }
    } as any;

    const { buildRelationshipContext } = await import("./relationship-context");
    const result = await buildRelationshipContext("sc-1", mockDb);

    expect(result.durationDays).toBe(0);
    expect(result.personalDetails).toEqual([]);
    expect(result.activeGoals).toEqual([]);
    expect(result.currentFeeling).toBeNull();
    expect(result.pendingFollowUps).toEqual([]);
    expect(result.personaPrompt).toBeTruthy(); // personal template has persona
  });

  it("extracts personalDetails from classified events and computes durationDays", async () => {
    const firstEvent = makeEvent({
      id: "e1",
      content: "name: 小明",
      classifiedType: "personal_detail",
      createdAt: new Date(Date.now() - 30 * 86_400_000) // 30 days ago
    });
    const secondEvent = makeEvent({
      id: "e2",
      content: "has a cat named Luna",
      classifiedType: "personal_detail"
    });

    const mockDb = {
      projectScope: { findUnique: vi.fn().mockResolvedValue(baseScope) },
      memoryEvent: {
        findFirst: vi.fn().mockResolvedValue(firstEvent), // oldest event
        findMany: vi.fn()
          .mockResolvedValueOnce([firstEvent, secondEvent]) // personal_detail query
          .mockResolvedValueOnce([])  // feeling query
          .mockResolvedValueOnce([])  // commitment/experience query
      },
      digestStateSnapshot: { findFirst: vi.fn().mockResolvedValue(null) }
    } as any;

    const { buildRelationshipContext } = await import("./relationship-context");
    const result = await buildRelationshipContext("sc-1", mockDb);

    expect(result.durationDays).toBeGreaterThanOrEqual(29);
    expect(result.durationDays).toBeLessThanOrEqual(31);
    expect(result.personalDetails).toEqual(["name: 小明", "has a cat named Luna"]);
  });

  it("returns currentFeeling from recent feeling event, null if none within 7 days", async () => {
    const recentFeeling = makeEvent({
      id: "f1",
      content: "feeling anxious about the presentation",
      classifiedType: "feeling",
      createdAt: new Date(Date.now() - 2 * 86_400_000) // 2 days ago
    });

    const mockDb = {
      projectScope: { findUnique: vi.fn().mockResolvedValue(baseScope) },
      memoryEvent: {
        findFirst: vi.fn()
          .mockResolvedValueOnce(null) // oldest event
          .mockResolvedValueOnce(recentFeeling), // most recent feeling
        findMany: vi.fn()
          .mockResolvedValueOnce([]) // personal_detail
          .mockResolvedValueOnce([]) // commitment/experience
      },
      digestStateSnapshot: { findFirst: vi.fn().mockResolvedValue(null) }
    } as any;

    const { buildRelationshipContext } = await import("./relationship-context");
    const result = await buildRelationshipContext("sc-1", mockDb);

    expect(result.currentFeeling).toBe("feeling anxious about the presentation");
  });

  it("returns pendingFollowUps for old commitment events", async () => {
    const oldCommitment = makeEvent({
      id: "c1",
      content: "promised to call mom this weekend",
      classifiedType: "commitment",
      createdAt: new Date(Date.now() - 10 * 86_400_000) // 10 days ago
    });

    const mockDb = {
      projectScope: { findUnique: vi.fn().mockResolvedValue(baseScope) },
      memoryEvent: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn()
          .mockResolvedValueOnce([]) // personal_detail
          .mockResolvedValueOnce(null) // feeling (findFirst)
          .mockResolvedValueOnce([oldCommitment]) // old commitments
      },
      digestStateSnapshot: { findFirst: vi.fn().mockResolvedValue(null) }
    } as any;

    const { buildRelationshipContext } = await import("./relationship-context");
    const result = await buildRelationshipContext("sc-1", mockDb);

    expect(result.pendingFollowUps).toHaveLength(1);
    expect(result.pendingFollowUps[0]).toContain("promised to call mom");
    expect(result.pendingFollowUps[0]).toContain("10 days ago");
  });
});
```

Run:
```powershell
cd C:\StateCore\StateCore; pnpm --filter @statecore/core test -- relationship-context 2>&1 | Select-Object -Last 15
```
Expected: 4 tests FAIL — module not found.

- [ ] **Step 2: Create relationship-context.ts**

Create `packages/core/src/relationship-context.ts`:

```typescript
import { prisma as defaultPrisma } from "@statecore/db";
import { getDomainConfig } from "./domain-configs/index";

export interface RelationshipContext {
  durationDays: number;
  personalDetails: string[];
  activeGoals: string[];
  currentFeeling: string | null;
  pendingFollowUps: string[];
  personaPrompt: string | null;
}

export async function buildRelationshipContext(
  scopeId: string,
  db: typeof defaultPrisma = defaultPrisma
): Promise<RelationshipContext> {
  const scope = await (db as any).projectScope.findUnique({ where: { id: scopeId } });
  const config = getDomainConfig((scope as any)?.template ?? "project");

  // 1. Duration: days since first event
  const firstEvent = await db.memoryEvent.findFirst({
    where: { scopeId },
    orderBy: { createdAt: "asc" }
  });
  const durationDays = firstEvent
    ? Math.floor((Date.now() - firstEvent.createdAt.getTime()) / 86_400_000)
    : 0;

  // 2. Personal details: all permanent personal_detail classified events
  const personalDetailEvents = await db.memoryEvent.findMany({
    where: { scopeId, classifiedType: "personal_detail" },
    orderBy: { createdAt: "asc" }
  });
  const personalDetails = personalDetailEvents.map((e) => e.content);

  // 3. Active goals: from latest digest state snapshot
  const latestSnapshot = await (db as any).digestStateSnapshot.findFirst({
    where: { scopeId },
    orderBy: { createdAt: "desc" }
  });
  const stableFacts = (latestSnapshot?.state as any)?.stableFacts;
  const activeGoals: string[] = [];
  if (stableFacts?.goal) activeGoals.push(stableFacts.goal);

  // 4. Current feeling: most recent feeling event within 7 days
  const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);
  const recentFeeling = await db.memoryEvent.findFirst({
    where: {
      scopeId,
      classifiedType: "feeling",
      createdAt: { gte: sevenDaysAgo }
    },
    orderBy: { createdAt: "desc" }
  });

  // 5. Pending follow-ups: commitments/experiences older than 7 days (Wave 1: no Jaccard check)
  const sevenDaysAgoDate = new Date(Date.now() - 7 * 86_400_000);
  const oldEvents = await db.memoryEvent.findMany({
    where: {
      scopeId,
      classifiedType: { in: ["commitment", "experience"] },
      createdAt: { lt: sevenDaysAgoDate }
    },
    orderBy: { createdAt: "asc" }, // oldest first
    take: 3
  });
  const pendingFollowUps = oldEvents.map((e) => {
    const daysAgo = Math.floor((Date.now() - e.createdAt.getTime()) / 86_400_000);
    const preview = e.content.length > 60 ? `${e.content.slice(0, 60)}...` : e.content;
    return `${e.classifiedType}: "${preview}" (${daysAgo} days ago)`;
  });

  return {
    durationDays,
    personalDetails,
    activeGoals,
    currentFeeling: recentFeeling?.content ?? null,
    pendingFollowUps,
    personaPrompt: config.defaultPersonaPrompt ?? null
  };
}
```

- [ ] **Step 3: Run tests — verify 4 pass**

```powershell
cd C:\StateCore\StateCore; pnpm --filter @statecore/core test 2>&1 | Select-Object -Last 10
```

Expected: 168 pass (164 + 4 new).

**If tests fail due to mock call order mismatch:** The mock `findMany` is called multiple times. Adjust the `mockResolvedValueOnce` call order to match the actual execution order in `buildRelationshipContext`:
1. `memoryEvent.findMany` call 1 → personal_detail events
2. `memoryEvent.findFirst` (feeling)
3. `memoryEvent.findMany` call 2 → old commitments/experiences

- [ ] **Step 4: Export from packages/core/src/index.ts**

Append to the very end of `packages/core/src/index.ts`:

```typescript
export type { RelationshipContext } from "./relationship-context";
export { buildRelationshipContext } from "./relationship-context";
```

- [ ] **Step 5: Run full test suite**

```powershell
cd C:\StateCore\StateCore; pnpm --filter @statecore/core test 2>&1 | Select-Object -Last 8
```

Expected: 168 pass.

- [ ] **Step 6: Commit**

```powershell
cd C:\StateCore\StateCore
git add packages/core/src/relationship-context.ts packages/core/src/relationship-context.test.ts packages/core/src/index.ts
git commit -m "feat(humanization): add RelationshipContext builder with personal details, feeling, and follow-up detection"
```

---

## Task 3: API Endpoint

**Files:**
- Modify: `apps/api/src/memory.controller.ts`

- [ ] **Step 1: Add the endpoint**

In `apps/api/src/memory.controller.ts`:

1. Add `buildRelationshipContext` to the import from `@statecore/core`:
```typescript
import { ..., buildRelationshipContext } from "@statecore/core";
```

2. Add `prisma` import if not already present:
```typescript
import { prisma } from "@statecore/db";
```

3. Add the new route after the existing `POST /memory/events` handler (or any other convenient location). Search for `@Get("/memory/events")` and add before it:

```typescript
  @Get("/memory/relationship-context/:scopeId")
  async getRelationshipContext(
    @Param("scopeId") scopeId: string,
    @Req() req: RequestWithUser
  ) {
    const scope = await this.domain.projectService.getScope(req.userId, scopeId);
    if (!scope) throw new NotFoundException("Scope not found");
    return buildRelationshipContext(scopeId, prisma);
  }
```

- [ ] **Step 2: Run API tests**

```powershell
cd C:\StateCore\StateCore; pnpm --filter @statecore/api test 2>&1 | Select-Object -Last 8
```

Expected: all unit tests pass.

- [ ] **Step 3: Smoke test against live API**

The API containers are already running. Verify the endpoint responds (requires an existing scope ID):

```powershell
try {
  $r = Invoke-WebRequest -Uri "http://127.0.0.1:3002/scopes" -Headers @{"x-user-id"="local-dev-user"} -UseBasicParsing
  $scopeId = ($r.Content | ConvertFrom-Json).items[0].id
  Invoke-WebRequest -Uri "http://127.0.0.1:3002/memory/relationship-context/$scopeId" -Headers @{"x-user-id"="local-dev-user"} -UseBasicParsing | Select-Object -ExpandProperty Content
} catch { "No scopes or API not running — skip smoke test" }
```

Expected: JSON response with `durationDays`, `personalDetails`, `activeGoals`, `currentFeeling`, `pendingFollowUps`, `personaPrompt`.

- [ ] **Step 4: Commit and push**

```powershell
cd C:\StateCore\StateCore
git add apps/api/src/memory.controller.ts
git commit -m "feat(humanization): add GET /memory/relationship-context/:scopeId endpoint"
git push origin main
```

---

## Self-Review

**Spec coverage:**
| Requirement | Task |
|------------|------|
| `personal_detail` entity type in personal domain | Task 1 ✅ |
| `emotional_pattern` entity type | Task 1 ✅ |
| Updated classify prompt recognises personal_detail | Task 1 ✅ |
| `defaultPersonaPrompt` field in DomainConfig | Task 1 ✅ |
| Persona in personal.ts | Task 1 ✅ |
| Persona in health.ts | Task 1 ✅ |
| `RelationshipContext` interface | Task 2 ✅ |
| `buildRelationshipContext(scopeId, db)` function | Task 2 ✅ |
| `durationDays` computed from first event | Task 2 ✅ |
| `personalDetails` from classifiedType=personal_detail | Task 2 ✅ |
| `activeGoals` from stableFacts.goal | Task 2 ✅ |
| `currentFeeling` from most recent feeling < 7 days | Task 2 ✅ |
| `pendingFollowUps` for old commitments/experiences | Task 2 ✅ |
| `personaPrompt` from domain config | Task 2 ✅ |
| 4 unit tests | Task 2 ✅ |
| Exported from packages/core/src/index.ts | Task 2 ✅ |
| `GET /memory/relationship-context/:scopeId` endpoint | Task 3 ✅ |
| Scope ownership check on endpoint | Task 3 ✅ |

**Placeholder scan:** None found.

**Type consistency:**
- `RelationshipContext` defined in relationship-context.ts, exported from index.ts, referenced in memory.controller.ts via `buildRelationshipContext` return type ✅
- `buildRelationshipContext(scopeId: string, db?)` — consistent between implementation and tests ✅
- `config.defaultPersonaPrompt` — field added to `DomainConfig` in Task 1, used in Task 2 ✅
