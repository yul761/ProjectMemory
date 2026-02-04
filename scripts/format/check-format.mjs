#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";

const root = process.cwd();
const exts = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".md", ".yml", ".yaml"]);
const skipDirs = new Set(["node_modules", ".git", "dist", "coverage", "benchmark-results"]);

function walk(dir, acc) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = path.relative(root, full);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (skipDirs.has(name)) continue;
      walk(full, acc);
      continue;
    }
    if (!exts.has(path.extname(name))) continue;
    acc.push(rel);
  }
}

const files = [];
walk(root, files);

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
