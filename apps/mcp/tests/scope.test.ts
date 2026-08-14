import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { resolveScopeName } from "../src/scope";

describe("resolveScopeName", () => {
  it("prefers STATECORE_SCOPE", () => {
    expect(resolveScopeName("/anywhere", { STATECORE_SCOPE: "my-scope" } as any)).toBe("my-scope");
  });
  it("uses the git toplevel from a subdirectory", () => {
    const repo = mkdtempSync(join(tmpdir(), "sc-git-"));
    execFileSync("git", ["init", "-q"], { cwd: repo });
    const sub = join(repo, "a/b");
    execFileSync("mkdir", ["-p", sub]);
    expect(resolveScopeName(sub, {} as any)).toBe(resolve(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: repo }).toString().trim()));
  });
  it("falls back to cwd outside git", () => {
    const dir = mkdtempSync(join(tmpdir(), "sc-plain-"));
    expect(resolveScopeName(dir, {} as any)).toBe(resolve(dir));
  });
});
