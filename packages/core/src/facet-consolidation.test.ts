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

import { applyFacetConsolidation, ConsolidationSchema, type ConsolidatedFact } from "./facet-consolidation";
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

describe("applyFacetConsolidation", () => {
  const ids = () => { let n = 0; return () => `new-${++n}`; };
  const now = () => "2026-07-01T00:00:00.000Z";

  function stateWith(facet: string, entries: Array<{ content: string; addedAt: string; confidence?: number }>): DigestState {
    return {
      stableFacts: { decisions: [] }, workingNotes: {}, todos: [],
      profile: { [facet]: entries.map((e) => e.content) } as DigestState["profile"],
      factRegistry: entries.map((e, i) => ({
        id: `old-${i}`, content: e.content, type: "profile" as const,
        confidence: e.confidence ?? 0.7, addedAt: e.addedAt,
        evidenceId: `ev-${i}`, evidenceType: "event" as const, facet
      }))
    };
  }

  it("merges two paraphrases into one fact carrying the EARLIEST addedAt", () => {
    const state = stateWith("identity", [
      { content: "居住地：Richmond（你提到的居住地）", addedAt: "2026-06-28T00:00:00.000Z" },
      { content: "住在 Richmond", addedAt: "2026-06-30T00:00:00.000Z" }
    ]);
    const result: ConsolidatedFact[] = [{ text: "住在 Richmond", mergedFrom: [0, 1] }];
    const ok = applyFacetConsolidation(state, "identity", ["居住地：Richmond（你提到的居住地）", "住在 Richmond"], result, ids(), now);
    expect(ok).toBe(true);
    expect(state.profile?.identity).toEqual(["住在 Richmond"]);
    const entries = (state.factRegistry ?? []).filter((e) => e.facet === "identity" && !e.supersededBy);
    expect(entries).toHaveLength(1);
    expect(entries[0].addedAt).toBe("2026-06-28T00:00:00.000Z"); // earliest wins, NOT now()
  });

  it("drops an item that no output references (cross-facet dedupe)", () => {
    const state = stateWith("notes", [
      { content: "用量追踪：显示已用/剩余", addedAt: "2026-06-30T00:00:00.000Z" },
      { content: "狗：Friday 与 Tully", addedAt: "2026-06-29T00:00:00.000Z" }
    ]);
    const result: ConsolidatedFact[] = [{ text: "用量追踪：显示已用/剩余", mergedFrom: [0] }];
    const ok = applyFacetConsolidation(state, "notes", ["用量追踪：显示已用/剩余", "狗：Friday 与 Tully"], result, ids(), now);
    expect(ok).toBe(true);
    expect(state.profile?.notes).toEqual(["用量追踪：显示已用/剩余"]);
    expect((state.factRegistry ?? []).some((e) => e.content.includes("狗"))).toBe(false);
  });

  it("fails open (no mutation) when an output has an out-of-range source index", () => {
    const state = stateWith("style", [{ content: "喜欢 teal 色", addedAt: "2026-06-28T00:00:00.000Z" }]);
    const before = JSON.parse(JSON.stringify(state));
    const ok = applyFacetConsolidation(state, "style", ["喜欢 teal 色"], [{ text: "x", mergedFrom: [5] }], ids(), now);
    expect(ok).toBe(false);
    expect(state).toEqual(before);
  });

  it("schema rejects malformed shapes", () => {
    expect(ConsolidationSchema.safeParse([{ text: "ok", mergedFrom: [0] }]).success).toBe(true);
    expect(ConsolidationSchema.safeParse([{ text: "", mergedFrom: [0] }]).success).toBe(false);
    expect(ConsolidationSchema.safeParse([{ text: "x" }]).success).toBe(false);
  });
});

import { consolidateFacetLlm, consolidateChangedFacets, consolidateAllProfileFacets } from "./facet-consolidation";

// Inline prompt strings — core has NO dependency on @statecore/prompts, so tests
// must not import from it. consolidateFacetLlm takes the prompts as parameters.
const SYS = "Return ONLY JSON [{text, mergedFrom}]. Merge duplicates. Do not invent.";
const USR = "Facet: {{facet}} — {{facetDescription}}\nItems:\n{{items}}\nOthers:\n{{siblings}}";

function fakeLlm(responses: string[]) {
  let i = 0;
  const calls: { role: string; content: string }[][] = [];
  return {
    calls,
    chat: async (m: { role: "system" | "user"; content: string }[]) => { calls.push(m); return responses[Math.min(i++, responses.length - 1)]; }
  };
}

