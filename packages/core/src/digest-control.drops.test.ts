import { describe, it, expect } from "vitest";
import { applyProfileFactsFromDigest, type DigestState } from "./digest-control";
import type { DropRecord } from "./drop-log";

function emptyState(): DigestState {
  return { stableFacts: {}, factRegistry: [] } as unknown as DigestState;
}

const NOW = () => "2026-08-05T00:00:00.000Z";

describe("digest drop recording", () => {
  it("records facet_not_registered instead of dropping silently", () => {
    const state = emptyState();
    const dropLog: DropRecord[] = [];
    applyProfileFactsFromDigest(
      state,
      [{ facet: "legal_matter", value: "案件 A 已结案" }],
      [],
      null,
      () => "id-1",
      NOW,
      dropLog
    );
    expect(dropLog).toHaveLength(1);
    expect(dropLog[0].reason).toBe("facet_not_registered");
    expect(dropLog[0].detail).toMatchObject({ facet: "legal_matter" });
  });

  it("still accepts registered facets without logging a drop", () => {
    const state = emptyState();
    const dropLog: DropRecord[] = [];
    applyProfileFactsFromDigest(
      state,
      [{ facet: "goals", value: "想减肥" }],
      [],
      null,
      () => "id-2",
      NOW,
      dropLog
    );
    expect(dropLog).toHaveLength(0);
    expect(state.profile?.goals).toContain("想减肥");
  });

  it("records cap_evicted when a volatile facet overflows", () => {
    const state = emptyState();
    const dropLog: DropRecord[] = [];
    // style cap is 6; push 7 genuinely distinct values through. They must not be
    // near-duplicates — the CJK-aware dedup strips short numeric tokens, so
    // "风格 1"/"风格 2" would collapse into one fact and never reach the cap.
    const facts = [
      { facet: "style", value: "喜欢简洁的回答" },
      { facet: "style", value: "重要决定前先看数据" },
      { facet: "style", value: "讨厌被反复追问" },
      { facet: "style", value: "偏爱深色界面主题" },
      { facet: "style", value: "开会安排在下午两点以后" },
      { facet: "style", value: "沟通用中文而不是英文" },
      { facet: "style", value: "文档要先给结论再给细节" }
    ];
    let n = 0;
    applyProfileFactsFromDigest(state, facts, [], null, () => `id-${n++}`, NOW, dropLog);

    const evictions = dropLog.filter((d) => d.reason === "cap_evicted");
    expect(evictions).toHaveLength(1);
    expect(evictions[0].detail).toMatchObject({ facet: "style", cap: 6 });
  });

  it("works without a drop log (parameter stays optional)", () => {
    const state = emptyState();
    expect(() =>
      applyProfileFactsFromDigest(state, [{ facet: "notes", value: "记一笔" }], [], null, () => "id", NOW)
    ).not.toThrow();
    expect(state.profile?.notes).toContain("记一笔");
  });
});
