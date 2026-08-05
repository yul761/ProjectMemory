import { describe, it, expect, beforeEach } from "vitest";
import { getDomainConfig, KNOWN_TEMPLATES } from "./domain-configs/index";
import { resolveFacetPackForScope, clearFacetPackCache } from "./facet-pack-resolver";
import { listFacets, packClassificationTypes, PERSONAL_PROFILE_PACK, type FacetPack } from "./facet-registry";

const noAccountPack = { findFacetPack: async () => null };

beforeEach(() => clearFacetPackCache());

describe("every domain routes its own classifier vocabulary", () => {
  it.each(KNOWN_TEMPLATES)("%s: every routed type is one the domain actually emits", (template) => {
    // The bug this covers: three of the four templates classified events into
    // types no facet routed from, so stage 1 produced labels that landed nowhere.
    const config = getDomainConfig(template);
    const pack = config.facetPack;
    expect(pack, `${template} has no facet pack`).toBeDefined();

    const emitted = new Set(config.entityTypes.map((t) => t.name));
    const routed = packClassificationTypes(pack as FacetPack).map((t) => t.name);

    expect(routed.length).toBeGreaterThan(0);
    for (const type of routed) {
      expect(emitted.has(type), `${template} routes from "${type}" but never emits it`).toBe(true);
    }
  });

  it.each(KNOWN_TEMPLATES)("%s: the domain's durable types have somewhere to land", (template) => {
    const config = getDomainConfig(template);
    const routed = new Set(packClassificationTypes(config.facetPack as FacetPack).map((t) => t.name));

    // Types with a dedicated pipeline of their own do not need a facet:
    // emotional_pattern is written and read by the pattern-detection job.
    const handledElsewhere = new Set(["noise", "emotional_pattern"]);

    const unrouted = config.entityTypes
      .filter((t) => !handledElsewhere.has(t.name) && t.retention !== "short" && t.retention !== "discard")
      .filter((t) => !routed.has(t.name))
      .map((t) => t.name);

    expect(unrouted, `${template} leaves durable types unrouted`).toEqual([]);
  });
});

describe("resolveFacetPackForScope", () => {
  it("gives a scope the ontology of its template", async () => {
    const pack = await resolveFacetPackForScope(noAccountPack, "u1", "health");
    expect(pack.name).toBe("health");
    expect(listFacets(pack)).toContain("medicalFacts");
  });

  it("falls back to the project domain for an unknown or absent template", async () => {
    expect((await resolveFacetPackForScope(noAccountPack, "u1", null)).name).toBe("project");
    expect((await resolveFacetPackForScope(noAccountPack, "u2", "nonsense")).name).toBe("project");
  });

  it("lets an account-level pack override the template", async () => {
    const legal: FacetPack = {
      name: "legal",
      facets: [{ name: "matter", cap: 50, writeProtected: true, displayGroup: "Matters", description: "" }]
    };
    const pack = await resolveFacetPackForScope({ findFacetPack: async () => legal }, "u3", "health");
    expect(pack.name).toBe("legal");
  });

  it("keeps personal scopes on the historical ontology", async () => {
    const pack = await resolveFacetPackForScope(noAccountPack, "u4", "personal");
    expect(pack.name).toBe(PERSONAL_PROFILE_PACK.name);
    expect(listFacets(pack)).toContain("identity");
  });

  it("gives two scopes of one account different ontologies", async () => {
    const health = await resolveFacetPackForScope(noAccountPack, "u5", "health");
    const learning = await resolveFacetPackForScope(noAccountPack, "u5", "learning");
    expect(health.name).toBe("health");
    expect(learning.name).toBe("learning");
  });
});
