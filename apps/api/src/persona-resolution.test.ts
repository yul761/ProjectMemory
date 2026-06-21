import { describe, expect, it } from "vitest";
import { getDomainConfig, buildRuntimeSystemPrompt } from "@statecore/core";

const BASE = "BASE RUNTIME INSTRUCTIONS";

function resolvePersona(template: string | null | undefined): string | null {
  return getDomainConfig(template).defaultPersonaPrompt ?? null;
}

describe("runtime persona resolution", () => {
  it("personal template yields a non-empty persona", () => {
    const persona = resolvePersona("personal");
    expect(persona && persona.length > 0).toBe(true);
    const sys = buildRuntimeSystemPrompt(persona, null, BASE);
    expect(sys).not.toBe(BASE);          // persona was injected
    expect(sys.endsWith(BASE)).toBe(true);
  });

  it("project template yields no persona → base unchanged", () => {
    const persona = resolvePersona("project");
    expect(persona).toBeNull();
    expect(buildRuntimeSystemPrompt(persona, null, BASE)).toBe(BASE);
  });
});

describe("buildRuntimeSystemPrompt — style section (P2b)", () => {
  const PERSONA_PERSONAL = getDomainConfig("personal").defaultPersonaPrompt ?? null;

  it("profile.style array renders into composed system prompt between persona and base", () => {
    const styleLines = ["回复简短", "用中文"];
    const out = buildRuntimeSystemPrompt(PERSONA_PERSONAL, styleLines, BASE);
    expect(out).toContain("交流风格（用户要求）:");
    expect(out).toContain("- 回复简短");
    expect(out).toContain("- 用中文");
    // Ordering: persona first, base last, style in between
    expect(out.startsWith(PERSONA_PERSONAL!)).toBe(true);
    expect(out.endsWith(BASE)).toBe(true);
    const styleIdx = out.indexOf("交流风格");
    const baseIdx = out.lastIndexOf(BASE);
    expect(styleIdx).toBeGreaterThan(0);
    expect(baseIdx).toBeGreaterThan(styleIdx);
  });

  it("empty profile.style → P2a behavior (persona + base, no style section)", () => {
    const out = buildRuntimeSystemPrompt(PERSONA_PERSONAL, [], BASE);
    expect(out).not.toContain("交流风格");
    expect(out).toBe(`${PERSONA_PERSONAL}\n\n${BASE}`);
  });

  it("null profile.style → P2a behavior identical to empty array", () => {
    const outNull = buildRuntimeSystemPrompt(PERSONA_PERSONAL, null, BASE);
    const outEmpty = buildRuntimeSystemPrompt(PERSONA_PERSONAL, [], BASE);
    expect(outNull).toBe(outEmpty);
  });
});
