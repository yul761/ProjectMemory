# Humanization Wave 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add proactive engagement to the AI — friend-like daily reminders with follow-up generation, weekly emotional pattern detection, and a contradiction detection endpoint.

**Architecture:** Three sequential tasks touching three distinct areas. Task 1 upgrades the daily_remind worker prompt and enriches its LLM context. Task 2 adds a new `detect-patterns.ts` helper (following the embed-job.ts / classify-job.ts pattern) with the emotional pattern detection logic, plus a 7-day interval in main.ts. Task 3 adds a testable `check-contradiction.ts` helper and wires a new API endpoint.

**Tech Stack:** TypeScript, BullMQ/setInterval workers, NestJS, Vitest, pnpm workspaces.

---

## File Map

| File | Task | Action |
|------|------|--------|
| `packages/core/src/domain-configs/personal.ts` | 1 | Modify — update `dailyReminderPrompt` |
| `apps/worker/src/main.ts` | 1 | Modify — expand `runDailyRemindJob` context |
| `apps/worker/src/detect-patterns.ts` | 2 | Create — `groupSimilarFeelings` + `runDetectEmotionalPatternsJob` |
| `apps/worker/src/detect-patterns.test.ts` | 2 | Create — unit tests |
| `apps/worker/src/main.ts` | 2 | Modify — import + 7-day interval |
| `apps/api/src/check-contradiction.ts` | 3 | Create — `checkContradiction()` helper |
| `apps/api/src/check-contradiction.test.ts` | 3 | Create — unit tests |
| `apps/api/src/memory.controller.ts` | 3 | Modify — add `POST /memory/check-contradiction` |

---

## Task 1: Enhanced Daily Remind

**Files:**
- Modify: `packages/core/src/domain-configs/personal.ts`
- Modify: `apps/worker/src/main.ts`

No new unit tests — prompt changes are verified by running the existing test suite (168 core, 9 worker).

### Step 1: Update dailyReminderPrompt in personal.ts

In `packages/core/src/domain-configs/personal.ts`, replace the existing `dailyReminderPrompt` string with:

```typescript
  dailyReminderPrompt: `Generate 1-2 short messages that sound like a thoughtful friend checking in.

Priority order:
1. Pending follow-ups — things mentioned but never updated (e.g. "how did that interview go?")
2. Goal progress check-ins — if a goal was set long ago with no recent update
3. A gentle nudge about a commitment or pattern if relevant

Rules:
- Use the person's name or personal details naturally if known and relevant
- Tone: casual, warm, genuinely curious — NOT a task manager
- GOOD: "Hey, how did that interview go last week?"
- BAD: "Reminder: Your commitment 'interview' has been pending 8 days."
- Never reference internal data structures, dates, or IDs
- If nothing compelling to follow up on, return an empty array rather than a generic reminder

Return JSON: { "reminders": string[] }`,
```

### Step 2: Expand context in runDailyRemindJob

In `apps/worker/src/main.ts`, find `runDailyRemindJob()`. Locate the `commitments` query and the `context = JSON.stringify(...)` block (around line 646–659). Replace that entire block with:

```typescript
    const commitments = await prisma.memoryEvent.findMany({
      where: {
        scopeId: scope.id,
        classifiedType: "commitment",
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }]
      },
      orderBy: { createdAt: "desc" },
      take: 10
    });

    // NEW: personal details for natural references
    const personalDetails = await prisma.memoryEvent.findMany({
      where: { scopeId: scope.id, classifiedType: "personal_detail" },
      orderBy: { createdAt: "asc" },
      take: 10
    });

    // NEW: pending follow-ups (commitment/experience older than 7 days)
    const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);
    const pendingFollowUps = await prisma.memoryEvent.findMany({
      where: {
        scopeId: scope.id,
        classifiedType: { in: ["commitment", "experience"] },
        createdAt: { lt: sevenDaysAgo }
      },
      orderBy: { createdAt: "asc" },
      take: 3
    });

    // NEW: known emotional patterns
    const recentPatterns = await prisma.memoryEvent.findMany({
      where: { scopeId: scope.id, classifiedType: "emotional_pattern" },
      orderBy: { createdAt: "desc" },
      take: 5
    });

    const context = JSON.stringify({
      stableFacts: (stateSnapshot.state as any)?.stableFacts ?? {},
      personalDetails: personalDetails.map((e) => e.content),
      commitments: commitments.map((e) => e.content),
      pendingFollowUps: pendingFollowUps.map((e) => {
        const daysAgo = Math.floor((Date.now() - e.createdAt.getTime()) / 86_400_000);
        return `${e.classifiedType}: "${e.content.slice(0, 60)}" (${daysAgo} days ago, no update)`;
      }),
      emotionalPatterns: recentPatterns.map((e) => e.content)
    });
```

