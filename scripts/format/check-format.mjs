#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "fs";
import path from "path";

const root = process.cwd();
const exts = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".md", ".yml", ".yaml"]);

// Enumerating through `git ls-files` rather than walking the filesystem keeps
// this gate's coverage identical to the repo's own definition of "tracked or
// about-to-be-tracked" content: `--cached` covers committed files, `--others
// --exclude-standard` covers new-but-unstaged files while still honoring
// .gitignore, so generated/vendored output (e.g. packages/db/generated/) is
// excluded exactly when git itself excludes it, with no hand-kept skip list.
// benchmark-results/ was added to .gitignore after historical run output was
// already committed; `--exclude-standard` only screens `--others` (untracked)
// entries, so those already-`--cached` files still surface here. Excluding
// the directory by name is the one remaining hand-kept exception — every
// other legacy skip (node_modules, dist, coverage, .git) is never tracked, so
// git's own enumeration already excludes it.
const trackedButIgnored = new Set(["benchmark-results"]);

const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024
})
  .split("\0")
  .filter(Boolean)
  .filter((rel) => !trackedButIgnored.has(rel.split("/")[0]))
  .filter((rel) => exts.has(path.extname(rel)));

const violations = [];
for (const rel of files) {
  const raw = readFileSync(path.join(root, rel), "utf8");
  const lines = raw.split("\n");

  for (let i = 0; i < lines.length; i += 1) {
    if (/[ \t]+$/.test(lines[i])) {
      violations.push(`${rel}:${i + 1} trailing whitespace`);
      break;
    }
  }

  if (raw.includes("\r\n")) {
    violations.push(`${rel}: contains CRLF line endings`);
  }

  if (!raw.endsWith("\n")) {
    violations.push(`${rel}: missing newline at end of file`);
  }
}

if (violations.length) {
  console.error("Formatting check failed:");
  for (const v of violations) {
    console.error(`- ${v}`);
  }
  process.exit(1);
}

console.log(`Formatting check passed (${files.length} files).`);
