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
      digestStateSnapshot: { findFirst: vi.fn().mockResolvedValue(mockSnapshot) }
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
    expect(mockLlm.chat).not.toHaveBeenCalled();
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
