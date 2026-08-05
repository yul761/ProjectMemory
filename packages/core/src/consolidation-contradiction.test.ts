import { describe, it, expect } from "vitest";
import { consolidateChangedFacets, applyFacetConsolidation } from "./facet-consolidation";
import { getActiveFactRegistry, type DigestState, type FactRegistryEntry } from "./digest-control";
import { consolidateFacetSystemPrompt, consolidateFacetUserPrompt } from "../../prompts/src/index";

function entry(over: Partial<FactRegistryEntry> = {}): FactRegistryEntry {
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

/** Two incompatible employment histories, one from a document and one from chat. */
function contradictedState(): DigestState {
  return {
    stableFacts: {},
    todos: [],
    factRegistry: [
      entry({ id: "f-doc", content: "工作经历: 字节跳动 后端工程师 2019-2022" }),
      entry({
        id: "f-chat",
        content: "工作经历: 某小公司 初级工程师 2019-2022",
        confidence: 0.6,
        evidenceId: "evt-9",
        evidenceType: "event"
      })
    ],
    profile: {
      identity: ["工作经历: 字节跳动 后端工程师 2019-2022", "工作经历: 某小公司 初级工程师 2019-2022"]
    }
  } as unknown as DigestState;
}

describe("consolidation resolves contradictions", () => {
  it("labels each item with its provenance so the model can choose a side", async () => {
    const seen: string[] = [];
    const llm = {
      chat: async (messages: { role: string; content: string }[]) => {
        seen.push(messages[messages.length - 1].content);
        return JSON.stringify([
          { text: "工作经历: 字节跳动 后端工程师 2019-2022", mergedFrom: [0] }
        ]);
      }
    };

    await consolidateChangedFacets({
      state: contradictedState(),
      changedFacets: ["identity"],
      llm,
      prompts: { systemPrompt: consolidateFacetSystemPrompt, userPromptTemplate: consolidateFacetUserPrompt },
      makeId: () => "new-1",
      makeNow: () => "2026-08-05T00:00:00.000Z",
      minItems: 2
    });

    expect(seen[0]).toContain("[from a document]");
    expect(seen[0]).toContain("[from conversation]");
  });

  it("retires the losing side of a contradiction instead of keeping both", () => {
    const state = contradictedState();

    applyFacetConsolidation(
      state,
      "identity",
      state.profile!.identity!,
      // The model kept the document-sourced item and dropped the chat one.
      [{ text: "工作经历: 字节跳动 后端工程师 2019-2022", mergedFrom: [0] }],
      () => "new-1",
      () => "2026-08-05T00:00:00.000Z"
    );

    const active = getActiveFactRegistry(state);
    expect(active).toHaveLength(1);
    expect(active[0].content).toBe("工作经历: 字节跳动 后端工程师 2019-2022");

    const loser = state.factRegistry!.find((e) => e.id === "f-chat")!;
    expect(loser.retiredReason).toBe("consolidation_dropped");
    // The rejected belief is still on the record — that is the whole point.
    expect(loser.content).toBe("工作经历: 某小公司 初级工程师 2019-2022");
  });

  it("carries an explicit contradiction rule in the shipped prompt", () => {
    expect(consolidateFacetSystemPrompt).toContain("CONTRADICTIONS");
    expect(consolidateFacetSystemPrompt).toContain("[from a document]");
  });
});
