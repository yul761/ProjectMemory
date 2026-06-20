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
    const sys = buildRuntimeSystemPrompt(persona, BASE);
    expect(sys).not.toBe(BASE);          // persona was injected
    expect(sys.endsWith(BASE)).toBe(true);
  });

  it("project template yields no persona → base unchanged", () => {
    const persona = resolvePersona("project");
    expect(persona).toBeNull();
    expect(buildRuntimeSystemPrompt(persona, BASE)).toBe(BASE);
  });
});
