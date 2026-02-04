#!/usr/bin/env node
import { readFileSync, readdirSync, statSync, writeFileSync } from "fs";
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
