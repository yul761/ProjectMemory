import { describe, it, expect } from "vitest";
import { consistencyCheck, type DigestState, type FactRegistryEntry } from "./digest-control";

function fact(over: Partial<FactRegistryEntry> = {}): FactRegistryEntry {
  return {
    id: "f1",
    content: "工作经历: 字节跳动 后端工程师 2019-2022",
    type: "profile",
    confidence: 0.85,
    addedAt: "2026-01-01T00:00:00.000Z",
    evidenceId: "doc-1",
    evidenceType: "document",
    facet: "identity",
    ...over
  };
}

function stateWith(entries: FactRegistryEntry[]): DigestState {
  return { stableFacts: {}, todos: [], factRegistry: entries } as unknown as DigestState;
}

const neutralOutput = {
  summary: "用户分享了一些工作相关的信息。",
  changes: ["记录了背景信息"],
  nextSteps: ["无需行动"]
};

describe("consistencyCheck — what it does and does not defend", () => {
  it("flags a protected fact that the digest prose contradicts", () => {
    const result = consistencyCheck({
      output: {
        summary: "用户说他在字节跳动的工作经历是错误的，应当移除。",
        changes: ["更正背景"],
        nextSteps: ["确认信息"]
      },
      protectedState: stateWith([fact()])
    });

    expect(result.errors).toContain("profile_identity_contradiction");
  });

  it("does NOT flag two contradictory facts coexisting in the registry", () => {
    // Pins the known gap. consistencyCheck reads the digest's *prose*; it has no
    // view of whether the resulting state now holds two incompatible facts. This
    // is the accumulation case, and nothing currently detects it.
    const result = consistencyCheck({
      output: neutralOutput,
      protectedState: stateWith([
        fact({ id: "f1", content: "工作经历: 字节跳动 后端工程师 2019-2022" }),
        fact({ id: "f2", content: "工作经历: 某小公司 初级工程师 2019-2022", confidence: 0.6 })
      ])
    });

    expect(result.errors).not.toContain("profile_identity_contradiction");
  });

  it("ignores a retired fact when checking for contradictions", () => {
    // A retired fact is no longer believed. Letting it raise a contradiction
    // would fail digests over a belief the engine has already abandoned.
    const result = consistencyCheck({
      output: {
        summary: "用户说他在字节跳动的工作经历是错误的，应当移除。",
        changes: ["更正背景"],
        nextSteps: ["确认信息"]
      },
      protectedState: stateWith([
        fact({ retiredAt: "2026-08-01T00:00:00.000Z", retiredReason: "cap_evicted" })
      ])
    });

    expect(result.errors).not.toContain("profile_identity_contradiction");
  });
});
