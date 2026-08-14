import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEmbeddedBackend } from "../src/embedded";

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
});
