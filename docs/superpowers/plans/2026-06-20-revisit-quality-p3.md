# P3 Revisit Quality — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve proactive recall quality in `runDailyRemindJob` by (1) making it testable via `(llm, prisma)` params, (2) enriching revisit context with P1 profile facets (`goals`/`ongoing`/`followUps`/`relationships`), and (3) suppressing repeated reminders by querying recent `sent` Reminder rows and persisting newly generated ones. No schema changes; no changes to jot, digest, retrieval, or webhook delivery.

**Architecture:** Two implementation tasks plus a verification task. Task 1 extracts `runDailyRemindJob` to its own module (`daily-remind.ts`) with injectable `(llm, prisma)` params — mirroring `runDetectEmotionalPatternsJob` — and enriches the context object with `state.profile` facets. Task 2 layers repeat-suppression: a Reminder query before the LLM call (14-day window, status=sent) produces a `recentlySurfaced` list fed into the context; after a successful webhook post the generated reminders are written as `status="sent"` Reminder rows (inert to `send_reminders` which only takes `status="scheduled"`). Task 3 runs the full vitest suite and tsc build.

**Tech Stack:** TypeScript, Prisma (existing `Reminder` table, `ReminderStatus.sent`), Vitest (`vi.fn` mocks, `vi.stubGlobal`), pnpm workspaces.

---

## Global Constraints

_Copied verbatim from spec §2 and §6 non-negotiables:_

- Reuse existing `Reminder` table — **no schema changes**.
- Write new Reminder rows with `status: "sent"` so `send_reminders` job (which only takes `status: "scheduled" & dueAt <= now`) is never triggered by them.
- Do **not** include `identity` or `style` profile facets in revisit context (archive facts / voice settings, not revisit-worthy).
- Keep the **friend-style tone** in `dailyReminderPrompt`; new profile fields are additive only.
- Do **not** change webhook delivery mechanism (still `fetch` POST to `scope.notificationWebhook`).
- Do **not** change jot, classify, digest, or retrieval pipelines.
- Node toolchain: `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"` before node/pnpm commands.
- Worker test command: `pnpm --filter @statecore/worker test -- <pattern>` (package name is `@statecore/worker`, test runner is `vitest run`).
- Full build check: `pnpm build` from repo root, expect tsc exit 0.
- Suppression window is 14 days (hardcoded; adjustable later).

---

## File Map

| File | Task | Action |
|------|------|--------|
| `apps/worker/src/daily-remind.ts` | 1 | **Create** — extracted + refactored job function |
| `apps/worker/src/daily-remind.test.ts` | 1, 2 | **Create** — new test file, all 6 scenarios |
| `apps/worker/src/main.ts` | 1 | **Modify** — remove inline function, import, update setInterval call site |
| `packages/core/src/domain-configs/personal.ts` | 1, 2 | **Modify** — update `dailyReminderPrompt` twice (profile fields Task 1, recentlySurfaced Task 2) |

---

## Task 1 — Testability Refactor + Enrich Context

### Files
- **Create:** `apps/worker/src/daily-remind.ts`
- **Create:** `apps/worker/src/daily-remind.test.ts` (Task 1 tests: enrichment, cold-start, no-webhook)
- **Modify:** `apps/worker/src/main.ts` lines 630–724 (remove function body, add import, update setInterval)
- **Modify:** `packages/core/src/domain-configs/personal.ts` lines 59–74 (`dailyReminderPrompt`)

### Interfaces

**Consumes:**
```typescript
// llm shape (same as runDetectEmotionalPatternsJob)
type Llm = { chat: (messages: { role: "system" | "user"; content: string }[]) => Promise<string> };

// db shape (typeof import("@statecore/db").prisma — passed as defaultPrisma)
// DigestState.profile (from packages/core/src/digest-control.ts):
//   profile?: { goals?: string[]; ongoing?: string[]; followUps?: string[]; relationships?: string[]; identity?: string[]; style?: string[] }
```

**Produces:**
```typescript
// New exported function signature
export async function runDailyRemindJob(
  llm: Llm,
  db: typeof defaultPrisma = defaultPrisma
): Promise<void>
```

---

### Step 1.1 — Write failing tests (RED)

Create `apps/worker/src/daily-remind.test.ts` with three Task-1 scenarios. File does **not** exist yet — create it.

