// This suite is the release gate for the *built* binary: every other test in this
// package exercises `src/*.ts` directly (via vitest/tsx) or an in-process
// `InMemoryTransport`, none of which proves `tsup`'s CJS bundle actually runs under
// plain `node` — the one thing an npm-installed `statecore-mcp` binary has to do.
// It spawns `dist/main.js` as a real child process over stdio, exactly as a host
// (dsh, Claude Code, Cursor) would, and walks the full evidence-chain lifecycle
// keylessly (no model API key in the child's env) to prove the keyless embedded
// path is real end to end, not just type-checked.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";

const mcpRoot = resolve(__dirname, "..");
const repoRoot = resolve(mcpRoot, "../..");
const distEntry = join(mcpRoot, "dist", "main.js");

/** Newest mtime (ms) across the TS sources this bundle is built from — this
 * package's own `src/`, plus the three workspace packages tsup inlines
 * (`@statecore/core`, `@statecore/prompts`, `@statecore/db`, via `noExternal` in
 * `tsup.config.ts`), whose *built* `dist/` output the bundle also depends on
 * (see `prebundle` in `package.json`), plus this package's own `tsup.config.ts`
 * (bundler entry/external/noExternal settings) and `package.json` (the `build`
 * script itself, and dependency/devDependency edits that change what tsup
 * inlines vs. externalizes). Walking only `.ts`/`.prisma` files under the
 * source roots keeps this cheap and avoids false staleness from each
 * package's own `dist/`. */
function newestSourceMtime(): number {
  const roots = [
    join(mcpRoot, "src"),
    join(repoRoot, "packages/core/src"),
    join(repoRoot, "packages/prompts/src"),
    join(repoRoot, "packages/db/src"),
    join(repoRoot, "packages/db/prisma")
  ];
  const files = [join(mcpRoot, "tsup.config.ts"), join(mcpRoot, "package.json")];
  let newest = 0;
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else {
        const mtime = statSync(path).mtimeMs;
        if (mtime > newest) newest = mtime;
      }
    }
  };
  for (const root of roots) walk(root);
  for (const file of files) {
    if (!existsSync(file)) continue;
    const mtime = statSync(file).mtimeMs;
    if (mtime > newest) newest = mtime;
  }
  return newest;
}

describe("built binary, keyless end-to-end over stdio", () => {
  let dataDir: string;
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    // Build-if-missing-or-stale, not build-always: this is a release-gating test
    // that must actually catch a broken bundle, but re-running `tsup` (plus its
    // `prebundle` rebuild of three workspace packages) on every test invocation
    // would make this suite the slowest thing in the package for no benefit once
    // `dist/` already reflects the current sources. Comparing `dist/main.js`'s
    // mtime against the newest source file catches both a missing build and an
    // edit made since the last one; a full always-rebuild is left to CI's
    // dedicated build step.
    if (!existsSync(distEntry) || statSync(distEntry).mtimeMs < newestSourceMtime()) {
      execSync("pnpm --filter statecore-mcp bundle", { cwd: repoRoot, stdio: "inherit" });
    }

    dataDir = mkdtempSync(join(tmpdir(), "sc-mcp-e2e-"));
    client = new Client({ name: "e2e-test-client", version: "0.0.0-test" });
    transport = new StdioClientTransport({
      // Exec the built file DIRECTLY, exactly as npm's .bin shim does. 0.1.0
      // shipped without a shebang and every test ran `node dist/main.js`, so the
      // one path real npx users take was the one path nothing exercised — the
      // shell parsed JavaScript and printed "use strict: command not found".
      command: distEntry,
      args: ["--data", dataDir],
      // getDefaultEnvironment() carries PATH/HOME/etc. so `node` and its own
      // subprocess lookups (e.g. `git`, which scope.ts falls back to) still
      // work; STATECORE_SCOPE overrides that git lookup outright and no
      // DEEPSEEK_API_KEY/model credential is present, so this is a real keyless
      // run of the embedded backend, not merely a key-blanked one.
      env: { ...getDefaultEnvironment(), STATECORE_SCOPE: "e2e-scope" }
    });
    await client.connect(transport);
  }, 180_000);

  afterAll(async () => {
    await client?.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it("ships an executable entry: shebang first line", async () => {
    const { readFileSync } = await import("node:fs");
    const firstLine = readFileSync(distEntry, "utf8").split("\n", 1)[0];
    expect(firstLine).toBe("#!/usr/bin/env node");
  });

  it("lists exactly the five memory tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["facts", "forget", "recall", "remember", "why"]);
  });

  it("initialize ships the system-prompt instructions (hosts inject them per session)", () => {
    const instructions = client.getInstructions();
    expect(instructions).toBeTruthy();
    expect(instructions).toMatch(/recall/);
    expect(instructions).toMatch(/remember/);
  });

  it("walks remember → facts → why → forget → facts as a real evidence-chain lifecycle", async () => {
    const rememberResult = await client.callTool({ name: "remember", arguments: { text: "The e2e binary works" } });
    const remembered = JSON.parse((rememberResult.content as Array<{ type: string; text: string }>)[0].text);
    expect(remembered).toEqual({ ok: true, mode: "note" });

    const factsAfterRemember = await client.callTool({ name: "facts", arguments: {} });
    const groupsAfterRemember = JSON.parse((factsAfterRemember.content as Array<{ type: string; text: string }>)[0].text) as Array<{
      items: Array<{ factId: string; factKey: string; text: string }>;
    }>;
    const found = groupsAfterRemember.flatMap((g) => g.items).find((f) => f.text.includes("e2e binary works"));
    expect(found).toBeTruthy();
    const { factId, factKey } = found!;

    const whyResult = await client.callTool({ name: "why", arguments: { factId } });
    const provenance = JSON.parse((whyResult.content as Array<{ type: string; text: string }>)[0].text) as {
      fact: { evidenceId: string; content: string };
      chain: unknown[];
    };
    expect(provenance.fact.evidenceId).toBeTruthy();
    expect(provenance.chain.length).toBeGreaterThanOrEqual(1);

    const forgetResult = await client.callTool({ name: "forget", arguments: { factKey } });
    const forgotten = JSON.parse((forgetResult.content as Array<{ type: string; text: string }>)[0].text);
    expect(forgotten).toEqual({ ok: true });

    const factsAfterForget = await client.callTool({ name: "facts", arguments: {} });
    const groupsAfterForget = JSON.parse((factsAfterForget.content as Array<{ type: string; text: string }>)[0].text) as Array<{
      items: Array<{ factId: string; factKey: string; text: string }>;
    }>;
    const stillPresent = groupsAfterForget.flatMap((g) => g.items).find((f) => f.factKey === factKey);
    expect(stillPresent).toBeFalsy();
  });
});