### Step 3: Run tests to verify no regressions

```powershell
cd C:\StateCore\StateCore
pnpm --filter @statecore/core test 2>&1 | Select-Object -Last 6
pnpm --filter @statecore/worker test 2>&1 | Select-Object -Last 6
```

Expected: core 168 pass, worker 9 pass.

### Step 4: Commit

```powershell
cd C:\StateCore\StateCore
git add packages/core/src/domain-configs/personal.ts apps/worker/src/main.ts
git commit -m "feat(humanization): enhance daily_remind with personal details, follow-ups, emotional patterns"
```

---

## Task 2: Emotional Pattern Detection

**Files:**
- Create: `apps/worker/src/detect-patterns.ts`
- Create: `apps/worker/src/detect-patterns.test.ts`
- Modify: `apps/worker/src/main.ts`

### Step 1: Write failing tests

Create `apps/worker/src/detect-patterns.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { groupSimilarFeelings } from "./detect-patterns";

function makeFeeling(id: string, content: string, daysAgo = 5) {
  return {
    id,
    content,
    classifiedType: "feeling",
    createdAt: new Date(Date.now() - daysAgo * 86_400_000),
    scopeId: "sc-1"
  };
}

describe("groupSimilarFeelings", () => {
  it("groups feelings that share 2+ tokens into the same cluster", () => {
    const events = [
      makeFeeling("f1", "feeling anxious and stressed"),
      makeFeeling("f2", "very anxious today"),
      makeFeeling("f3", "anxious again this morning"),
      makeFeeling("f4", "happy and energized"),
    ];

    const groups = groupSimilarFeelings(events as any);

    // "anxious" appears in 3 events → one group of 3
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(3);
    expect(groups[0].every(e => e.content.includes("anxious"))).toBe(true);
  });

  it("returns empty array when no group has 3+ events", () => {
    const events = [
      makeFeeling("f1", "feeling anxious"),
      makeFeeling("f2", "anxious today"),   // only 2 — below threshold
      makeFeeling("f3", "happy and fine"),
    ];

    const groups = groupSimilarFeelings(events as any);
    expect(groups).toHaveLength(0);
  });

  it("returns empty array for fewer than 3 total events", () => {
    const events = [makeFeeling("f1", "anxious"), makeFeeling("f2", "anxious today")];
    const groups = groupSimilarFeelings(events as any);
    expect(groups).toHaveLength(0);
  });
});
```

Run: `pnpm --filter @statecore/worker test 2>&1 | Select-Object -Last 15`
Expected: 3 FAIL — `detect-patterns` not found.

### Step 2: Create detect-patterns.ts

Create `apps/worker/src/detect-patterns.ts`:

