import { describe, expect, it } from "vitest";
import { buildRuntimeSystemPrompt } from "./runtime-system-prompt";

const BASE = "You are the synchronous Fast Layer assistant.\nKeep replies concise.";
const PERSONA = "You are a warm, attentive personal AI companion.";

describe("buildRuntimeSystemPrompt", () => {
  // ── P2a cases (updated to 3-param, styleLines=null) ──────────────────────
  it("prepends persona before base when persona is present and no styleLines", () => {
    const out = buildRuntimeSystemPrompt(PERSONA, null, BASE);
    expect(out).toBe(`${PERSONA}\n\n${BASE}`);
    expect(out.startsWith(PERSONA)).toBe(true);  // persona first (voice)
    expect(out.endsWith(BASE)).toBe(true);        // base last (authoritative)
  });

  it("trims surrounding whitespace on persona", () => {
    const out = buildRuntimeSystemPrompt("  hello persona  ", null, BASE);
    expect(out).toBe(`hello persona\n\n${BASE}`);
  });

  it("returns base verbatim when persona is null and no styleLines", () => {
    expect(buildRuntimeSystemPrompt(null, null, BASE)).toBe(BASE);
  });

  it("returns base verbatim when persona is undefined and no styleLines", () => {
    expect(buildRuntimeSystemPrompt(undefined, null, BASE)).toBe(BASE);
  });

  it("returns base verbatim when persona is empty or whitespace-only and no styleLines", () => {
    expect(buildRuntimeSystemPrompt("", null, BASE)).toBe(BASE);
    expect(buildRuntimeSystemPrompt("   ", null, BASE)).toBe(BASE);
  });

  // ── P2b cases: style section ──────────────────────────────────────────────
  it("renders style section between persona and base when both are present", () => {
    const styleLines = ["回复简短", "用中文"];
    const out = buildRuntimeSystemPrompt(PERSONA, styleLines, BASE);
    const expected = `${PERSONA}\n\n交流风格（用户要求）:\n- 回复简短\n- 用中文\n\n${BASE}`;
    expect(out).toBe(expected);
    expect(out.startsWith(PERSONA)).toBe(true);  // persona first
    expect(out.endsWith(BASE)).toBe(true);        // base always last
  });

  it("renders style section before base when persona is null", () => {
    const styleLines = ["别用emoji"];
    const out = buildRuntimeSystemPrompt(null, styleLines, BASE);
    const expected = `交流风格（用户要求）:\n- 别用emoji\n\n${BASE}`;
    expect(out).toBe(expected);
    expect(out.endsWith(BASE)).toBe(true);
  });

  it("returns base verbatim when styleLines is an empty array", () => {
    expect(buildRuntimeSystemPrompt(null, [], BASE)).toBe(BASE);
  });

  it("returns base verbatim when styleLines is undefined", () => {
    expect(buildRuntimeSystemPrompt(null, undefined, BASE)).toBe(BASE);
  });

  it("trims whitespace-only styleLines entries and skips them", () => {
    const out = buildRuntimeSystemPrompt(null, ["  ", "用中文"], BASE);
    const expected = `交流风格（用户要求）:\n- 用中文\n\n${BASE}`;
    expect(out).toBe(expected);
  });

  it("base is always the last segment regardless of inputs", () => {
    const out = buildRuntimeSystemPrompt(PERSONA, ["回短点"], BASE);
    expect(out.endsWith(BASE)).toBe(true);
  });
});
