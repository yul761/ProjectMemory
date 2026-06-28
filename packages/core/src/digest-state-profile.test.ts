import { describe, expect, it } from "vitest";
import { normalizeDigestState, applyProfileFactsFromDigest, type DigestState, type MemoryEvent } from "./digest-control";
import { flattenScopeFacts } from "./memory-facts";
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

describe("applyProfileFactsFromDigest — conversational facets", () => {
  const streamEvidence = { id: "evt-1", sourceType: "event" as const };
  const ids = () => { let n = 0; return () => `id-${++n}`; };
  const now = () => "2026-06-28T00:00:00.000Z";

  function emptyState(): DigestState {
    return { stableFacts: { decisions: [] }, workingNotes: {}, todos: [], factRegistry: [], profile: {} };
  }

  it("stores each displayable facet into state.profile and surfaces it via flattenScopeFacts", () => {
    const state = emptyState();
    applyProfileFactsFromDigest(
      state,
      [
        { facet: "style", value: "喜欢 teal 色" },
        { facet: "goals", value: "想减肥" },
        { facet: "relationships", value: "妈妈住在上海" },
        { facet: "followUps", value: "周四 2 点看牙医" },
        { facet: "ongoing", value: "在做盲盒生意" }
      ],
      [],
      streamEvidence,
      ids(),
      now
    );
    expect(state.profile?.style).toContain("喜欢 teal 色");
    expect(state.profile?.goals).toContain("想减肥");
    expect(state.profile?.relationships).toContain("妈妈住在上海");
    expect(state.profile?.followUps).toContain("周四 2 点看牙医");
    expect(state.profile?.ongoing).toContain("在做盲盒生意");

    const groups = Object.fromEntries(
      flattenScopeFacts(state).map((f) => [f.text, f.group])
    );
    expect(groups["喜欢 teal 色"]).toBe("Preferences");
    expect(groups["想减肥"]).toBe("Projects");
    expect(groups["妈妈住在上海"]).toBe("People");
    expect(groups["周四 2 点看牙医"]).toBe("Schedule");
  });

  it("ignores unknown facets and empty values", () => {
    const state = emptyState();
    applyProfileFactsFromDigest(
      state,
      [{ facet: "weather", value: "sunny" }, { facet: "style", value: "  " }],
      [], streamEvidence, ids(), now
    );
    expect(flattenScopeFacts(state)).toHaveLength(0);
  });

  it("dedups near-duplicate facts within a facet", () => {
    const state = emptyState();
    const make = ids();
    applyProfileFactsFromDigest(state, [{ facet: "style", value: "喜欢 teal 色" }], [], streamEvidence, make, now);
    applyProfileFactsFromDigest(state, [{ facet: "style", value: "喜欢 teal 色" }], [], streamEvidence, make, now);
    expect(state.profile?.style).toHaveLength(1);
  });

  it("enforces the per-facet cap (style = 6)", () => {
    const state = emptyState();
    const make = ids();
    for (let i = 0; i < 9; i += 1) {
      applyProfileFactsFromDigest(state, [{ facet: "style", value: `pref-${i}` }], [], streamEvidence, make, now);
    }
    expect(state.profile?.style?.length).toBeLessThanOrEqual(6);
  });

  it("still applies identity from documents (regression)", () => {
    const state = emptyState();
    const doc = { id: "doc-1", scopeId: "s", type: "document", source: "api", key: "resume", content: "resume", createdAt: new Date() } as unknown as MemoryEvent;
    applyProfileFactsFromDigest(
      state,
      [{ facet: "identity", value: "工作经历: 字节跳动 后端 2019-2022" }],
      [doc], null, ids(), now
    );
    expect(state.profile?.identity).toContain("工作经历: 字节跳动 后端 2019-2022");
  });
});
