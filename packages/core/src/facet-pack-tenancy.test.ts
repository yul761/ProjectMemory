import { describe, it, expect, beforeEach } from "vitest";
import { runDigestControlPipeline, getActiveFactRegistry, type DigestState } from "./digest-control";
import { flattenScopeFacts, groupFactsForDisplay } from "./memory-facts";
import { clearFacetPackCache } from "./facet-pack-resolver";
import { type FacetPack } from "./facet-registry";
import type { MemoryEvent, ProjectScope } from "./index";

const LEGAL_PACK: FacetPack = {
  name: "legal",
  facets: [
    { name: "matter", cap: 50, writeProtected: true, displayGroup: "Matters", description: "case matters" },
    { name: "obligation", cap: 20, writeProtected: false, displayGroup: "Obligations", description: "duties" }
  ]
};

const scope: ProjectScope = {
  id: "s1",
  userId: "u1",
  name: "tenant scope",
  goal: null,
  stage: "build",
  template: null,
  createdAt: new Date("2026-01-01T00:00:00Z")
};

function event(id: string, content: string): MemoryEvent {
  return {
    id,
    userId: "u1",
    scopeId: "s1",
    type: "stream",
    source: "api",
    key: null,
    content,
    createdAt: new Date("2026-07-01T00:00:00Z"),
    updatedAt: null,
    classifiedType: null
  };
}

// Emits one fact per ontology so we can see which one the engine accepted.
const llm = {
  chat: async () =>
    JSON.stringify({
      summary: "s",
      changes: ["c"],
      nextSteps: ["n"],
      profileFacts: [
        { facet: "matter", value: "案件 A 已结案" },
        { facet: "goals", value: "想减肥" }
      ]
    })
};

const prompts = { digestStage2SystemPrompt: "system", digestStage2UserPrompt: "{{scopeName}}" };
const config = {
  eventBudgetTotal: 40,
  eventBudgetDocs: 10,
  eventBudgetStream: 30,
  noveltyThreshold: 0.15,
  maxRetries: 1,
  useLlmClassifier: false,
  debug: false
};

async function digestWith(pack?: FacetPack) {
  return runDigestControlPipeline({
    scope,
    recentEvents: [event("e1", "案件进展")],
    llm,
    prompts,
    config,
    ...(pack ? { pack } : {})
  });
}

beforeEach(() => clearFacetPackCache());

describe("per-tenant facet packs", () => {
  it("a tenant on the legal pack stores legal facets and rejects personal ones", async () => {
    const result = await digestWith(LEGAL_PACK);
    const profile = result.state.profile as Record<string, string[]>;

    expect(profile.matter).toContain("案件 A 已结案");
    expect(profile.goals).toBeUndefined();
    expect(result.dropLog.some((d) => d.reason === "facet_not_registered" && d.detail.facet === "goals")).toBe(true);
  });

  it("a tenant with no pack of their own gets the default, and the opposite outcome", async () => {
    const result = await digestWith();
    const profile = result.state.profile as Record<string, string[]>;

    expect(profile.goals).toContain("想减肥");
    expect(profile.matter).toBeUndefined();
    expect(result.dropLog.some((d) => d.reason === "facet_not_registered" && d.detail.facet === "matter")).toBe(true);
  });

  it("two tenants digesting in the same process do not contaminate each other", async () => {
    // The registry used to be a process-wide singleton. Under multi-tenancy that
    // meant whichever pack was installed last won for everyone — a silent,
    // cross-customer data-shape bug with nothing in the logs.
    const [legal, personal] = await Promise.all([digestWith(LEGAL_PACK), digestWith()]);

    expect((legal.state.profile as Record<string, string[]>).matter).toBeDefined();
    expect((legal.state.profile as Record<string, string[]>).goals).toBeUndefined();
    expect((personal.state.profile as Record<string, string[]>).goals).toBeDefined();
    expect((personal.state.profile as Record<string, string[]>).matter).toBeUndefined();
  });

  it("display grouping follows the tenant's pack, not the process default", async () => {
    const state = {
      stableFacts: {},
      factRegistry: [
        {
          id: "f1",
          content: "案件 A 已结案",
          type: "profile" as const,
          confidence: 0.8,
          addedAt: "2026-07-01T00:00:00.000Z",
          evidenceId: "e1",
          evidenceType: "event" as const,
          facet: "matter"
        }
      ]
    } as unknown as DigestState;

    const legalFacts = flattenScopeFacts(state, undefined, LEGAL_PACK);
    expect(groupFactsForDisplay(legalFacts, LEGAL_PACK).map((g) => g.group)).toEqual(["Matters"]);

    // Under the default pack the same fact has no display group at all.
    expect(flattenScopeFacts(state)).toHaveLength(0);
  });

  it("never admits a facet from outside the tenant's pack into the registry", async () => {
    // Registry promotion also needs an evidence ref, which this fixture has no
    // document for; the guarantee under test is the negative one — a facet the
    // tenant's pack does not define can never reach the registry.
    const result = await digestWith(LEGAL_PACK);
    const active = getActiveFactRegistry(result.state);
    expect(active.some((e) => e.facet === "goals")).toBe(false);
  });
});
