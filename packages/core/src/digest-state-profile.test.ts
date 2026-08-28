import { describe, expect, it } from "vitest";
import { normalizeDigestState, applyProfileFactsFromDigest, addNoteFact, type DigestState, type MemoryEvent } from "./digest-control";
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
    expect(groups["喜欢 teal 色"]).toBe("Style");
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

  it("preserves a fact's original createdAt when the same fact is re-extracted by a later digest (no 'just now' re-stamping)", () => {
    const state = emptyState();
    const make = ids();
    const t1 = "2026-06-28T00:00:00.000Z";
    const t2 = "2026-06-29T12:00:00.000Z";
    applyProfileFactsFromDigest(state, [{ facet: "style", value: "喜欢 teal 色" }], [], streamEvidence, make, () => t1);
    // A later digest run re-extracts the identical fact; its timestamp must NOT move.
    applyProfileFactsFromDigest(state, [{ facet: "style", value: "喜欢 teal 色" }], [], streamEvidence, make, () => t2);
    const fact = flattenScopeFacts(state).find((f) => f.text === "喜欢 teal 色");
    expect(fact?.createdAt).toBe(t1);
  });

  it("re-stamps createdAt when an existing fact's content actually changes (correction)", () => {
    const state = emptyState();
    const make = ids();
    const t1 = "2026-06-28T00:00:00.000Z";
    const t2 = "2026-06-29T12:00:00.000Z";
    applyProfileFactsFromDigest(state, [{ facet: "followUps", value: "周四 2 点看牙医" }], [], streamEvidence, make, () => t1);
    applyProfileFactsFromDigest(state, [{ facet: "followUps", value: "周四 3 点看牙医" }], [], streamEvidence, make, () => t2);
    const fact = flattenScopeFacts(state).find((f) => f.group === "Schedule");
    expect(fact?.text).toBe("周四 3 点看牙医");
    expect(fact?.createdAt).toBe(t2);
  });

  it("enforces the per-facet cap (style = 6)", () => {
    const state = emptyState();
    const make = ids();
    for (let i = 0; i < 9; i += 1) {
      applyProfileFactsFromDigest(state, [{ facet: "style", value: `pref-${i}` }], [], streamEvidence, make, now);
    }
    expect(state.profile?.style?.length).toBeLessThanOrEqual(6);
    expect(flattenScopeFacts(state).filter((f) => f.group === "Style").length).toBeLessThanOrEqual(6);
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

  it("surfaces a notes facet under the Notes group", () => {
    const state = emptyState();
    applyProfileFactsFromDigest(
      state,
      [{ facet: "notes", value: "API keys rotate every 90 days" }],
      [], streamEvidence, ids(), now
    );
    const groups = Object.fromEntries(flattenScopeFacts(state).map((f) => [f.text, f.group]));
    expect(groups["API keys rotate every 90 days"]).toBe("Notes");
  });
});