```typescript
import { prisma as defaultPrisma } from "@statecore/db";
import type { MemoryEvent } from "@statecore/core";

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z一-鿿]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

export function groupSimilarFeelings(events: Pick<MemoryEvent, "id" | "content" | "createdAt">[]): Pick<MemoryEvent, "id" | "content" | "createdAt">[][] {
  const groups: Pick<MemoryEvent, "id" | "content" | "createdAt">[][] = [];

  for (const event of events) {
    const tokens = new Set(tokenize(event.content));
    const match = groups.find((g) =>
      g.some((e) => tokenize(e.content).filter((t) => tokens.has(t)).length >= 2)
    );
    if (match) {
      match.push(event);
    } else {
      groups.push([event]);
    }
  }

  return groups.filter((g) => g.length >= 3);
}

export async function runDetectEmotionalPatternsJob(
  llm: { chat: (messages: { role: string; content: string }[]) => Promise<string> },
  db: typeof defaultPrisma = defaultPrisma
): Promise<void> {
  const scopes = await (db as any).projectScope.findMany({
    where: { template: "personal" }
  });

  for (const scope of scopes) {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000);
    const feelingEvents = await db.memoryEvent.findMany({
      where: {
        scopeId: scope.id,
        classifiedType: "feeling",
        createdAt: { gte: thirtyDaysAgo }
      },
      orderBy: { createdAt: "asc" }
    });

    if (feelingEvents.length < 3) continue;

    const candidateGroups = groupSimilarFeelings(feelingEvents);
    if (!candidateGroups.length) continue;

    // Build LLM input from all feelings (not just candidates) for full context
    const feelingLines = feelingEvents
      .map((e) => `${e.createdAt.toISOString().slice(0, 10)}: ${e.content}`)
      .join("\n");

    let patterns: string[];
    try {
      const raw = await llm.chat([
        {
          role: "system",
          content: `Analyze these feeling events and identify recurring emotional patterns.
Only report patterns that appear 3 or more times.
Be specific about context: time of week, triggers, or situations if evident.
Keep each pattern to one concise sentence.
Examples: "tends to feel anxious on Sunday evenings", "energized and positive after exercise"
Return JSON: { "patterns": string[] }
If no clear patterns: return { "patterns": [] }`
        },
        { role: "user", content: feelingLines }
      ]);
      const parsed = JSON.parse(raw) as { patterns?: string[] };
      patterns = (parsed.patterns ?? [])
        .filter((p) => typeof p === "string" && p.trim().length > 0)
        .slice(0, 5);
    } catch {
      continue; // skip this scope on LLM failure
    }

    if (!patterns.length) continue;

    // Delete old emotional_pattern events for this scope (prevent stale accumulation)
    await db.memoryEvent.deleteMany({
      where: { scopeId: scope.id, classifiedType: "emotional_pattern" }
    });

    // Write new patterns
    for (const pattern of patterns) {
      await db.memoryEvent.create({
        data: {
          userId:        scope.userId,
          scopeId:       scope.id,
          type:          "stream",
          source:        "api",
          content:       pattern,
          classifiedType: "emotional_pattern",
          classifiedImportance: 0.7
        } as any
      });
    }
  }
}
```

### Step 3: Run tests — verify 3 pass

```powershell
cd C:\StateCore\StateCore; pnpm --filter @statecore/worker test 2>&1 | Select-Object -Last 10
```

Expected: 12 pass (9 existing + 3 new).

### Step 4: Wire into main.ts

In `apps/worker/src/main.ts`:

Add import at top alongside other job imports:
```typescript
import { runDetectEmotionalPatternsJob } from "./detect-patterns";
```

At the bottom of the file, after the existing daily_remind interval, add:

```typescript
// detect_emotional_patterns: runs once per week to identify recurring feeling patterns
setInterval(() => {
  if (!llm) return;
  runDetectEmotionalPatternsJob(llm, prisma).catch((err) => {
    logger.error({ err }, "detect_emotional_patterns job crashed");
  });
}, 7 * 24 * 60 * 60 * 1000); // every 7 days
```

### Step 5: Run all tests

```powershell
cd C:\StateCore\StateCore
pnpm --filter @statecore/core test 2>&1 | Select-Object -Last 6
pnpm --filter @statecore/worker test 2>&1 | Select-Object -Last 6
```

Expected: core 168 pass, worker 12 pass.

### Step 6: Commit

```powershell
cd C:\StateCore\StateCore
git add apps/worker/src/detect-patterns.ts apps/worker/src/detect-patterns.test.ts apps/worker/src/main.ts
git commit -m "feat(humanization): add weekly emotional pattern detection job"
```

---

## Task 3: Contradiction Detection Endpoint

**Files:**
- Create: `apps/api/src/check-contradiction.ts`
- Create: `apps/api/src/check-contradiction.test.ts`
- Modify: `apps/api/src/memory.controller.ts`

### Context

