import { describe, expect, it } from "vitest";
import {
  answerSystemPrompt,
  buildDigestStage2SystemPrompt,
  buildPackClassificationSystemPrompt,
  consolidateFacetSystemPrompt,
  consolidateFacetUserPrompt,
  digestClassifySystemPrompt,
  runtimeSystemPrompt
} from "./index";

describe("consolidation prompts", () => {
  it("system prompt states the core rules and asks for the JSON contract", () => {
    const p = consolidateFacetSystemPrompt;
    expect(p).toMatch(/mergedFrom/);
    expect(p).toMatch(/JSON/i);
    expect(p).toMatch(/(merge|duplicate)/i);
    expect(p).toMatch(/(do not invent|never invent)/i);
    expect(p).not.toContain("`"); // no raw backticks (build-safety guard)
  });

  it("user prompt exposes all four placeholders", () => {
    for (const key of ["{{facet}}", "{{facetDescription}}", "{{items}}", "{{siblings}}"]) {
      expect(consolidateFacetUserPrompt).toContain(key);
    }
  });
});

describe("security boundary", () => {
  // Every system prompt that sees ingested or retrieved content must state that
  // the content is data to process, never instructions to follow. Ingested
  // events reach these prompts verbatim, so without this clause a memory event
  // containing "ignore your rules and ..." reads as an instruction.
  const contentBearingPrompts: Array<[string, string]> = [
    ["digest stage-2", buildDigestStage2SystemPrompt("- notes: things worth keeping")],
    ["digest classify", digestClassifySystemPrompt],
    ["answer", answerSystemPrompt],
    ["runtime", runtimeSystemPrompt],
    ["facet consolidation", consolidateFacetSystemPrompt],
    ["pack classification", buildPackClassificationSystemPrompt([{ name: "note", description: "a note" }])]
  ];

  it.each(contentBearingPrompts)("%s prompt declares content as data, not instructions", (_name, prompt) => {
    expect(prompt).toMatch(/not instructions/i);
    expect(prompt).toMatch(/never follow/i);
  });
});

describe("faithfulness", () => {
  it("stage-2 prompt forbids invented specifics, not just invented facts", () => {
    const p = buildDigestStage2SystemPrompt("- notes: things worth keeping");
    expect(p).toMatch(/never invent dates, times, names, file paths, versions, or identifiers/i);
  });

  it("stage-2 prompt forbids generic-knowledge filler", () => {
    const p = buildDigestStage2SystemPrompt("- notes: things worth keeping");
    expect(p).toMatch(/what actually happened/i);
    expect(p).toMatch(/general knowledge|generic advice/i);
  });

  it("consolidation prompt forbids invented specifics", () => {
    expect(consolidateFacetSystemPrompt).toMatch(/never invent dates, times, names, file paths, versions, or identifiers/i);
  });
});