describe("addNoteFact", () => {
  const ids = () => { let n = 0; return () => `id-${++n}`; };
  function emptyState(): DigestState {
    return { stableFacts: { decisions: [] }, workingNotes: {}, todos: [], factRegistry: [], profile: {} };
  }
  it("adds a note that surfaces under Notes with the given timestamp", () => {
    const s = emptyState();
    const added = addNoteFact(s, "API keys rotate every 90 days", ids(), () => "2026-06-29T00:00:00.000Z");
    expect(added.changed).toBe(true);
    expect(added.superseded).toBeUndefined();
    const fact = flattenScopeFacts(s).find((f) => f.group === "Notes");
    expect(fact?.text).toBe("API keys rotate every 90 days");
    expect(fact?.createdAt).toBe("2026-06-29T00:00:00.000Z");
  });
  it("is idempotent on an effectively-identical note", () => {
    const s = emptyState();
    addNoteFact(s, "API keys rotate every 90 days", ids(), () => "t1");
    const again = addNoteFact(s, "API keys rotate every 90 days", ids(), () => "t2");
    expect(again.changed).toBe(false);
    expect(flattenScopeFacts(s).filter((f) => f.group === "Notes")).toHaveLength(1);
    expect(s.factRegistry!.filter((e) => e.facet === "notes")).toHaveLength(1);
  });

  it("enforces the cap of 30 with oldest-eviction and retires the evicted note's registry entry", () => {
    // Behaviour change (2026-08-05): eviction used to splice the registry record
    // out entirely, which broke the audit chain — the fact had been believed and
    // then there was no record it ever had been. The record now stays, marked
    // retired, and only drops out of the *active* set.
    const s = emptyState();
    const make = ids();
    for (let i = 0; i <= 30; i++) {
      addNoteFact(s, `note-${i}`, make, () => `t${i}`);
    }
    expect(s.profile!.notes).toHaveLength(30);
    expect(s.profile!.notes).not.toContain("note-0");
    expect(s.profile!.notes![0]).toBe("note-1");

    const notesEntries = s.factRegistry!.filter((e) => e.facet === "notes");
    expect(notesEntries).toHaveLength(31);

    const active = notesEntries.filter((e) => !e.retiredAt && !e.supersededBy);
    expect(active).toHaveLength(30);
    expect(active.every((e) => e.content !== "note-0")).toBe(true);

    const retired = notesEntries.filter((e) => e.retiredAt);
    expect(retired).toHaveLength(1);
    expect(retired[0].content).toBe("note-0");
    expect(retired[0].retiredReason).toBe("cap_evicted");
  });

  it("retires the exact evicted note, not a fuzzy near-match", () => {
    // The fuzzy matcher strips short numeric tokens, so "note v1" and "note v2"
    // are indistinguishable to it. Eviction must use exact matching or it would
    // retire whichever near-duplicate it happened to find first.
    const s = emptyState();
    const make = ids();
    addNoteFact(s, "API v1 key rotates every 90 days", make, () => "t0");
    for (let i = 1; i <= 30; i++) {
      addNoteFact(s, `note about word${i}x`, make, () => `t${i}`);
    }
    const retired = s.factRegistry!.filter((e) => e.retiredAt);
    expect(retired).toHaveLength(1);
    expect(retired[0].content).toBe("API v1 key rotates every 90 days");
  });

  it("supersedes a high-overlap revision and keeps the old version on the chain", () => {
    // "API v1 key…" → "API v2 key…" is a revision, not a second fact: almost all
    // context tokens are shared, only the version number moved. The new note
    // replaces the old one in the active set, and the old one stays on the
    // record with a supersededBy pointer — nothing is lost, the chain is the point.
    const s = emptyState();
    const make = ids();
    const r1 = addNoteFact(s, "API v1 key rotates every 90 days", make, () => "t1");
    const r2 = addNoteFact(s, "API v2 key rotates every 90 days", make, () => "t2");
    expect(r1.changed).toBe(true);
    expect(r2.changed).toBe(true);
    expect(r2.superseded).toBe("API v1 key rotates every 90 days");

    expect(s.profile!.notes).toEqual(["API v2 key rotates every 90 days"]);

    const entries = s.factRegistry!.filter((e) => e.facet === "notes");
    expect(entries).toHaveLength(2);
    const oldEntry = entries.find((e) => e.content === "API v1 key rotates every 90 days")!;
    const newEntry = entries.find((e) => e.content === "API v2 key rotates every 90 days")!;
    expect(oldEntry.supersededBy).toBe(newEntry.id);
    expect(newEntry.supersededBy).toBeUndefined();
    expect(newEntry.addedAt).toBe("t2");

    const active = flattenScopeFacts(s).filter((f) => f.group === "Notes");
    expect(active).toHaveLength(1);
    expect(active[0].text).toBe("API v2 key rotates every 90 days");
  });

  it("keeps low-overlap notes distinct even when they differ only by a number", () => {
    // Supersession requires most of the note to match. Short notes whose shared
    // portion is small ("note-0" vs "note-1": one shared token of three) stay
    // distinct — the numeric token is preserved by the supersession matcher, so
    // this is not the silent-merge failure the exact-match dedup fix guarded against.
    const s = emptyState();
    const make = ids();
    const r1 = addNoteFact(s, "note-0", make, () => "t1");
    const r2 = addNoteFact(s, "note-1", make, () => "t2");
    expect(r1.changed).toBe(true);
    expect(r2.changed).toBe(true);
    expect(r2.superseded).toBeUndefined();
    expect(s.profile!.notes).toHaveLength(2);
    expect(s.factRegistry!.filter((e) => e.facet === "notes" && !e.supersededBy)).toHaveLength(2);
  });

  it("does not supersede across divergent ASCII content behind similar CJK context", () => {
    // 我决定用PostgreSQL vs 我决定用MySQL: bigram similarity is high, but the
    // ASCII payloads are disjoint — these are different facts, not a revision.
    const s = emptyState();
    const make = ids();
    addNoteFact(s, "我决定这个项目数据库用PostgreSQL来存储", make, () => "t1");
    const r2 = addNoteFact(s, "我决定这个项目数据库用MySQL来存储", make, () => "t2");
    expect(r2.changed).toBe(true);
    expect(r2.superseded).toBeUndefined();
    expect(s.profile!.notes).toHaveLength(2);
  });

  it("supersedes a CJK revision where the context is shared and only the value moves", () => {
    const s = emptyState();
    const make = ids();
    addNoteFact(s, "部署流程改成每周五下午发布到生产环境", make, () => "t1");
    const r2 = addNoteFact(s, "部署流程改成每周三下午发布到生产环境", make, () => "t2");
    expect(r2.changed).toBe(true);
    expect(r2.superseded).toBe("部署流程改成每周五下午发布到生产环境");
    expect(s.profile!.notes).toEqual(["部署流程改成每周三下午发布到生产环境"]);
    const entries = s.factRegistry!.filter((e) => e.facet === "notes");
    const oldEntry = entries.find((e) => e.content.includes("周五"))!;
    const newEntry = entries.find((e) => e.content.includes("周三"))!;
    expect(oldEntry.supersededBy).toBe(newEntry.id);
  });

  it("never matches a retired note for supersession", () => {
    // A note evicted by the cap is out of the active set; re-remembering similar
    // content later is a fresh fact, not a revision of something already retired.
    const s = emptyState();
    const make = ids();
    addNoteFact(s, "API v1 key rotates every 90 days", make, () => "t0");
    for (let i = 1; i <= 30; i++) {
      addNoteFact(s, `note about word${i}x`, make, () => `t${i}`);
    }
    // "API v1 key…" is now retired via cap eviction.
    const r = addNoteFact(s, "API v2 key rotates every 90 days", make, () => "t31");
    expect(r.changed).toBe(true);
    expect(r.superseded).toBeUndefined();
    const v1 = s.factRegistry!.find((e) => e.content === "API v1 key rotates every 90 days")!;
    expect(v1.retiredAt).toBeDefined();
    expect(v1.supersededBy).toBeUndefined();
  });
});
