import { describe, expect, it } from "vitest";
import { buildRuntimeSystemPrompt } from "./runtime-system-prompt";

const BASE = "You are the synchronous Fast Layer assistant.\nKeep replies concise.";

describe("buildRuntimeSystemPrompt", () => {
  it("prepends persona before base when persona is present", () => {
    const persona = "You are a warm, attentive personal AI companion.";
    const out = buildRuntimeSystemPrompt(persona, BASE);
    expect(out).toBe(`${persona}\n\n${BASE}`);
    expect(out.startsWith(persona)).toBe(true);      // persona first (voice)
    expect(out.endsWith(BASE)).toBe(true);            // base last (authoritative)
  });

  it("trims surrounding whitespace on persona", () => {
    const out = buildRuntimeSystemPrompt("  hello persona  ", BASE);
    expect(out).toBe(`hello persona\n\n${BASE}`);
  });

  it("returns base verbatim when persona is null", () => {
    expect(buildRuntimeSystemPrompt(null, BASE)).toBe(BASE);
  });

  it("returns base verbatim when persona is undefined", () => {
    expect(buildRuntimeSystemPrompt(undefined, BASE)).toBe(BASE);
  });

  it("returns base verbatim when persona is empty or whitespace-only", () => {
    expect(buildRuntimeSystemPrompt("", BASE)).toBe(BASE);
    expect(buildRuntimeSystemPrompt("   ", BASE)).toBe(BASE);
  });
});
