import { describe, it, expect, vi, beforeEach } from "vitest";
import { clearFacetPackCache } from "@statecore/core";

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


describe("classification vocabulary follows the tenant's pack", () => {
  // The resolver caches by user id for 60s, so tests sharing a user id would
  // otherwise inherit each other's pack.
  beforeEach(() => clearFacetPackCache());

  function dbWith(facetPack: unknown) {
    return {
      memoryEvent: {
        findUnique: async () => ({ id: "e1", content: "本案已于 9 月开庭", scopeId: "s1" }),
        update: async () => ({})
      },
      projectScope: { findUnique: async () => ({ id: "s1", userId: "u1", template: "personal" }) },
      user: { findUnique: async () => ({ facetPack }) }
    } as never;
  }

  function captureLlm(entityType = "case_event") {
    const seen: string[] = [];
    return {
      seen,
      llm: {
        chat: async (m: { role: string; content: string }[]) => {
          seen.push(m[0].content);
          return JSON.stringify({ entityType, importance: 0.9 });
        }
      }
    };
  }

  it("offers the pack's own types when a custom pack is installed", async () => {
    const { seen, llm } = captureLlm();
    const { runClassifyEventJob } = await import("./classify-job");
    await runClassifyEventJob(
      { eventId: "e1", scopeId: "s1" },
      llm,
      dbWith({
        name: "legal",
        facets: [
          {
            name: "matter",
            cap: 50,
            writeProtected: true,
            displayGroup: "Matters",
            routesFrom: ["case_event"],
            description: "case matters"
          }
        ]
      })
    );

    expect(seen[0]).toContain('"case_event"');
    expect(seen[0]).not.toContain("personal_detail");
  });

  it("leaves tenants on the default pack on their domain config prompt", async () => {
    const { seen, llm } = captureLlm("personal_detail");
    const { runClassifyEventJob } = await import("./classify-job");
    await runClassifyEventJob({ eventId: "e1", scopeId: "s1" }, llm, dbWith(null));

    expect(seen[0]).toContain("personal");
    expect(seen[0]).not.toContain('"case_event"');
  });
});