```typescript
// apps/worker/src/daily-remind.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── helpers ────────────────────────────────────────────────────────────────

type LlmMock = { chat: ReturnType<typeof vi.fn> };

function makeScope(overrides: Partial<{
  id: string;
  userId: string;
  template: string;
  notificationWebhook: string | null;
}> = {}) {
  return {
    id: "sc-1",
    userId: "u-1",
    template: "personal",
    notificationWebhook: "http://example.com/hook",
    ...overrides
  };
}

function makeStateSnapshot(profile: {
  goals?: string[];
  ongoing?: string[];
  followUps?: string[];
  relationships?: string[];
} = {}) {
  return {
    state: {
      stableFacts: { name: "Alex" },
      profile
    }
  };
}

function makePrisma(opts: {
  scopes?: any[];
  snapshot?: any;
  recentSentReminders?: any[];
} = {}) {
  const scopes = opts.scopes ?? [makeScope()];
  const snapshot = opts.snapshot ?? makeStateSnapshot({ goals: ["想学吉他"], ongoing: ["找工作中"] });

  return {
    projectScope: {
      findMany: vi.fn().mockResolvedValue(scopes)
    },
    digestStateSnapshot: {
      findFirst: vi.fn().mockResolvedValue(snapshot)
    },
    memoryEvent: {
      // 4 sequential calls: commitments, personalDetails, pendingFollowUps, recentPatterns
      findMany: vi.fn()
        .mockResolvedValueOnce([])  // commitments
        .mockResolvedValueOnce([])  // personalDetails
        .mockResolvedValueOnce([])  // pendingFollowUps
        .mockResolvedValueOnce([])  // recentPatterns
    },
    reminder: {
      findMany: vi.fn().mockResolvedValue(opts.recentSentReminders ?? []),
      create: vi.fn().mockResolvedValue({})
    }
  } as any;
}

function makeLlm(responseText = JSON.stringify({ reminders: ["How's the guitar practice going?"] })): LlmMock {
  return { chat: vi.fn().mockResolvedValue(responseText) };
}

// ─── test suites ─────────────────────────────────────────────────────────────

describe("runDailyRemindJob — Task 1: enrichment + testability", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
  });

  it("T1-1: LLM receives context containing profile.goals and profile.ongoing", async () => {
    const mockPrisma = makePrisma();
    const mockLlm = makeLlm();
    const { runDailyRemindJob } = await import("./daily-remind");

    await runDailyRemindJob(mockLlm as any, mockPrisma);

    expect(mockLlm.chat).toHaveBeenCalledOnce();
    const userMessage: string = mockLlm.chat.mock.calls[0][0].find(
      (m: { role: string }) => m.role === "user"
    ).content;
    const parsed = JSON.parse(userMessage);
    expect(parsed.profile.goals).toEqual(["想学吉他"]);
    expect(parsed.profile.ongoing).toEqual(["找工作中"]);
  });

  it("T1-2: missing profile → context profile fields are empty arrays, no crash", async () => {
    // snapshot with no profile at all
    const mockPrisma = makePrisma({ snapshot: { state: { stableFacts: {} } } });
    const mockLlm = makeLlm();
    const { runDailyRemindJob } = await import("./daily-remind");

    await expect(runDailyRemindJob(mockLlm as any, mockPrisma)).resolves.toBeUndefined();

    const userMessage: string = mockLlm.chat.mock.calls[0][0].find(
      (m: { role: string }) => m.role === "user"
    ).content;
    const parsed = JSON.parse(userMessage);
    expect(parsed.profile.goals).toEqual([]);
    expect(parsed.profile.ongoing).toEqual([]);
    expect(parsed.profile.followUps).toEqual([]);
    expect(parsed.profile.relationships).toEqual([]);
  });

  it("T1-3: scope without notificationWebhook is skipped (LLM never called)", async () => {
    const mockPrisma = makePrisma({
      scopes: [makeScope({ notificationWebhook: null })]
    });
    const mockLlm = makeLlm();
    const { runDailyRemindJob } = await import("./daily-remind");

    await runDailyRemindJob(mockLlm as any, mockPrisma);

    expect(mockLlm.chat).not.toHaveBeenCalled();
  });
});
```

