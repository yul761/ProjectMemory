import { describe, expect, it } from "vitest";
import { normalizeDigestState, type DigestState } from "./digest-control";
import { DigestState as DigestStateZod, StateLayerView as StateLayerViewZod } from "@statecore/contracts";

describe("DigestState profile — types and contracts", () => {
  it("DigestState with profile round-trips through normalizeDigestState without data loss", () => {
    const state: DigestState = {
      stableFacts: { decisions: [], goal: "find a job" },
      workingNotes: {},
      todos: [],
      factRegistry: [],
      profile: {
        identity: ["工作经历: 字节跳动 后端工程师 2019-2022"],
        relationships: [],
        ongoing: [],
        goals: [],
        followUps: []
      }
    };
    const normalized = normalizeDigestState(state);
    expect(normalized.profile?.identity).toEqual(["工作经历: 字节跳动 后端工程师 2019-2022"]);
  });

  it("DigestState with profile and facet-tagged factRegistry entry round-trips through Zod schema", () => {
    const raw = {
      stableFacts: { decisions: [] },
      workingNotes: {},
      todos: [],
      profile: {
        identity: ["工作经历: 字节跳动 后端工程师 2019-2022"]
      }
    };
    const result = DigestStateZod.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.profile?.identity?.[0]).toBe("工作经历: 字节跳动 后端工程师 2019-2022");
    }
  });

  it("StateLayerView Zod schema accepts identity field", () => {
    const raw = {
      goal: "find a job",
      constraints: [],
      decisions: [],
      todos: [],
      openQuestions: [],
      risks: [],
      identity: ["工作经历: 字节跳动 后端工程师 2019-2022"]
    };
    const result = StateLayerViewZod.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.identity?.[0]).toBe("工作经历: 字节跳动 后端工程师 2019-2022");
    }
  });
});
