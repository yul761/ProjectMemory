import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEmbeddedBackend } from "../src/embedded";
import { openStore } from "../src/store";
import { clearFacetPackCache, type DigestState } from "@statecore/core";

describe("embedded backend, keyless", () => {
  const dir = mkdtempSync(join(tmpdir(), "sc-emb-"));
  const be = createEmbeddedBackend({ dataDir: dir, scopeName: "/tmp/fake-project", env: {} as any });
  beforeAll(() => be.init());
  afterAll(() => be.close());

  it("remember(note) → facts → why yields an evidence chain without any LLM", async () => {
    await be.remember({ text: "We use pnpm, not npm" });
    const groups: any = await be.facts();
    const all = groups.flatMap((g: any) => g.items);
    expect(all.some((f: any) => f.text.includes("pnpm"))).toBe(true);
    const factId = all.find((f: any) => f.text.includes("pnpm")).factId;
    const prov: any = await be.why({ factId });
    expect(prov.fact.content).toContain("pnpm");
    expect(prov.fact.evidenceId).toBeTruthy();
    expect(prov.chain.length).toBeGreaterThanOrEqual(1);
  });

  it("forget removes the fact from facts() but retires rather than deletes", async () => {
    await be.remember({ text: "Temporary secret preference" });
    const before: any = await be.facts();
    const target = before.flatMap((g: any) => g.items).find((f: any) => f.text.includes("Temporary"));
    await be.forget({ factKey: target.factKey });
    const after: any = await be.facts();
    expect(after.flatMap((g: any) => g.items).some((f: any) => f.factKey === target.factKey)).toBe(false);
  });

  it("recall respects a maxChars budget and reports it", async () => {
    const out: any = await be.recall({ query: "pnpm", maxChars: 500 });
    expect(out.budget?.maxChars).toBe(500);
  });

  it("remember(consolidate) stores a stream event and never throws keyless", async () => {
    const res = await be.remember({ text: "long conversational turn …", consolidate: true });
    expect(res.mode).toBe("event");
  });

  // Regression for a first-wins vs. last-wins factId join bug: two registry
  // entries in different facets that share a displayGroup and normalize to the
  // same content collide on the same factKey (computeFactKey hashes
  // displayGroup + normalized content, not facet). flattenScopeFacts resolves
  // that collision first-registered-entry-wins; attachFactIds (embedded.ts)
  // must resolve it the same way, or why(factId) returns provenance for the
  // wrong registry entry. Reaches the collision by installing a custom facet
  // pack with two same-group facets and writing a snapshot directly, since the
  // real "project" pack this backend otherwise uses has no two facets sharing a
  // displayGroup.
  it("facts()/why() resolve a same-displayGroup factKey collision to the first-registered entry", async () => {
    const direct = await openStore(dir);
    try {
      const scope = await direct.prisma.projectScope.findFirstOrThrow({ where: { userId: "local", name: "/tmp/fake-project" } });
      await direct.prisma.user.update({
        where: { id: "local" },
        data: {
          facetPack: {
            name: "collide-test",
            facets: [
              { name: "a", displayGroup: "Collide", cap: 8, writeProtected: false, description: "a" },
              { name: "b", displayGroup: "Collide", cap: 8, writeProtected: false, description: "b" }
            ]
          }
        }
      });
      clearFacetPackCache("local");

      const digest = await direct.prisma.digest.create({
        data: { scopeId: scope.id, summary: "collision-fixture", changes: "", nextSteps: [] }
      });
      const state: DigestState = {
        stableFacts: { decisions: [] },
        workingNotes: {},
        todos: [],
        factRegistry: [
          { id: "reg-a", content: "Same fact text", type: "profile", confidence: 0.9, addedAt: "2024-01-01T00:00:00.000Z", evidenceId: "ev-a", evidenceType: "event", facet: "a" },
          { id: "reg-b", content: "same fact text", type: "profile", confidence: 0.9, addedAt: "2024-01-02T00:00:00.000Z", evidenceId: "ev-b", evidenceType: "event", facet: "b" }
        ],
        profile: {}
      };
      await direct.prisma.digestStateSnapshot.create({
        data: { scopeId: scope.id, digestId: digest.id, state: state as any }
      });

      const groups: any = await be.facts();
      const collided = groups.flatMap((g: any) => g.items).filter((f: any) => f.text.toLowerCase() === "same fact text");
      expect(collided.length).toBe(1); // merged by flattenScopeFacts' factKey dedup
      expect(collided[0].factId).toBe("reg-a"); // first-registered entry wins, not last

      const prov: any = await be.why({ factId: collided[0].factId });
      expect(prov.fact.evidenceId).toBe("ev-a");
    } finally {
      await direct.close();
    }
  });
});