Run (should FAIL — module doesn't exist yet):
```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"
pnpm --filter @statecore/worker test -- daily-remind
```

---

### Step 1.2 — Create `daily-remind.ts` (GREEN)

Create `apps/worker/src/daily-remind.ts`. This is the extracted, refactored version of `runDailyRemindJob`.

**Before (inline in `apps/worker/src/main.ts`, lines 630–717):**
```typescript
async function runDailyRemindJob() {
  if (!llm) return;
  const scopes = await prisma.projectScope.findMany({
    where: { notificationWebhook: { not: null } }
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

    const personalDetails = await prisma.memoryEvent.findMany({
      where: { scopeId: scope.id, classifiedType: "personal_detail" },
      orderBy: { createdAt: "asc" },
      take: 10
    });

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
```

**After (new `apps/worker/src/daily-remind.ts`):**
```typescript
import { prisma as defaultPrisma } from "@statecore/db";
import { getDomainConfig, logger } from "@statecore/core";

type Llm = { chat: (messages: { role: "system" | "user"; content: string }[]) => Promise<string> };

export async function runDailyRemindJob(
  llm: Llm,
  db: typeof defaultPrisma = defaultPrisma
): Promise<void> {
  const scopes = await (db as any).projectScope.findMany({
    where: { notificationWebhook: { not: null } }
  });

  for (const scope of scopes) {
    const config = getDomainConfig((scope as any).template ?? "project");
    if (!config.dailyReminderPrompt) continue;
    if (!scope.notificationWebhook) continue;

    const stateSnapshot = await db.digestStateSnapshot.findFirst({
      where: { scopeId: scope.id },
      orderBy: { createdAt: "desc" }
    });
    if (!stateSnapshot) continue;

    const commitments = await db.memoryEvent.findMany({
      where: {
        scopeId: scope.id,
        classifiedType: "commitment",
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }]
      },
      orderBy: { createdAt: "desc" },
      take: 10
    });

    const personalDetails = await db.memoryEvent.findMany({
      where: { scopeId: scope.id, classifiedType: "personal_detail" },
      orderBy: { createdAt: "asc" },
      take: 10
    });

    const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);
    const pendingFollowUps = await db.memoryEvent.findMany({
      where: {
        scopeId: scope.id,
        classifiedType: { in: ["commitment", "experience"] },
        createdAt: { lt: sevenDaysAgo }
      },
      orderBy: { createdAt: "asc" },
      take: 3
    });

    const recentPatterns = await db.memoryEvent.findMany({
      where: { scopeId: scope.id, classifiedType: "emotional_pattern" },
      orderBy: { createdAt: "desc" },
      take: 5
    });

    const state = stateSnapshot.state as any;

    const context = JSON.stringify({
      stableFacts: state?.stableFacts ?? {},
      personalDetails: personalDetails.map((e) => e.content),
      commitments: commitments.map((e) => e.content),
      pendingFollowUps: pendingFollowUps.map((e) => {
        const daysAgo = Math.floor((Date.now() - (e as any).createdAt.getTime()) / 86_400_000);
        return `${(e as any).classifiedType}: "${e.content.slice(0, 60)}" (${daysAgo} days ago, no update)`;
      }),
      emotionalPatterns: recentPatterns.map((e) => e.content),
      profile: {
        goals: state?.profile?.goals ?? [],
        ongoing: state?.profile?.ongoing ?? [],
        followUps: state?.profile?.followUps ?? [],
        relationships: state?.profile?.relationships ?? []
      }
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
```

Run tests (should now be GREEN):
```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"
pnpm --filter @statecore/worker test -- daily-remind
```

---

### Step 1.3 — Update `main.ts` call site

**Before (lines 630–724 of `apps/worker/src/main.ts`):**
```typescript
// Line 630–717: the entire inline runDailyRemindJob function body (shown above)

// Line 719–724:
// Run daily_remind once per day (24h)
setInterval(() => {
  runDailyRemindJob().catch((err) => {
    logger.error({ err }, "daily_remind job crashed");
  });
}, 24 * 60 * 60 * 1000);
```

**After:**

In `apps/worker/src/main.ts`:

1. Add to the existing imports block (near line 25, alongside the `runDetectEmotionalPatternsJob` import):
```typescript
import { runDailyRemindJob } from "./daily-remind";
```

2. Delete lines 630–717 (the entire inline `runDailyRemindJob` function body).

3. Replace the `setInterval` block (was lines 719–724) with:
```typescript
// Run daily_remind once per day (24h)
setInterval(() => {
  if (!llm) return;
  runDailyRemindJob(llm, prisma).catch((err) => {
    logger.error({ err }, "daily_remind job crashed");
  });
}, 24 * 60 * 60 * 1000);
```

---

### Step 1.4 — Update `dailyReminderPrompt` (Task 1 version — add profile fields)

In `packages/core/src/domain-configs/personal.ts`, replace the `dailyReminderPrompt` field.

**Before (lines 59–74):**
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

**After (Task 1 version — add profile context description; recentlySurfaced added in Task 2):**
```typescript
  dailyReminderPrompt: `Generate 1-2 short messages that sound like a thoughtful friend checking in.

Context available:
- profile.goals: things the person wants to achieve (e.g. "想学吉他", "learn piano")
- profile.ongoing: things currently happening in their life (e.g. "找工作中", "job search")
- profile.followUps: specific things to check back on
- profile.relationships: people in their life
- pendingFollowUps: older commitments/experiences with no recent update

Priority order:
1. Pending follow-ups from profile.followUps or pendingFollowUps — things mentioned but never revisited
2. Goal or ongoing-situation check-in — ask how a goal (profile.goals) or current situation (profile.ongoing) is going
3. A gentle nudge about a commitment or emotional pattern if relevant

Rules:
- Use the person's name or personal details naturally if known and relevant
- Tone: casual, warm, genuinely curious — NOT a task manager
- GOOD: "Hey, how's the guitar practice going?" / "Any news on the job hunt?"
- BAD: "Reminder: Your goal '想学吉他' has been pending 8 days."
- Never reference internal data structures, field names, dates, or IDs
- If nothing compelling to follow up on, return an empty array rather than a generic reminder

Return JSON: { "reminders": string[] }`,
```

---

### Step 1.5 — Run existing worker tests + confirm no regression

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"
pnpm --filter @statecore/worker test
```

All existing tests (detect-patterns, classify-job, digest-lock, embed-job) plus the 3 new daily-remind tests must be GREEN.

---

### Step 1.6 — Commit

```bash
git add apps/worker/src/daily-remind.ts \
        apps/worker/src/daily-remind.test.ts \
        apps/worker/src/main.ts \
        packages/core/src/domain-configs/personal.ts
git commit -m "$(cat <<'EOF'
feat(revisit): extract runDailyRemindJob(llm,prisma) + enrich context with P1 profile facets

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2 — Repeat-Suppression

### Files
- **Modify:** `apps/worker/src/daily-remind.ts` — add suppression query + persistence
- **Modify:** `apps/worker/src/daily-remind.test.ts` — add 3 Task-2 scenarios
- **Modify:** `packages/core/src/domain-configs/personal.ts` — add `recentlySurfaced` instruction to `dailyReminderPrompt`

### Interfaces

**Consumes (new DB access):**
```typescript
// suppression query — called once per scope before context build
db.reminder.findMany({
  where: { scopeId: scope.id, status: "sent", createdAt: { gt: fourteenDaysAgo } },
  orderBy: { createdAt: "desc" }
})
// returns: Array<{ text: string; ... }>

// persistence — called after successful webhook post, once per reminder string
db.reminder.create({
  data: {
    userId: scope.userId,
    scopeId: scope.id,
    text: reminder,
    status: "sent",
    dueAt: new Date()
  }
})
```

**Produces (context shape, after Task 2):**
```typescript
// context JSON now includes:
{
  stableFacts: ...,
  personalDetails: string[],
  commitments: string[],
  pendingFollowUps: string[],
  emotionalPatterns: string[],
  profile: { goals: string[]; ongoing: string[]; followUps: string[]; relationships: string[] },
  recentlySurfaced: string[]   // ← NEW: texts of sent Reminder rows in last 14 days
}
```

---

### Step 2.1 — Write failing Task-2 tests (RED)

Append three new `describe` blocks to `apps/worker/src/daily-remind.test.ts`.

> Note: vitest caches module imports within a test file. Because Task 1 tests already `await import("./daily-remind")`, Task 2 tests that call the same function will reuse the cached module. This is fine — both sets of tests are in the same file and the implementation is updated in place between task commits.

```typescript
// Append to apps/worker/src/daily-remind.test.ts (after the Task-1 describe block)

describe("runDailyRemindJob — Task 2: repeat-suppression", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
  });

  it("T2-1: recent sent reminder text appears in context recentlySurfaced list", async () => {
    const recentSentReminders = [
      { id: "r-1", text: "How's the guitar practice going?", status: "sent", createdAt: new Date() }
    ];
    const mockPrisma = makePrisma({ recentSentReminders });
    const mockLlm = makeLlm();
    const { runDailyRemindJob } = await import("./daily-remind");

    await runDailyRemindJob(mockLlm as any, mockPrisma);

    const userMessage: string = mockLlm.chat.mock.calls[0][0].find(
      (m: { role: string }) => m.role === "user"
    ).content;
    const parsed = JSON.parse(userMessage);
    expect(parsed.recentlySurfaced).toContain("How's the guitar practice going?");
  });

  it("T2-2: generated reminders are persisted as sent Reminder rows with correct scopeId", async () => {
    const mockPrisma = makePrisma();
    const twoReminders = JSON.stringify({
      reminders: ["How's the guitar practice going?", "Any news on the job hunt?"]
    });
    const mockLlm = makeLlm(twoReminders);
    const { runDailyRemindJob } = await import("./daily-remind");

    await runDailyRemindJob(mockLlm as any, mockPrisma);

    expect(mockPrisma.reminder.create).toHaveBeenCalledTimes(2);
    expect(mockPrisma.reminder.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "u-1",
          scopeId: "sc-1",
          text: "How's the guitar practice going?",
          status: "sent"
        })
      })
    );
    expect(mockPrisma.reminder.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          scopeId: "sc-1",
          text: "Any news on the job hunt?",
          status: "sent"
        })
      })
    );
  });

  it("T2-3: suppression query filters by scopeId (scope isolation)", async () => {
    const mockPrisma = makePrisma();
    const mockLlm = makeLlm();
    const { runDailyRemindJob } = await import("./daily-remind");

    await runDailyRemindJob(mockLlm as any, mockPrisma);

    expect(mockPrisma.reminder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          scopeId: "sc-1",
          status: "sent"
        })
      })
    );
  });
});
```

Run (should FAIL — `db.reminder.findMany` not yet called in code, `recentlySurfaced` not in context):
```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"
pnpm --filter @statecore/worker test -- daily-remind
```

---

### Step 2.2 — Implement suppression in `daily-remind.ts` (GREEN)

**Before (suppression-related section — none; full context block from Task 1):**
```typescript
    // (no suppression query here)

    const state = stateSnapshot.state as any;

    const context = JSON.stringify({
      stableFacts: state?.stableFacts ?? {},
      personalDetails: personalDetails.map((e) => e.content),
      commitments: commitments.map((e) => e.content),
      pendingFollowUps: pendingFollowUps.map((e) => {
        const daysAgo = Math.floor((Date.now() - (e as any).createdAt.getTime()) / 86_400_000);
        return `${(e as any).classifiedType}: "${e.content.slice(0, 60)}" (${daysAgo} days ago, no update)`;
      }),
      emotionalPatterns: recentPatterns.map((e) => e.content),
      profile: {
        goals: state?.profile?.goals ?? [],
        ongoing: state?.profile?.ongoing ?? [],
        followUps: state?.profile?.followUps ?? [],
        relationships: state?.profile?.relationships ?? []
      }
    });

    // ... (LLM call, then webhook with no persistence)
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
```

**After (with suppression query before context + persistence after webhook):**
```typescript
    const state = stateSnapshot.state as any;

    // ── suppression: fetch recent sent reminders for this scope ─────────────
    const fourteenDaysAgo = new Date(Date.now() - 14 * 86_400_000);
    const recentSentRows = await db.reminder.findMany({
      where: {
        scopeId: scope.id,
        status: "sent",
        createdAt: { gt: fourteenDaysAgo }
      },
      orderBy: { createdAt: "desc" }
    });
    const recentlySurfaced = recentSentRows.map((r) => r.text);

    const context = JSON.stringify({
      stableFacts: state?.stableFacts ?? {},
      personalDetails: personalDetails.map((e) => e.content),
      commitments: commitments.map((e) => e.content),
      pendingFollowUps: pendingFollowUps.map((e) => {
        const daysAgo = Math.floor((Date.now() - (e as any).createdAt.getTime()) / 86_400_000);
        return `${(e as any).classifiedType}: "${e.content.slice(0, 60)}" (${daysAgo} days ago, no update)`;
      }),
      emotionalPatterns: recentPatterns.map((e) => e.content),
      profile: {
        goals: state?.profile?.goals ?? [],
        ongoing: state?.profile?.ongoing ?? [],
        followUps: state?.profile?.followUps ?? [],
        relationships: state?.profile?.relationships ?? []
      },
      recentlySurfaced
    });

    // ... LLM call (unchanged) ...

    // ── webhook delivery ─────────────────────────────────────────────────────
    try {
      await fetch(scope.notificationWebhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scopeId: scope.id, reminders })
      });
      logger.info({ scopeId: scope.id, count: reminders.length }, "Daily reminders sent");

      // ── persistence: write each reminder as a sent Reminder row ───────────
      for (const text of reminders) {
        await db.reminder.create({
          data: {
            userId: (scope as any).userId,
            scopeId: scope.id,
            text,
            status: "sent",
            dueAt: new Date()
          } as any
        });
      }
    } catch (err) {
      logger.warn({ scopeId: scope.id, err }, "daily_remind webhook delivery failed");
    }
```

Complete final `apps/worker/src/daily-remind.ts` (the entire file, after both Task 1 and Task 2 changes):
```typescript
import { prisma as defaultPrisma } from "@statecore/db";
import { getDomainConfig, logger } from "@statecore/core";

type Llm = { chat: (messages: { role: "system" | "user"; content: string }[]) => Promise<string> };

export async function runDailyRemindJob(
  llm: Llm,
  db: typeof defaultPrisma = defaultPrisma
): Promise<void> {
  const scopes = await (db as any).projectScope.findMany({
    where: { notificationWebhook: { not: null } }
  });

  for (const scope of scopes) {
    const config = getDomainConfig((scope as any).template ?? "project");
    if (!config.dailyReminderPrompt) continue;
    if (!scope.notificationWebhook) continue;

    const stateSnapshot = await db.digestStateSnapshot.findFirst({
      where: { scopeId: scope.id },
      orderBy: { createdAt: "desc" }
    });
    if (!stateSnapshot) continue;

    const commitments = await db.memoryEvent.findMany({
      where: {
        scopeId: scope.id,
        classifiedType: "commitment",
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }]
      },
      orderBy: { createdAt: "desc" },
      take: 10
    });

    const personalDetails = await db.memoryEvent.findMany({
      where: { scopeId: scope.id, classifiedType: "personal_detail" },
      orderBy: { createdAt: "asc" },
      take: 10
    });

    const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);
    const pendingFollowUps = await db.memoryEvent.findMany({
      where: {
        scopeId: scope.id,
        classifiedType: { in: ["commitment", "experience"] },
        createdAt: { lt: sevenDaysAgo }
      },
      orderBy: { createdAt: "asc" },
      take: 3
    });

    const recentPatterns = await db.memoryEvent.findMany({
      where: { scopeId: scope.id, classifiedType: "emotional_pattern" },
      orderBy: { createdAt: "desc" },
      take: 5
    });

    const state = stateSnapshot.state as any;

    // Suppression: fetch reminder texts sent in the last 14 days for this scope
    const fourteenDaysAgo = new Date(Date.now() - 14 * 86_400_000);
    const recentSentRows = await db.reminder.findMany({
      where: {
        scopeId: scope.id,
        status: "sent",
        createdAt: { gt: fourteenDaysAgo }
      },
      orderBy: { createdAt: "desc" }
    });
    const recentlySurfaced = recentSentRows.map((r) => r.text);

    const context = JSON.stringify({
      stableFacts: state?.stableFacts ?? {},
      personalDetails: personalDetails.map((e) => e.content),
      commitments: commitments.map((e) => e.content),
      pendingFollowUps: pendingFollowUps.map((e) => {
        const daysAgo = Math.floor((Date.now() - (e as any).createdAt.getTime()) / 86_400_000);
        return `${(e as any).classifiedType}: "${e.content.slice(0, 60)}" (${daysAgo} days ago, no update)`;
      }),
      emotionalPatterns: recentPatterns.map((e) => e.content),
      profile: {
        goals: state?.profile?.goals ?? [],
        ongoing: state?.profile?.ongoing ?? [],
        followUps: state?.profile?.followUps ?? [],
        relationships: state?.profile?.relationships ?? []
      },
      recentlySurfaced
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

      // Persist each generated reminder as a sent row to suppress future repetition
      for (const text of reminders) {
        await db.reminder.create({
          data: {
            userId: (scope as any).userId,
            scopeId: scope.id,
            text,
            status: "sent",
            dueAt: new Date()
          } as any
        });
      }
    } catch (err) {
      logger.warn({ scopeId: scope.id, err }, "daily_remind webhook delivery failed");
    }
  }
}
```

Run tests (all 6 must be GREEN):
```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"
pnpm --filter @statecore/worker test -- daily-remind
```

---

### Step 2.3 — Update `dailyReminderPrompt` (Task 2 version — add `recentlySurfaced` instruction)

In `packages/core/src/domain-configs/personal.ts`, update `dailyReminderPrompt` again.

**Before (Task 1 version):**
```typescript
  dailyReminderPrompt: `Generate 1-2 short messages that sound like a thoughtful friend checking in.

Context available:
- profile.goals: things the person wants to achieve (e.g. "想学吉他", "learn piano")
- profile.ongoing: things currently happening in their life (e.g. "找工作中", "job search")
- profile.followUps: specific things to check back on
- profile.relationships: people in their life
- pendingFollowUps: older commitments/experiences with no recent update

Priority order:
1. Pending follow-ups from profile.followUps or pendingFollowUps — things mentioned but never revisited
2. Goal or ongoing-situation check-in — ask how a goal (profile.goals) or current situation (profile.ongoing) is going
3. A gentle nudge about a commitment or emotional pattern if relevant

Rules:
- Use the person's name or personal details naturally if known and relevant
- Tone: casual, warm, genuinely curious — NOT a task manager
- GOOD: "Hey, how's the guitar practice going?" / "Any news on the job hunt?"
- BAD: "Reminder: Your goal '想学吉他' has been pending 8 days."
- Never reference internal data structures, field names, dates, or IDs
- If nothing compelling to follow up on, return an empty array rather than a generic reminder

Return JSON: { "reminders": string[] }`,
```

**After (Task 2 final version — adds `recentlySurfaced` context entry + no-repeat rule):**
```typescript
  dailyReminderPrompt: `Generate 1-2 short messages that sound like a thoughtful friend checking in.

Context available:
- profile.goals: things the person wants to achieve (e.g. "想学吉他", "learn piano")
- profile.ongoing: things currently happening in their life (e.g. "找工作中", "job search")
- profile.followUps: specific things to check back on
- profile.relationships: people in their life
- pendingFollowUps: older commitments/experiences with no recent update
- recentlySurfaced: reminders already sent to this person in the last 14 days — do NOT repeat these

Priority order:
1. Pending follow-ups from profile.followUps or pendingFollowUps — things mentioned but never revisited
2. Goal or ongoing-situation check-in — ask how a goal (profile.goals) or current situation (profile.ongoing) is going
3. A gentle nudge about a commitment or emotional pattern if relevant

Rules:
- Use the person's name or personal details naturally if known and relevant
- Tone: casual, warm, genuinely curious — NOT a task manager
- GOOD: "Hey, how's the guitar practice going?" / "Any news on the job hunt?"
- BAD: "Reminder: Your goal '想学吉他' has been pending 8 days."
- Never reference internal data structures, field names, dates, or IDs
- Never surface a topic already covered in recentlySurfaced — pick something fresh
- If nothing compelling (or everything was already surfaced), return an empty array

Return JSON: { "reminders": string[] }`,
```

---

### Step 2.4 — Send_reminders non-regression note

`send_reminders` job (in `apps/worker/src/main.ts`) queries:
```typescript
where: { status: "scheduled", dueAt: { lte: new Date() } }
```
The new `status: "sent"` rows written by `runDailyRemindJob` are never `status: "scheduled"`, so they are invisible to `send_reminders`. No code change needed. This is verified implicitly by the existing worker test suite passing.

---

### Step 2.5 — Run full worker suite

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"
pnpm --filter @statecore/worker test
```

All tests (detect-patterns ×3, classify-job ×2, digest-lock ×2, embed-job ×2, daily-remind ×6) must be GREEN.

---

### Step 2.6 — Commit

```bash
git add apps/worker/src/daily-remind.ts \
        apps/worker/src/daily-remind.test.ts \
        packages/core/src/domain-configs/personal.ts
git commit -m "$(cat <<'EOF'
feat(revisit): add repeat-suppression — 14-day sent-reminder avoid-list + persist generated reminders

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3 — Verification

### Step 3.1 — Full worker test suite (green)

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"
pnpm --filter @statecore/worker test
```

Expected: all tests pass, exit 0.

### Step 3.2 — Full monorepo tsc build (green)

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"
pnpm build
```

Expected: tsc exits 0, no type errors in `apps/worker/src/daily-remind.ts` or modified `personal.ts`.

> Note: `tsconfig.json` for the worker (`"include": ["src"]`) will compile `daily-remind.test.ts` too. This is consistent with existing behavior (all other `*.test.ts` files are already included in `src/` and the build passes). If tsc rejects vitest imports, add `"exclude": ["src/**/*.test.ts"]` to `apps/worker/tsconfig.json` — but this is not expected to be needed since the base config already has `skipLibCheck: true` and existing tests compile fine.

### Step 3.3 — Manual spot-check (no benchmark)

Revisit quality has no automated benchmark (spec §6: "prompt change impact on revisit quality → human audit"). After deploy, inspect one `personal` scope that has `state.profile.goals` populated and verify:
- The LLM call's user-message JSON contains `profile.goals` with real data.
- After a successful webhook, a `Reminder` row with `status="sent"` appears in the DB for that scope.

### Step 3.4 — Commit (if not already clean)

If any fixup commits were needed in 3.2:
```bash
git add -p
git commit -m "$(cat <<'EOF'
fix(revisit): tsc build fixes for daily-remind extraction

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review: Spec Requirements → Task Coverage

| Spec §5 Acceptance Criterion | Covered by |
|------------------------------|-----------|
| `runDailyRemindJob(llm, prisma)` receives params; `setInterval` call site updated | Task 1 Steps 1.2, 1.3 |
| revisit context contains `profile.goals`/`ongoing`/`followUps`/`relationships` | Task 1 Step 1.2 (context object in `daily-remind.ts`) |
| Tests: profile.goals/ongoing values appear in LLM context (T1-1) | Task 1 Step 1.1 |
| Tests: missing profile → empty arrays, no crash (T1-2) | Task 1 Step 1.1 |
| Tests: scope without `notificationWebhook` skipped (T1-3) | Task 1 Step 1.1 |
| `dailyReminderPrompt` references profile fields + avoid-repeat instruction | Task 1 Step 1.4, Task 2 Step 2.3 |
| Prevention: near 14-day `sent` Reminder texts as avoid-list in context (`recentlySurfaced`) | Task 2 Step 2.2 |
| Tests: recentlySurfaced list in context (T2-1) | Task 2 Step 2.1 |
| Persistence: generated reminders written as `Reminder` rows with `status="sent"` after webhook | Task 2 Step 2.2 |
| Tests: `reminder.create` called with `status: "sent"` + correct `scopeId` (T2-2) | Task 2 Step 2.1 |
| Tests: suppression query scoped by `scopeId` (T2-3) | Task 2 Step 2.1 |
| `send_reminders` unaffected (reads `status="scheduled"` only) | Task 2 Step 2.4 (no-code note) |
| Full worker test suite green | Task 3 Step 3.1 |
| `pnpm build` tsc exit 0 | Task 3 Step 3.2 |
| No schema change | All tasks — reuse `Reminder` table with existing `ReminderStatus.sent` enum value |
| Identity/style NOT in revisit context | Task 1 Step 1.2 — only goals/ongoing/followUps/relationships added |
| Friend-style tone preserved | Task 1 Step 1.4, Task 2 Step 2.3 — additive wording only |
| Webhook delivery unchanged | Task 2 Step 2.2 — `fetch` POST identical, persistence added after it |
