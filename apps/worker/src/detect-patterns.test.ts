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

    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(3);
    expect(groups[0].every((e: any) => e.content.includes("anxious"))).toBe(true);
  });

  it("returns empty array when no group has 3+ events", () => {
    const events = [
      makeFeeling("f1", "feeling anxious"),
      makeFeeling("f2", "anxious today"),
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
