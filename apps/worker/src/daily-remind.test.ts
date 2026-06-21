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
