import { describe, expect, it } from "vitest";
import { stripInternalIds } from "./facet-consolidation";

describe("stripInternalIds", () => {
  it("removes a Chinese （提醒 ID：<uuid>） parenthetical and tidies trailing separators", () => {
    const input = "2026-07-04 20:00 · Fan Fest 买票提醒（提醒 ID：aa6e283a-aaa6-4f13-81f5-31c341633de3）";
    expect(stripInternalIds(input)).toBe("2026-07-04 20:00 · Fan Fest 买票提醒");
  });

  it("removes an English (reminder id: <uuid>) parenthetical", () => {
    const input = "Pick up wife's flight (reminder id: 4b8f8e02-8583-4ca2-8082-b1eef2f7dcd1)";
    expect(stripInternalIds(input)).toBe("Pick up wife's flight");
  });

  it("removes a bare UUID left inline", () => {
    expect(stripInternalIds("买票 4b8f8e02-8583-4ca2-8082-b1eef2f7dcd1 提醒")).toBe("买票 提醒");
  });

  it("leaves clean text untouched", () => {
    expect(stripInternalIds("周四 2 点看牙医")).toBe("周四 2 点看牙医");
  });
});

import { applyProfileFactsFromDigest, type DigestState } from "./digest-control";

describe("applyProfileFactsFromDigest — ID sanitizing", () => {
  const streamEvidence = { id: "evt-1", sourceType: "event" as const };
  const ids = () => { let n = 0; return () => `id-${++n}`; };
  const now = () => "2026-06-28T00:00:00.000Z";
  const emptyState = (): DigestState => ({ stableFacts: { decisions: [] }, workingNotes: {}, todos: [], factRegistry: [], profile: {} });

  it("stores followUps text with the reminder-ID parenthetical stripped", () => {
    const state = emptyState();
    applyProfileFactsFromDigest(
      state,
      [{ facet: "followUps", value: "去接太太的飞机（提醒 ID：4b8f8e02-8583-4ca2-8082-b1eef2f7dcd1）" }],
      [], streamEvidence, ids(), now
    );
    expect(state.profile?.followUps).toEqual(["去接太太的飞机"]);
    expect(JSON.stringify(state.factRegistry)).not.toMatch(/4b8f8e02/);
  });
});