describe("consolidateFacetLlm", () => {
  const base = {
    facet: "identity", description: "personal facts",
    items: ["住在 Richmond", "居住地：Richmond"],
    siblings: { style: ["喜欢 teal 色"] },
    systemPrompt: SYS, userPromptTemplate: USR
  };

  it("parses a valid JSON array response", async () => {
    const llm = fakeLlm(['[{"text":"住在 Richmond","mergedFrom":[0,1]}]']);
    const out = await consolidateFacetLlm({ ...base, llm });
    expect(out).toEqual([{ text: "住在 Richmond", mergedFrom: [0, 1] }]);
    // items + siblings were rendered into the user prompt
    expect(llm.calls[0][1].content).toMatch(/住在 Richmond/);
    expect(llm.calls[0][1].content).toMatch(/teal/);
  });

  it("retries once with a fix instruction then succeeds", async () => {
    const llm = fakeLlm(["not json", '[{"text":"住在 Richmond","mergedFrom":[0]}]']);
    const out = await consolidateFacetLlm({ ...base, llm, maxRetries: 1 });
    expect(out).toEqual([{ text: "住在 Richmond", mergedFrom: [0] }]);
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1][1].content).toMatch(/not a valid JSON array/);
  });

  it("returns null (fail-open) when all attempts are unparseable", async () => {
    const llm = fakeLlm(["garbage", "still garbage"]);
    expect(await consolidateFacetLlm({ ...base, llm, maxRetries: 1 })).toBeNull();
  });

  it("renders (none) when there are no sibling facets", async () => {
    const llm = fakeLlm(['[{"text":"住在 Richmond","mergedFrom":[0]}]']);
    await consolidateFacetLlm({ ...base, siblings: {}, llm });
    expect(llm.calls[0][1].content).toMatch(/\(none\)/);
  });
});

describe("consolidateChangedFacets", () => {
  const ids = () => { let n = 0; return () => `n-${++n}`; };
  const now = () => "2026-07-01T00:00:00.000Z";
  const PROMPTS = { systemPrompt: "sys", userPromptTemplate: "u {{items}}" };

  function stateWithFacets(facets: Record<string, string[]>): DigestState {
    const registry = Object.entries(facets).flatMap(([facet, items]) =>
      items.map((content, i) => ({ id: `${facet}-${i}`, content, type: "profile" as const, confidence: 0.7,
        addedAt: `2026-06-2${i}T00:00:00.000Z`, evidenceId: `e-${facet}-${i}`, evidenceType: "event" as const, facet })));
    return { stableFacts: { decisions: [] }, workingNotes: {}, todos: [], profile: facets as DigestState["profile"], factRegistry: registry };
  }

  it("consolidates only changed facets with >= 4 items, skipping others", async () => {
    const state = stateWithFacets({
      identity: ["a", "a2", "a3", "a4"],       // changed + 4 items → consolidate
      style: ["s1", "s2"]                       // changed but < 4 → skip
    });
    const llm = { chat: async () => '[{"text":"A","mergedFrom":[0,1,2,3]}]' };
    const changed = await consolidateChangedFacets({ state, changedFacets: ["identity", "style"], llm, prompts: PROMPTS, makeId: ids(), makeNow: now, minItems: 4 });
    expect(changed).toEqual(["identity"]);
    expect(state.profile?.identity).toEqual(["A"]);
    expect(state.profile?.style).toEqual(["s1", "s2"]); // untouched
  });

  it("does not touch a facet that did not change this run", async () => {
    const state = stateWithFacets({ notes: ["n1", "n2", "n3", "n4", "n5"] });
    const llm = { chat: async () => '[{"text":"X","mergedFrom":[0]}]' };
    const changed = await consolidateChangedFacets({ state, changedFacets: ["style"], llm, prompts: PROMPTS, makeId: ids(), makeNow: now });
    expect(changed).toEqual([]);
    expect(state.profile?.notes).toHaveLength(5);
  });

  it("fails open if the LLM errors (facet left unchanged)", async () => {
    const state = stateWithFacets({ identity: ["a", "a2", "a3", "a4"] });
    const llm = { chat: async () => { throw new Error("boom"); } };
    const changed = await consolidateChangedFacets({ state, changedFacets: ["identity"], llm, prompts: PROMPTS, makeId: ids(), makeNow: now });
    expect(changed).toEqual([]);
    expect(state.profile?.identity).toHaveLength(4);
  });

  it("consolidateAllProfileFacets runs over all facets with >= 2 items", async () => {
    const state = stateWithFacets({ identity: ["a", "a2"], style: ["s1"] });
    const llm = { chat: async () => '[{"text":"merged","mergedFrom":[0,1]}]' };
    const changed = await consolidateAllProfileFacets({ state, llm, prompts: PROMPTS, makeId: ids(), makeNow: now });
    expect(changed).toEqual(["identity"]); // style has 1 item → skipped
    expect(state.profile?.identity).toEqual(["merged"]);
  });
});