In `memory.controller.ts`:
- `this.runtimeLlm` is a `ChatModel | null` — it has a `.chat(messages, options?)` method
- `prisma` is already imported from `@statecore/db`
- NestJS imports already include `Body`, `Post`, `Req`, `NotFoundException`

### Step 1: Write failing tests

Create `apps/api/src/check-contradiction.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";

describe("checkContradiction", () => {
  it("returns hasContradiction=true when content conflicts with a goal", async () => {
    const mockSnapshot = {
      state: {
        stableFacts: {
          goal: "lose 10kg before summer",
          decisions: ["avoid sugar"],
          constraints: []
        }
      }
    };
    const mockDb = {
      digestStateSnapshot: {
        findFirst: vi.fn().mockResolvedValue(mockSnapshot)
      }
    } as any;
    const mockLlm = {
      chat: vi.fn().mockResolvedValue(
        JSON.stringify({ hasContradiction: true, message: "你之前说想减少糖分摄入" })
      )
    };

    const { checkContradiction } = await import("./check-contradiction");
    const result = await checkContradiction("sc-1", "帮我找甜品店", mockLlm, mockDb);

    expect(result.hasContradiction).toBe(true);
    expect(result.message).toContain("糖");
    expect(mockLlm.chat).toHaveBeenCalled();
  });

  it("returns hasContradiction=false when no stableFacts exist", async () => {
    const mockDb = {
      digestStateSnapshot: { findFirst: vi.fn().mockResolvedValue(null) }
    } as any;
    const mockLlm = { chat: vi.fn() };

    const { checkContradiction } = await import("./check-contradiction");
    const result = await checkContradiction("sc-1", "any content", mockLlm, mockDb);

    expect(result.hasContradiction).toBe(false);
    expect(result.message).toBeNull();
    expect(mockLlm.chat).not.toHaveBeenCalled(); // no LLM call needed
  });

  it("returns hasContradiction=false when LLM throws (fail safe)", async () => {
    const mockSnapshot = {
      state: { stableFacts: { goal: "lose weight", decisions: [], constraints: [] } }
    };
    const mockDb = {
      digestStateSnapshot: { findFirst: vi.fn().mockResolvedValue(mockSnapshot) }
    } as any;
    const mockLlm = {
      chat: vi.fn().mockRejectedValue(new Error("LLM unavailable"))
    };

    const { checkContradiction } = await import("./check-contradiction");
    const result = await checkContradiction("sc-1", "eat dessert", mockLlm, mockDb);

    expect(result.hasContradiction).toBe(false);
    expect(result.message).toBeNull();
  });
});
```

Run: `pnpm --filter @statecore/api test 2>&1 | Select-Object -Last 15`
Expected: 3 FAIL — `check-contradiction` not found.

### Step 2: Create check-contradiction.ts

Create `apps/api/src/check-contradiction.ts`:

```typescript
import { prisma as defaultPrisma } from "@statecore/db";

export interface ContradictionResult {
  hasContradiction: boolean;
  message: string | null;
}

export async function checkContradiction(
  scopeId: string,
  content: string,
  llm: { chat: (messages: { role: string; content: string }[]) => Promise<string> },
  db: typeof defaultPrisma = defaultPrisma
): Promise<ContradictionResult> {
  const snapshot = await (db as any).digestStateSnapshot.findFirst({
    where: { scopeId },
    orderBy: { createdAt: "desc" }
  });

  if (!snapshot) return { hasContradiction: false, message: null };

  const stableFacts = (snapshot.state as any)?.stableFacts;
  if (!stableFacts) return { hasContradiction: false, message: null };

  const facts = [
    stableFacts.goal,
    ...(stableFacts.decisions ?? []),
    ...(stableFacts.constraints ?? [])
  ].filter(Boolean).slice(0, 10);

  if (!facts.length) return { hasContradiction: false, message: null };

  try {
    const raw = await llm.chat([
      {
        role: "system",
        content: `You check if a user's request conflicts with their established goals and decisions.
