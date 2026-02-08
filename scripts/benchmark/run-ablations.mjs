#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outDir = path.join(root, "benchmark-results");
mkdirSync(outDir, { recursive: true });

const baseEnv = {
  BENCH_SEED: process.env.BENCH_SEED || "42",
  BENCH_FIXTURE: process.env.BENCH_FIXTURE || "benchmark-fixtures/basic.json",
  BENCH_PROFILE: process.env.BENCH_PROFILE || "balanced"
};

const matrix = [
  { name: "baseline", env: {} },
  { name: "no_classifier", env: { DIGEST_USE_LLM_CLASSIFIER: "false" } },
  { name: "high_novelty", env: { DIGEST_NOVELTY_THRESHOLD: "0.3" } },
  { name: "low_novelty", env: { DIGEST_NOVELTY_THRESHOLD: "0.05" } },
  { name: "small_budget", env: { DIGEST_EVENT_BUDGET_TOTAL: "20", DIGEST_EVENT_BUDGET_STREAM: "15", DIGEST_EVENT_BUDGET_DOCS: "5" } },
  { name: "large_budget", env: { DIGEST_EVENT_BUDGET_TOTAL: "60", DIGEST_EVENT_BUDGET_STREAM: "45", DIGEST_EVENT_BUDGET_DOCS: "15" } }
];

function runCase(entry) {
  const env = { ...process.env, ...baseEnv, ...entry.env };
  const result = spawnSync("node", ["scripts/benchmark/run-benchmark.mjs"], {
    cwd: root,
    env,
    stdio: "inherit"
  });
  if (result.status !== 0) {
    throw new Error(`ablation_failed:${entry.name}`);
  }
}

function latestBenchmarkJson() {
  const files = readdirSync(outDir)
    .filter((name) => name.startsWith("benchmark-") && name.endsWith(".json"))
    .map((name) => ({ name, mtime: statSync(path.join(outDir, name)).mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime);
  const latest = files[files.length - 1];
  if (!latest) throw new Error("missing_benchmark_json");
  return path.join(outDir, latest.name);
}

function collectSummary(jsonPath) {
  const raw = readFileSync(jsonPath, "utf8");
  const data = JSON.parse(raw);
  return {
    name: data.config?.ablationName || "unknown",
    overall: data.scores?.overall ?? 0,
    ingest: data.scores?.ingest ?? 0,
    retrieve: data.scores?.retrieve ?? 0,
    digest: data.scores?.digest ?? 0,
    reminder: data.scores?.reminder ?? 0,
    file: path.basename(jsonPath)
  };
}

const summaries = [];
for (const entry of matrix) {
  process.env.ABLATION_NAME = entry.name;
  const env = { ...process.env, ...baseEnv, ...entry.env, ABLATION_NAME: entry.name };
  const result = spawnSync("node", ["scripts/benchmark/run-benchmark.mjs"], {
    cwd: root,
    env,
    stdio: "inherit"
  });
  if (result.status !== 0) {
    throw new Error(`ablation_failed:${entry.name}`);
  }
  const jsonPath = latestBenchmarkJson();
  const summary = collectSummary(jsonPath);
  summary.name = entry.name;
  summaries.push(summary);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outPath = path.join(outDir, `ablation-${stamp}.md`);
const lines = [
  "# Ablation Summary",
  "",
  `Seed: ${baseEnv.BENCH_SEED}`,
  `Fixture: ${baseEnv.BENCH_FIXTURE}`,
  `Profile: ${baseEnv.BENCH_PROFILE}`,
  "",
  "## Scores",
  "",
  ...summaries.map(
    (s) =>
      `- ${s.name}: overall ${s.overall} (ingest ${s.ingest}, retrieve ${s.retrieve}, digest ${s.digest}, reminder ${s.reminder}) → ${s.file}`
  )
];
writeFileSync(outPath, lines.join("\n"));
// eslint-disable-next-line no-console
console.log(`Ablation summary: ${outPath}`);
