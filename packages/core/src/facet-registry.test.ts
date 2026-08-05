import { describe, it, expect, afterEach } from "vitest";
import {
  PERSONAL_PROFILE_PACK,
  setFacetPack,
  isRegisteredFacet,
  getFacetCap,
  getFacetDisplayGroup,
  getFacetDescription,
  isWriteProtectedFacet,
  listFacets,
  overrideFacetCaps,
  buildFacetPromptSection,
  type FacetPack
} from "./facet-registry";
import { applyProfileFactsFromDigest, type DigestState } from "./digest-control";
import { factToGroup } from "./memory-facts";

const LEGAL_PACK: FacetPack = {
  name: "legal",
  facets: [
    { name: "matter", cap: 100, writeProtected: true, displayGroup: "Matters", description: "case matters" },
    { name: "obligation", cap: 50, writeProtected: false, displayGroup: "Obligations", description: "compliance duties" }
  ]
};

afterEach(() => setFacetPack(PERSONAL_PROFILE_PACK));

describe("facet registry", () => {
  it("defaults to the personal profile pack with the historical 7 facets", () => {
    expect(listFacets().slice().sort()).toEqual([
      "followUps",
      "goals",
      "identity",
      "notes",
      "ongoing",
      "relationships",
      "style"
    ]);
  });

  it("preserves the historical caps exactly", () => {
    expect(getFacetCap("identity")).toBe(15);
    expect(getFacetCap("relationships")).toBe(10);
    expect(getFacetCap("ongoing")).toBe(8);
    expect(getFacetCap("goals")).toBe(8);
    expect(getFacetCap("followUps")).toBe(10);
    expect(getFacetCap("style")).toBe(6);
    expect(getFacetCap("notes")).toBe(30);
  });

  it("preserves the historical write-protection flags", () => {
    expect(isWriteProtectedFacet("identity")).toBe(true);
    expect(isWriteProtectedFacet("goals")).toBe(true);
    expect(isWriteProtectedFacet("style")).toBe(false);
    expect(isWriteProtectedFacet("notes")).toBe(false);
  });

  it("keeps identity out of the display path, as before", () => {
    expect(getFacetDisplayGroup("identity")).toBeNull();
    expect(getFacetDisplayGroup("followUps")).toBe("Schedule");
    expect(getFacetDisplayGroup("relationships")).toBe("People");
    expect(getFacetDisplayGroup("goals")).toBe("Projects");
    expect(getFacetDisplayGroup("ongoing")).toBe("Projects");
  });

  it("reports unknown facets as unregistered under the default pack", () => {
    expect(isRegisteredFacet("legal_matter")).toBe(false);
    expect(getFacetCap("legal_matter")).toBe(8);
  });

  it("does not let cap overrides leak into the exported pack constant", () => {
    overrideFacetCaps({ identity: 99 });
    expect(getFacetCap("identity")).toBe(99);
    setFacetPack(PERSONAL_PROFILE_PACK);
    expect(getFacetCap("identity")).toBe(15);
  });

  it("applies per-facet cap overrides without replacing the pack", () => {
    overrideFacetCaps({ identity: 60 });
    expect(getFacetCap("identity")).toBe(60);
    expect(getFacetCap("notes")).toBe(30);
  });

  it("ignores overrides for facets the active pack does not define", () => {
    overrideFacetCaps({ nonexistent: 42 });
    expect(getFacetCap("nonexistent")).toBe(8);
  });

  it("generates the prompt facet list from the active pack", () => {
    setFacetPack(LEGAL_PACK);
    const section = buildFacetPromptSection();
    expect(section).toContain('- "matter": case matters');
    expect(section).toContain('- "obligation": compliance duties');
    expect(section).not.toContain("identity");
  });

  it("accepts a replacement pack so the core carries no domain ontology", () => {
    setFacetPack(LEGAL_PACK);
    expect(isRegisteredFacet("matter")).toBe(true);
    expect(isRegisteredFacet("identity")).toBe(false);
    expect(getFacetDisplayGroup("matter")).toBe("Matters");
    expect(getFacetCap("matter")).toBe(100);
    expect(getFacetDescription("obligation")).toBe("compliance duties");
    expect(listFacets()).toEqual(["matter", "obligation"]);
  });
});

describe("registry drives the digest pipeline", () => {
  const NOW = () => "2026-08-05T00:00:00.000Z";

  function emptyState(): DigestState {
    return { stableFacts: {}, factRegistry: [] } as unknown as DigestState;
  }

  it("stores facets from a replacement pack and rejects the old ones", () => {
    setFacetPack(LEGAL_PACK);
    const state = emptyState();
    applyProfileFactsFromDigest(
      state,
      [
        { facet: "matter", value: "案件 A 已结案" },
        { facet: "goals", value: "想减肥" }
      ],
      [],
      null,
      () => "id",
      NOW
    );
    const profile = state.profile as unknown as Record<string, string[]>;
    expect(profile.matter).toContain("案件 A 已结案");
    expect(profile.goals).toBeUndefined();
  });

  it("enforces the replacement pack's cap rather than the historical one", () => {
    setFacetPack({
      name: "tiny",
      facets: [{ name: "matter", cap: 2, writeProtected: false, displayGroup: "Matters", description: "" }]
    });
    const state = emptyState();
    let n = 0;
    applyProfileFactsFromDigest(
      state,
      [
        { facet: "matter", value: "第一宗合同纠纷" },
        { facet: "matter", value: "第二宗劳动仲裁" },
        { facet: "matter", value: "第三宗知识产权侵权" }
      ],
      [],
      null,
      () => `id-${n++}`,
      NOW
    );
    expect((state.profile as unknown as Record<string, string[]>).matter).toHaveLength(2);
  });

  it("routes display grouping through the active pack", () => {
    setFacetPack(LEGAL_PACK);
    expect(factToGroup("matter")).toBe("Matters");
    expect(factToGroup("relationships")).toBeNull();
  });
});