If there is a clear, obvious conflict, return a short natural sentence mentioning the relevant fact — in the same language as the user input.
If no clear conflict or you are uncertain, return no contradiction.
Be gentle, not accusatory.
Return JSON: { "hasContradiction": boolean, "message": string | null }`
      },
      {
        role: "user",
        content: `Established facts:\n${facts.map((f) => `- ${f}`).join("\n")}\n\nUser input: ${content}`
      }
    ]);

    const parsed = JSON.parse(raw) as { hasContradiction?: boolean; message?: string | null };
    return {
      hasContradiction: parsed.hasContradiction === true,
      message: parsed.hasContradiction === true ? (parsed.message ?? null) : null
    };
  } catch {
    return { hasContradiction: false, message: null }; // always fail safe
  }
}
```

### Step 3: Run tests — verify 3 new pass

```powershell
cd C:\StateCore\StateCore; pnpm --filter @statecore/api test 2>&1 | Select-Object -Last 10
```

Expected: 3 new pass (total API unit tests now 17).

### Step 4: Add endpoint to memory.controller.ts

In `apps/api/src/memory.controller.ts`:

1. Add import at top:
```typescript
import { checkContradiction } from "./check-contradiction";
```

2. Find the `z` import (should be present from the webhook endpoint). If not, add:
```typescript
import { z } from "zod";
```

3. Add the new route after `POST /memory/events` handler:

```typescript
  @Post("/memory/check-contradiction")
  async checkContradictionEndpoint(@Req() req: RequestWithUser, @Body() body: unknown) {
    const input = z.object({
      scopeId: z.string().uuid(),
      content: z.string().min(1).max(500)
    }).parse(body);

    const scope = await this.domain.projectService.getScope(req.userId, input.scopeId);
    if (!scope) throw new NotFoundException("Scope not found");

    if (!this.runtimeLlm) {
      return { hasContradiction: false, message: null };
    }

    return checkContradiction(input.scopeId, input.content, this.runtimeLlm, prisma);
  }
```

### Step 5: Run all tests

```powershell
cd C:\StateCore\StateCore
pnpm --filter @statecore/core test 2>&1 | Select-Object -Last 6
pnpm --filter @statecore/worker test 2>&1 | Select-Object -Last 6
pnpm --filter @statecore/api test 2>&1 | Select-Object -Last 6
```

Expected: core 168 pass, worker 12 pass, API unit 17 pass.

### Step 6: Commit and push

```powershell
cd C:\StateCore\StateCore
git add apps/api/src/check-contradiction.ts apps/api/src/check-contradiction.test.ts apps/api/src/memory.controller.ts
git commit -m "feat(humanization): add POST /memory/check-contradiction endpoint"
git push origin main
```

---

## Self-Review

**Spec coverage:**
| Requirement | Task |
|------------|------|
| Enhanced `dailyReminderPrompt` (friend-like, follow-up focused) | Task 1 ✅ |
| `runDailyRemindJob` context includes personalDetails, pendingFollowUps, emotionalPatterns | Task 1 ✅ |
| `groupSimilarFeelings` groups events with 2+ shared tokens | Task 2 ✅ |
| `runDetectEmotionalPatternsJob` reads feelings, groups, calls LLM, deletes old + writes new emotional_pattern events | Task 2 ✅ |
| 7-day interval in main.ts | Task 2 ✅ |
| `checkContradiction(scopeId, content, llm, db)` extracts facts, calls LLM, returns `{ hasContradiction, message }` | Task 3 ✅ |
| Fails safe on LLM error (returns `{ hasContradiction: false }`) | Task 3 ✅ |
| `POST /memory/check-contradiction` endpoint with ownership check | Task 3 ✅ |
| All existing tests pass | Verified in each task ✅ |

**Placeholder scan:** None found.

**Type consistency:**
- `groupSimilarFeelings` takes `Pick<MemoryEvent, "id" | "content" | "createdAt">[]` — consistent between detect-patterns.ts and test ✅
- `runDetectEmotionalPatternsJob(llm, db)` — consistent between detect-patterns.ts and main.ts ✅
- `checkContradiction(scopeId, content, llm, db)` — consistent between check-contradiction.ts and test + controller ✅
- `ContradictionResult` — exported from check-contradiction.ts, used by controller return type ✅
