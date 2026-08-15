#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "fs";
import path from "path";

const root = process.cwd();
const exts = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".md", ".yml", ".yaml"]);

// See check-format.mjs for why this enumerates via `git ls-files` instead of
// walking the filesystem: the two scripts must agree on which files are in
// scope, or `format` can rewrite files `format:check` never looked at (or
// vice versa) — most concretely, gitignored generated output like
// packages/db/generated/, which this script must never rewrite in place.
// See check-format.mjs for why `benchmark-results` is excluded by name even
// though every other legacy skip dir is dropped: it was added to .gitignore
// after historical run output was already committed, so those files are
// `--cached` and not screened by `--exclude-standard` (which only applies to
// `--others`, i.e. untracked, entries).
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

let changed = 0;
for (const rel of files) {
  const full = path.join(root, rel);
  const raw = readFileSync(full, "utf8");
  const normalized = raw
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n");
  const finalText = normalized.endsWith("\n") ? normalized : `${normalized}\n`;

  if (finalText !== raw) {
    writeFileSync(full, finalText, "utf8");
    changed += 1;
  }
}

console.log(`Format complete. Updated ${changed} files.`);
