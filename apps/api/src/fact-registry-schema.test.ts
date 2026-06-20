import { describe, it, expect } from "vitest";
import { FactRegistryEntrySchema, RetrieveOutput } from "@statecore/contracts";

const baseEntry = {
  id: "fact-1",
  content: "User identifies as a software engineer",
  confidence: 0.9,
  addedAt: new Date().toISOString(),
  evidenceId: "event-abc",
  evidenceType: "event" as const
};

describe("FactRegistryEntrySchema — profile type regression", () => {
  it("accepts type='profile' with facet='identity'", () => {
    expect(() =>
      FactRegistryEntrySchema.parse({ ...baseEntry, type: "profile", facet: "identity" })
    ).not.toThrow();
  });

  it("accepts type='profile' without facet (facet is optional)", () => {
    expect(() =>
      FactRegistryEntrySchema.parse({ ...baseEntry, type: "profile" })
    ).not.toThrow();
  });

  it("accepts type='decision' (existing type still works)", () => {
    expect(() =>
      FactRegistryEntrySchema.parse({ ...baseEntry, type: "decision" })
    ).not.toThrow();
  });

  it("accepts type='constraint' (existing type still works)", () => {
    expect(() =>
      FactRegistryEntrySchema.parse({ ...baseEntry, type: "constraint" })
    ).not.toThrow();
  });

  it("rejects unknown type", () => {
    expect(() =>
      FactRegistryEntrySchema.parse({ ...baseEntry, type: "unknown" })
    ).toThrow();
  });

  it("accepts supersededBy when present", () => {
    const result = FactRegistryEntrySchema.parse({
      ...baseEntry,
      type: "profile",
      facet: "identity",
      supersededBy: "fact-2"
    });
    expect(result.supersededBy).toBe("fact-2");
  });
});

describe("RetrieveOutput — factRegistry with profile entries does not throw", () => {
  it("parses a RetrieveOutput containing a profile fact-registry entry", () => {
    const output = {
      digest: null,
      events: [],
      factRegistry: [
        { ...baseEntry, type: "profile", facet: "identity" }
      ]
    };
    expect(() => RetrieveOutput.parse(output)).not.toThrow();
  });
});
