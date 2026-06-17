import { describe, it, expect, vi } from "vitest";

describe("runClassifyEventJob", () => {
  it("classifies event and writes classifiedType + classifiedImportance to DB", async () => {
    const mockEvent = { id: "evt-1", content: "I decided to quit sugar", scopeId: "sc-1" };
    const mockScope = { id: "sc-1", template: "personal" };
    const mockPrisma = {
      memoryEvent:  { findUnique: vi.fn().mockResolvedValue(mockEvent), update: vi.fn().mockResolvedValue(mockEvent) },
      projectScope: { findUnique: vi.fn().mockResolvedValue(mockScope) }
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
    const expectedExpiry = new Date(before + 7 * 86_400_000);
    expect(updateCall.data.expiresAt.getTime()).toBeGreaterThan(before);
    expect(updateCall.data.expiresAt.getTime()).toBeLessThanOrEqual(expectedExpiry.getTime() + 5000);
  });

  it("skips silently when LLM throws — no crash, no DB update", async () => {
    const mockEvent = { id: "evt-3", content: "something", scopeId: "sc-1" };
    const mockScope = { id: "sc-1", template: "personal" };
    const mockPrisma = {
      memoryEvent:  { findUnique: vi.fn().mockResolvedValue(mockEvent), update: vi.fn() },
      projectScope: { findUnique: vi.fn().mockResolvedValue(mockScope) }
    } as any;
    const mockLlm = { chat: vi.fn().mockRejectedValue(new Error("LLM timeout")) };

    const { runClassifyEventJob } = await import("./classify-job");
    await expect(
      runClassifyEventJob({ eventId: "evt-3", scopeId: "sc-1" }, mockLlm, mockPrisma)
    ).resolves.toBeUndefined();

    expect(mockPrisma.memoryEvent.update).not.toHaveBeenCalled();
  });
});
