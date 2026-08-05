import { describe, it, expect } from "vitest";
import { checkContradiction } from "./check-contradiction";

function db(state: unknown) {
  return {
    digestStateSnapshot: { findFirst: async () => (state ? { state } : null) }
  } as never;
}

function captureLlm() {
  const seen: string[] = [];
  return {
    seen,
    llm: {
      chat: async (messages: { role: string; content: string }[]) => {
        seen.push(messages[messages.length - 1].content);
        return JSON.stringify({ hasContradiction: false, message: null });
      }
    }
  };
}

describe("checkContradiction fact coverage", () => {
  it("includes write-protected profile facts, not just stableFacts", async () => {
    const { seen, llm } = captureLlm();
    await checkContradiction(
      "s1",
      "我其实没在字节跳动待过",
      llm,
      db({
        stableFacts: { goal: "上线 Remi" },
        factRegistry: [
          {
            id: "f1",
            type: "profile",
            facet: "identity",
            content: "工作经历: 字节跳动 后端工程师 2019-2022"
          }
        ]
      })
    );

    expect(seen[0]).toContain("工作经历: 字节跳动 后端工程师 2019-2022");
    expect(seen[0]).toContain("上线 Remi");
  });

  it("excludes superseded and retired facts", async () => {
    const { seen, llm } = captureLlm();
    await checkContradiction(
      "s1",
      "随便说点什么",
      llm,
      db({
        stableFacts: {},
        factRegistry: [
          { id: "f1", type: "profile", content: "已被取代的事实", supersededBy: "f2" },
          { id: "f2", type: "profile", content: "已退休的事实", retiredAt: "2026-08-01T00:00:00.000Z" },
          { id: "f3", type: "profile", content: "当前有效的事实" }
        ]
      })
    );

    expect(seen[0]).toContain("当前有效的事实");
    expect(seen[0]).not.toContain("已被取代的事实");
    expect(seen[0]).not.toContain("已退休的事实");
  });

  it("returns no contradiction when the scope has no snapshot", async () => {
    const { llm } = captureLlm();
    const result = await checkContradiction("s1", "x", llm, db(null));
    expect(result).toEqual({ hasContradiction: false, message: null });
  });
});
