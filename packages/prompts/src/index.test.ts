import { describe, expect, it } from "vitest";
import { consolidateFacetSystemPrompt, consolidateFacetUserPrompt } from "./index";

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
