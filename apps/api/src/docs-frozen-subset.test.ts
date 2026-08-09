import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PublicV1Contracts } from "@statecore/contracts";

// docs/api.md carries a table of the frozen subset. It is the first thing a
// human reads to learn what /v1 promises, and until now nothing checked it: the
// `1.1.0` endpoints went into the registry and never into the table, so for
// three months the document listed 13 operations while the contract had 15. A
// reader had no way to notice.
//
// The registry is the source of truth. This test only insists the prose agrees
// with it.
describe("docs/api.md frozen-subset table", () => {
  const doc = readFileSync(join(__dirname, "../../../docs/api.md"), "utf8");

  function tableOperations(): string[] {
    const section = doc.split("### Frozen public subset")[1];
    expect(section, "the 'Frozen public subset' heading moved or was renamed").toBeDefined();
    const rows = section.split("\n### ")[0].split("\n");
    const ops: string[] = [];
    for (const row of rows) {
      // | POST | `/v1/memory/notes` |
      const m = row.match(/^\|\s*(GET|POST|PUT|PATCH|DELETE)\s*\|\s*`\/v1([^`]+)`\s*\|/);
      if (m) ops.push(`${m[1]} ${m[2]}`);
    }
    return ops;
  }

  it("lists exactly the operations in PublicV1Contracts", () => {
    expect(tableOperations().sort()).toEqual(Object.keys(PublicV1Contracts).sort());
  });

  it("states the operation and path counts the surface actually has", () => {
    const operations = Object.keys(PublicV1Contracts).length;
    const paths = new Set(Object.keys(PublicV1Contracts).map((k) => k.slice(k.indexOf(" ") + 1))).size;
    expect(doc).toContain(`**${operations} operations across ${paths} paths**`);
  });
});
