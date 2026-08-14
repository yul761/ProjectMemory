import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { PublicV1Contracts } from "@statecore/contracts";

// Pins the structured claims the current-state docs make to the code that makes
// them true. Every check here exists because its claim drifted at least once and
// was caught by a human reading, not by a test: the frozen-surface counts went
// stale across three docs, digest-state.md described 5 of DigestState's 11
// fields, the README recommended a model the runtime turn rejects, and
// CONTRIBUTING.md told contributors to run apps deleted two releases earlier.
//
// Prose can still rot. What this file removes is the class of rot where a doc
// states a number, an identifier, or a path that the code contradicts.
const ROOT = join(__dirname, "../../..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const operations = Object.keys(PublicV1Contracts);
const operationCount = operations.length;
const pathCount = new Set(operations.map((k) => k.slice(k.indexOf(" ") + 1))).size;

describe("docs state the surface the registry defines", () => {
  // Every doc that quotes the frozen-surface size must quote the real one, and
  // must keep quoting it — deleting the sentence would also fail the check.
  it.each(["README.md", "STABILITY.md", "CLAUDE.md", "docs/api.md"])(
    "%s states the current operation and path counts",
    (rel) => {
      // Markdown wraps lines — and inside a blockquote each wrapped line gains a
      // "> " prefix — so strip quote markers, then collapse whitespace.
      const text = read(rel).replace(/^>\s?/gm, "").replace(/\s+/g, " ");
      const claims = [...text.matchAll(/(\d+) operations across (\d+) paths/g)];
      expect(claims.length, `${rel} no longer states the surface size at all`).toBeGreaterThan(0);
      for (const claim of claims) {
        expect(Number(claim[1]), `${rel} says "${claim[0]}"`).toBe(operationCount);
        expect(Number(claim[2]), `${rel} says "${claim[0]}"`).toBe(pathCount);
      }
    }
  );

  it("README and STABILITY cite the current contract info.version", () => {
    const version = read("apps/api/src/openapi.ts").match(/version: "(\d+\.\d+\.\d+)"/)?.[1];
    expect(version).toBeDefined();
    for (const rel of ["README.md", "STABILITY.md"]) {
      expect(read(rel), `${rel} cites contract version ${version}`).toContain(`\`${version}\``);
    }
  });

  it("every /v1 row in the README endpoint table is a frozen operation", () => {
    // The table is a curated subset, so this is one-directional: rows must be
    // real, but not every operation needs a row.
    const rows = [...read("README.md").matchAll(/^\| `(GET|POST|PUT|PATCH|DELETE)` \| `\/v1([^`]+)` \|/gm)].map(
      (m) => `${m[1]} ${m[2]}`
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((op) => !(op in PublicV1Contracts))).toEqual([]);
  });
});

describe("docs describe the data model the code declares", () => {
  it("digest-state.md names every top-level DigestState field", () => {
    const source = read("packages/core/src/digest-control.ts");
    const start = source.indexOf("export interface DigestState {");
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf("\n}", start));
    const fields = [...body.matchAll(/^  ([A-Za-z][A-Za-z0-9]*)\??:/gm)].map((m) => m[1]);
    // If this trips, the interface parse broke — fix the regex, not the doc.
    expect(fields.length).toBeGreaterThanOrEqual(10);

    const doc = read("docs/digest-state.md");
    expect(fields.filter((field) => !doc.includes(`\`${field}`))).toEqual([]);
  });

  it("glossary.md names every DropReason literal", () => {
    const source = read("packages/core/src/drop-log.ts");
    const start = source.indexOf("export type DropReason");
    const union = source.slice(start, source.indexOf(";", start));
    const reasons = [...union.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    expect(reasons.length).toBeGreaterThanOrEqual(8);

    const glossary = read("docs/glossary.md");
    expect(reasons.filter((reason) => !glossary.includes(`\`${reason}\``))).toEqual([]);
  });
});

describe("doc indexes and references resolve", () => {
  const docFiles = readdirSync(join(ROOT, "docs")).filter((f) => f.endsWith(".md"));

  it("repo-map.md lists every top-level doc", () => {
    const repoMap = read("docs/repo-map.md");
    expect(docFiles.filter((f) => !repoMap.includes(`docs/${f}`))).toEqual([]);
  });

  it("every repo path cited in a current-state doc exists", () => {
    // CHANGELOGs and the dated records under docs/audit and docs/superpowers are
    // history: they may legitimately cite files that no longer exist.
    const scanned = ["README.md", "CLAUDE.md", "CONTRIBUTING.md", "STABILITY.md", "deploy.md", ...docFiles.map((f) => `docs/${f}`)];
    const broken: string[] = [];
    for (const rel of scanned) {
      for (const m of read(rel).matchAll(/`((?:apps|packages|scripts|docs|examples|benchmark-fixtures)\/[A-Za-z0-9_./-]+)`/g)) {
        const cited = m[1];
        if (cited.includes("*")) continue; // glob patterns describe families, not files
        const target = cited.split(":")[0]; // strip `path:line` anchors
        if (!existsSync(join(ROOT, target))) broken.push(`${rel} -> ${cited}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it("docs/audit and docs/superpowers stay labeled as historical in repo-map.md", () => {
    // The dated records cite deleted symbols on purpose. The label is what stops
    // a reader from taking them as current state, so its absence is a failure.
    const repoMap = read("docs/repo-map.md");
    for (const dir of ["docs/audit/", "docs/superpowers/"]) {
      expect(statSync(join(ROOT, dir)).isDirectory()).toBe(true);
      const line = repoMap.split("\n").find((l) => l.includes(dir));
      expect(line, `repo-map.md lists ${dir}`).toBeDefined();
      expect(line!.toLowerCase()).toContain("historical");
    }
  });
});
