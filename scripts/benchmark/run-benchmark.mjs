#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { performance } from "perf_hooks";
import { fileURLToPath } from "url";
import os from "os";
import { execSync } from "child_process";

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return;
  const lines = readFileSync(filePath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    process.env[key] = value;
  }
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
loadEnvFile(path.join(root, ".env"));

const cfg = {
  apiBaseUrl: process.env.API_BASE_URL || "http://localhost:3000",
  userId: process.env.BENCH_USER_ID || "benchmark-user",
  events: Number(process.env.BENCH_EVENTS || 300),
  concurrency: Number(process.env.BENCH_INGEST_CONCURRENCY || 20),
  retrieveQueries: Number(process.env.BENCH_RETRIEVE_QUERIES || 12),
  retrieveLimit: Number(process.env.BENCH_RETRIEVE_LIMIT || 20),
  runtimeRuns: Number(process.env.BENCH_RUNTIME_RUNS || 4),
  runtimePolicyProfile: process.env.BENCH_RUNTIME_POLICY_PROFILE || "default",
  runtimeRecallLimit: process.env.BENCH_RUNTIME_RECALL_LIMIT ? Number(process.env.BENCH_RUNTIME_RECALL_LIMIT) : null,
  runtimePromoteLongForm: process.env.BENCH_RUNTIME_PROMOTE_LONG_FORM === "true",
  runtimeDigestOnCandidate: process.env.BENCH_RUNTIME_DIGEST_ON_CANDIDATE === "true",
  digestRuns: Number(process.env.BENCH_DIGEST_RUNS || 2),
  replayRuns: Number(process.env.BENCH_REPLAY_RUNS || 3),
  timeoutMs: Number(process.env.BENCH_TIMEOUT_MS || 180000),
  requestTimeoutMs: Number(process.env.BENCH_REQUEST_TIMEOUT_MS || 15000),
  outputDir: process.env.BENCH_OUTPUT_DIR || "benchmark-results",
  featureLlm: process.env.FEATURE_LLM === "true",
  profile: process.env.BENCH_PROFILE || "balanced",
  seed: Number(process.env.BENCH_SEED || 42),
  fixture: process.env.BENCH_FIXTURE || "",
  includeReplay: process.env.BENCH_INCLUDE_REPLAY !== "false",
  retrieveUseEmbeddings:
    (process.env.BENCH_RETRIEVE_USE_EMBEDDINGS || process.env.RETRIEVE_USE_EMBEDDINGS || "false") === "true",
  retrieveEmbeddingCandidateLimit: Number(
    process.env.BENCH_RETRIEVE_EMBEDDING_CANDIDATE_LIMIT || process.env.RETRIEVE_EMBEDDING_CANDIDATE_LIMIT || 24
  )
};

const modelConfig = {
  provider: process.env.MODEL_PROVIDER || "openai-compatible",
  baseUrl: process.env.MODEL_BASE_URL || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
  model: process.env.MODEL_NAME || process.env.OPENAI_MODEL || "gpt-4o-mini",
  chatModel: process.env.MODEL_CHAT_NAME || process.env.MODEL_NAME || process.env.OPENAI_MODEL || "gpt-4o-mini",
  structuredOutputModel:
    process.env.MODEL_STRUCTURED_OUTPUT_NAME || process.env.MODEL_NAME || process.env.OPENAI_MODEL || "gpt-4o-mini",
  embeddingModel: process.env.MODEL_EMBEDDING_NAME || null
};

const headers = { "Content-Type": "application/json", "x-user-id": cfg.userId };

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
}

function clamp(v, min = 0, max = 100) {
  return Math.max(min, Math.min(max, v));
}

function msNow() {
  return new Date().toISOString();
}

function buildRetrieveModeConfig() {
  const embeddingConfigured = Boolean(modelConfig.embeddingModel);
  return {
    mode: cfg.retrieveUseEmbeddings && embeddingConfigured ? "hybrid" : "heuristic",
    embeddingRequested: cfg.retrieveUseEmbeddings,
    embeddingConfigured,
    embeddingCandidateLimit: cfg.retrieveEmbeddingCandidateLimit,
    embeddingModel: modelConfig.embeddingModel
  };
}

function deriveRetrieveModeFromHealth(health) {
  const embeddingConfigured = Boolean(health?.model?.embeddingModel);
  const embeddingRequested = Boolean(health?.retrieve?.useEmbeddings);
  return {
    mode: embeddingRequested && embeddingConfigured ? "hybrid" : "heuristic",
    embeddingRequested,
    embeddingConfigured,
    embeddingCandidateLimit: health?.retrieve?.embeddingCandidateLimit ?? cfg.retrieveEmbeddingCandidateLimit,
    embeddingModel: health?.model?.embeddingModel || null
  };
}

function getGitCommit() {
  try {
    return execSync("git rev-parse HEAD", { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return process.env.GIT_COMMIT || "unknown";
  }
}

function getGitDescribe() {
  try {
    const base = execSync("git describe --tags --always --dirty", { cwd: root, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    return base || "unknown";
  } catch {
    return process.env.GIT_DESCRIBE || "unknown";
  }
}

function getEnvSnapshot() {
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpu: os.cpus()[0]?.model || "unknown",
    cores: os.cpus().length,
    memoryGb: Number((os.totalmem() / (1024 ** 3)).toFixed(2))
  };
}

async function apiFetch(method, endpoint, body) {
  const t0 = performance.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), cfg.requestTimeoutMs);
    try {
      const response = await fetch(`${cfg.apiBaseUrl}${endpoint}`, {
        method,
        headers,
        signal: controller.signal,
        ...(body ? { body: JSON.stringify(body) } : {})
      });
      clearTimeout(timeout);
      const text = await response.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = { raw: text };
      }
      return {
        ok: response.ok,
        status: response.status,
        json,
        latencyMs: performance.now() - t0
      };
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    return {
      ok: false,
      status: 599,
      json: { error: "fetch_failed", detail: String(error) },
      latencyMs: performance.now() - t0
    };
  }
}

async function withConcurrency(items, limit, worker) {
  const results = [];
  let cursor = 0;
  const runners = Array.from({ length: limit }).map(async () => {
    while (true) {
      const i = cursor;
      cursor += 1;
      if (i >= items.length) break;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), t | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function loadFixture(fixturePath) {
  if (!fixturePath) return null;
  const fullPath = path.isAbsolute(fixturePath) ? fixturePath : path.join(root, fixturePath);
  const raw = readFileSync(fullPath, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.events)) {
    throw new Error("invalid_fixture: missing events array");
  }
  return {
    name: typeof parsed.name === "string" ? parsed.name : null,
    description: typeof parsed.description === "string" ? parsed.description : null,
    benchmarkFocus: Array.isArray(parsed.benchmarkFocus) ? parsed.benchmarkFocus.filter((item) => typeof item === "string") : [],
    events: parsed.events,
    gold: parsed.gold ?? null,
    retrieveCases: Array.isArray(parsed.retrieveCases) ? parsed.retrieveCases : null,
    retrieveLimit: typeof parsed.retrieveLimit === "number" ? parsed.retrieveLimit : null,
    source: fullPath
  };
}

function parseGoldFacts(events) {
  const goal = [];
  const constraints = [];
  const decisions = [];
  const todos = [];
  const allTodos = [];

  for (const event of events) {
    const text = String(event.content || "");
    const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
    for (const line of lines) {
      if (/^goal\s*:/i.test(line)) goal.push(line.replace(/^goal\s*:\s*/i, "").trim());
      if (/^constraint\s*:/i.test(line)) constraints.push(line.replace(/^constraint\s*:\s*/i, "").trim());
      if (/^todo\s*:/i.test(line)) {
        const todo = line.replace(/^todo\s*:\s*/i, "").trim();
        todos.push(todo);
        allTodos.push(todo);
      }
    }
    if (/\b(decide|decision|we will|agreed)\b/i.test(text)) {
      decisions.push(text.trim());
    }
    if (/^todo\s*:/i.test(text.trim())) {
      allTodos.push(text.replace(/^todo\s*:\s*/i, "").trim());
    }
  }

  const uniq = (items) => [...new Set(items.filter(Boolean))];
  return {
    goal: uniq(goal),
    constraints: uniq(constraints),
    decisions: uniq(decisions),
    todos: uniq(todos),
    openQuestions: [],
    risks: [],
    resolvedOpenQuestions: [],
    resolvedRisks: [],
    transientTodos: uniq(allTodos.filter((item) => !todos.includes(item))),
    latestDocumentFacts: [],
    supersededDocumentFacts: [],
    contradictions: { goal: [], constraints: [], decisions: [], todos: [] }
  };
}

function loadGoldFacts(fixture) {
  if (!fixture) return null;
  if (fixture.gold && typeof fixture.gold === "object") {
    return {
      goal: Array.isArray(fixture.gold.goal) ? fixture.gold.goal : [],
      constraints: Array.isArray(fixture.gold.constraints) ? fixture.gold.constraints : [],
      decisions: Array.isArray(fixture.gold.decisions) ? fixture.gold.decisions : [],
      todos: Array.isArray(fixture.gold.todos) ? fixture.gold.todos : [],
      openQuestions: Array.isArray(fixture.gold.openQuestions) ? fixture.gold.openQuestions : [],
      risks: Array.isArray(fixture.gold.risks) ? fixture.gold.risks : [],
      resolvedOpenQuestions: Array.isArray(fixture.gold.resolvedOpenQuestions) ? fixture.gold.resolvedOpenQuestions : [],
      resolvedRisks: Array.isArray(fixture.gold.resolvedRisks) ? fixture.gold.resolvedRisks : [],
      transientTodos: Array.isArray(fixture.gold.transientTodos) ? fixture.gold.transientTodos : [],
      latestDocumentFacts: Array.isArray(fixture.gold.latestDocumentFacts) ? fixture.gold.latestDocumentFacts : [],
      supersededDocumentFacts: Array.isArray(fixture.gold.supersededDocumentFacts) ? fixture.gold.supersededDocumentFacts : [],
      contradictions: fixture.gold.contradictions && typeof fixture.gold.contradictions === "object"
        ? {
            goal: Array.isArray(fixture.gold.contradictions.goal) ? fixture.gold.contradictions.goal : [],
            constraints: Array.isArray(fixture.gold.contradictions.constraints) ? fixture.gold.contradictions.constraints : [],
            decisions: Array.isArray(fixture.gold.contradictions.decisions) ? fixture.gold.contradictions.decisions : [],
            todos: Array.isArray(fixture.gold.contradictions.todos) ? fixture.gold.contradictions.todos : []
          }
        : { goal: [], constraints: [], decisions: [], todos: [] }
    };
  }
  return parseGoldFacts(fixture.events);
}

function generateEvents(total, rng) {
  const events = [];
  for (let i = 0; i < total; i += 1) {
    if (i % 60 === 0) {
      events.push({ type: "document", key: "doc:goal", content: `goal: ship benchmarkable memory engine v${Math.floor(i / 60) + 1}` });
      continue;
    }
    if (i % 45 === 0) {
      events.push({ type: "document", key: "doc:constraints", content: "constraint: no hosted dependency\nconstraint: keep api stable" });
      continue;
    }
    if (i % 25 === 0) {
      events.push({ type: "stream", content: `We decide to prioritize ingestion throughput batch ${i}` });
      continue;
    }
    if (i % 17 === 0) {
      events.push({ type: "stream", content: `Blocked by queue visibility timeout around item ${i}` });
      continue;
    }
    if (i % 9 === 0) {
      events.push({ type: "stream", content: `TODO: add benchmark assertion for p95 latency group ${i}` });
      continue;
    }
    if (i % 7 === 0) {
      events.push({ type: "stream", content: `Status update: processed event ${i}` });
      continue;
    }
    const noise = rng ? Math.floor(rng() * 1000) : Math.floor(i / 3);
    events.push({ type: "stream", content: `noise ping ${noise}` });
  }
  return events;
}

function scoreIngest(throughput, p95) {
  const throughputScore = clamp((throughput / 80) * 70);
  const latencyScore = clamp(30 - Math.max(0, (p95 - 180) / 8));
  return clamp(throughputScore + latencyScore);
}

function scoreRetrieve(hitRate, p95) {
  const hitScore = clamp(hitRate * 70);
  const latencyScore = clamp(30 - Math.max(0, (p95 - 250) / 10));
  return clamp(hitScore + latencyScore);
}

function scoreDigest(successRate, consistencyRate, avgLatencyMs) {
  const successScore = clamp(successRate * 45);
  const consistencyScore = clamp(consistencyRate * 35);
  const latencyScore = clamp(20 - Math.max(0, (avgLatencyMs - 15000) / 1500));
  return clamp(successScore + consistencyScore + latencyScore);
}

function scoreReminder(successRate, avgDelayMs) {
  const successScore = clamp(successRate * 70);
  const delayScore = clamp(30 - Math.max(0, (avgDelayMs - 60000) / 5000));
  return clamp(successScore + delayScore);
}

function omissionWarningRate(consistencyTaxonomy) {
  const warnings = consistencyTaxonomy?.warnings || {};
  const omissionKeys = ["goal_omission", "constraint_omission", "decision_omission", "todo_omission"];
  const omissionTotal = omissionKeys.reduce((sum, key) => sum + (warnings[key] || 0), 0);
  const warningTotal = Object.values(warnings).reduce((sum, count) => sum + count, 0);
  if (warningTotal === 0) return 0;
  return Number((omissionTotal / warningTotal).toFixed(3));
}

function canonicalizeDigestOutput(digest) {
  return {
    summary: String(digest?.summary || "").replace(/\s+/g, " ").trim(),
    changes: String(digest?.changes || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.replace(/^-\s*/, ""))
      .sort(),
    nextSteps: (Array.isArray(digest?.nextSteps) ? digest.nextSteps : [])
      .map((line) => String(line).replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .sort()
  };
}

function sameCanonicalDigest(a, b) {
  return JSON.stringify(canonicalizeDigestOutput(a)) === JSON.stringify(canonicalizeDigestOutput(b));
}

function isMaterialDigest(digest) {
  const changes = String(digest?.changes || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^-\s*/, ""));
  return Boolean(
    digest &&
    changes.some((value) => String(value || "").trim().length > 0)
  );
}

function buildLongTermMemoryReliabilityBreakdown(digestMetrics, replayMetrics, runtimeMetrics, answerMetrics) {
  if (!digestMetrics?.enabled) {
    return {
      consistency: 0,
      retention: 0,
      contradictionControl: 0,
      replay: 0,
      runtimeGrounding: 0,
      total: 0
    };
  }

  const consistencyScore = clamp((digestMetrics.consistencyPassRate || 0) * 24);
  const repeatabilityScore = clamp((digestMetrics.repeatabilityRate || 0) * 6);
  const retention = digestMetrics.goldRetention
    ? (
        [
          digestMetrics.goldRetention.goalRetentionRate || digestMetrics.goldRetention.recallGoal || 0,
          digestMetrics.goldRetention.constraintPreservationRate || digestMetrics.goldRetention.recallConstraints || 0,
          digestMetrics.goldRetention.decisionContinuityRate || digestMetrics.goldRetention.recallDecisions || 0,
          digestMetrics.goldRetention.todoContinuityRate || digestMetrics.goldRetention.recallTodos || 0,
          digestMetrics.goldRetention.stateGoalRetentionRate,
          digestMetrics.goldRetention.stateConstraintPreservationRate,
          digestMetrics.goldRetention.stateDecisionContinuityRate,
          digestMetrics.goldRetention.stateTodoContinuityRate
        ].filter((value) => typeof value === "number").reduce((sum, value, _, items) => sum + value / items.length, 0)
      )
    : digestMetrics.consistencyPassRate || 0;
  const contradiction = digestMetrics.goldRetention
    ? (
        (digestMetrics.goldRetention.goalContradictionRate || 0) +
        (digestMetrics.goldRetention.constraintContradictionRate || 0) +
        (digestMetrics.goldRetention.decisionContradictionRate || 0) +
        (digestMetrics.goldRetention.todoContradictionRate || 0) +
        (digestMetrics.goldRetention.temporaryTodoIntrusionRate || 0) +
        (digestMetrics.goldRetention.supersededDocumentIntrusionRate || 0) +
        (digestMetrics.goldRetention.stateSupersededDocumentIntrusionRate || 0)
      ) / 7
    : 0;
  const omissionRisk = digestMetrics.omissionWarningRate || 0;
  const integrityRisk = contradiction * 0.75 + omissionRisk * 0.25;
  const retentionScore = clamp(retention * 35);
  const contradictionScore = clamp((1 - integrityRisk) * 20);

  let replayScore = 15;
  if (replayMetrics?.enabled) {
    if (!(replayMetrics.successfulRuns > 0)) {
      replayScore = 0;
    } else {
      const consistency = replayMetrics.rebuildConsistencyRate ?? 0;
      const stateStability = 1 - (replayMetrics.crossRunStateDivergenceRate ?? 0);
      const transitionMatch = replayMetrics.transitionTaxonomyMatchRate ?? 0;
      const transitionStability = 1 - (replayMetrics.crossRunTransitionDivergenceRate ?? 0);
      const stability = (stateStability * 0.5) + (transitionMatch * 0.25) + (transitionStability * 0.25);
      const successRate = (replayMetrics.successfulRuns || 0) / Math.max(1, replayMetrics.rebuildRuns || 1);
      replayScore = clamp(((consistency * 0.7) + (stability * 0.3)) * successRate * 15);
    }
  }

  let runtimeScore = 0;
  if (runtimeMetrics?.enabled) {
    const groundingQuality =
      (
        (runtimeMetrics.evidenceCoverageRate || 0) * 0.3 +
        (runtimeMetrics.evidenceEventRankingReasonRate || 0) * 0.25 +
        (runtimeMetrics.evidenceEventScoreRate || 0) * 0.2 +
        (runtimeMetrics.evidenceStateConfidenceRate || 0) * 0.1 +
        (runtimeMetrics.evidenceStateTransitionTaxonomyRate || 0) * 0.15
      );
    const answerGroundingQuality = answerMetrics?.enabled
      ? (
          (answerMetrics.evidenceCoverageRate || 0) * 0.3 +
          (answerMetrics.evidenceEventRankingReasonRate || 0) * 0.25 +
          (answerMetrics.evidenceEventScoreRate || 0) * 0.2 +
          (answerMetrics.evidenceStateConfidenceRate || 0) * 0.1 +
          (answerMetrics.evidenceStateTransitionTaxonomyRate || 0) * 0.15
        )
      : 1;
    const combinedGroundingQuality = (groundingQuality * 0.6) + (answerGroundingQuality * 0.4);
    const diagnosticsQuality =
      (
        (runtimeMetrics.runtimeLayerAlignmentRate || 0) * 0.35 +
        (runtimeMetrics.runtimeWarningsFreeRate || 0) * 0.15 +
        (runtimeMetrics.layerStatusAlignmentRate || 0) * 0.15 +
        (runtimeMetrics.layerStatusWarningsFreeRate || 0) * 0.1 +
        (runtimeMetrics.layerStatusWorkingMemoryCaughtUpRate || 0) * 0.1 +
        (runtimeMetrics.layerStatusStableStateCaughtUpRate || 0) * 0.05 +
        (runtimeMetrics.runtimeLayerStatusConsistencyRate || 0) * 0.1
      );
    const combinedRuntimeQuality = (combinedGroundingQuality * 0.8) + (diagnosticsQuality * 0.2);
    const combinedSuccess =
      (
        (runtimeMetrics.success / Math.max(1, runtimeMetrics.runs)) * 0.6 +
        ((answerMetrics?.success ?? 0) / Math.max(1, answerMetrics?.runs ?? 1)) * 0.4
      );
    runtimeScore = clamp((combinedRuntimeQuality * 7.5) + ((1 - Math.max(0, 1 - combinedSuccess)) * 7.5));
  }

  return {
    consistency: Number((consistencyScore + repeatabilityScore).toFixed(2)),
    retention: Number(retentionScore.toFixed(2)),
    contradictionControl: Number(contradictionScore.toFixed(2)),
    replay: Number(replayScore.toFixed(2)),
    runtimeGrounding: Number(runtimeScore.toFixed(2)),
    total: Number(clamp(consistencyScore + repeatabilityScore + retentionScore + contradictionScore + replayScore + runtimeScore).toFixed(2))
  };
}

function scoreLongTermMemoryReliability(digestMetrics, replayMetrics, runtimeMetrics, answerMetrics) {
  return buildLongTermMemoryReliabilityBreakdown(digestMetrics, replayMetrics, runtimeMetrics, answerMetrics).total;
}

function computeOverallScore(parts, featureLlm) {
  if (featureLlm) {
    return clamp(parts.ingest * 0.3 + parts.retrieve * 0.2 + parts.digest * 0.3 + parts.reminder * 0.2);
  }
  return clamp(parts.ingest * 0.45 + parts.retrieve * 0.35 + parts.reminder * 0.2);
}

function isActionable(step) {
  const s = step.trim();
  // The English leading-verb heuristic cannot evaluate CJK (or other non-Latin) text,
  // so don't penalize steps containing CJK characters — judging them would always fail.
  if (/[一-鿿぀-ヿ가-힯]/.test(s)) return true;
  return /^(add|analyze|build|create|define|deliver|document|fix|implement|investigate|measure|monitor|plan|prioritize|refactor|review|ship|test|update|validate|write)\b/i.test(s);
}

function normalizeText(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ");
}

function incrementCounter(map, key) {
  map[key] = (map[key] || 0) + 1;
}

function classifyDigestIssues(digest) {
  const issues = [];
  const changes = String(digest.changes || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const nextSteps = Array.isArray(digest.nextSteps) ? digest.nextSteps : [];
  const summaryWords = String(digest.summary || "").split(/\s+/).filter(Boolean).length;

  if (summaryWords > 120) issues.push("summary_too_long");
  if (changes.length > 3) issues.push("too_many_changes");
  if (nextSteps.length < 1 || nextSteps.length > 3) issues.push("invalid_next_steps_count");
  if (changes.length > 0) {
    const normalizedChanges = changes.map((line) => normalizeText(line.replace(/^-\s*/, ""))).filter(Boolean);
    if (new Set(normalizedChanges).size !== normalizedChanges.length) {
      issues.push("duplicate_changes");
    }
  }
  if (nextSteps.some((step) => !isActionable(step))) {
    issues.push("non_actionable_next_step");
  }

  return {
    issues,
    valid: issues.length === 0
  };
}

function factRecall(text, facts) {
  if (!facts.length) return 1;
  const normalized = normalizeText(text);
  const hits = facts.filter((item) => normalized.includes(normalizeText(item))).length;
  return hits / facts.length;
}

function contradictionRate(text, contradictions) {
  if (!contradictions.length) return 0;
  const normalized = normalizeText(text);
  const hits = contradictions.filter((item) => normalized.includes(normalizeText(item))).length;
  return hits / contradictions.length;
}

function countMatches(text, facts) {
  const normalized = normalizeText(text);
  return facts.filter((item) => normalized.includes(normalizeText(item))).length;
}

function stateToFactText(state) {
  const stable = state?.stableFacts ?? {};
  const working = state?.workingNotes ?? {};
  return [
    stable.goal || "",
    ...(stable.constraints ?? []),
    ...(stable.decisions ?? []),
    ...(state?.todos ?? []),
    ...(working.openQuestions ?? []),
    ...(working.risks ?? [])
  ]
    .filter(Boolean)
    .join("\n");
}

function stateWorkingNoteIntrusionRate(values, excluded) {
  if (!excluded.length) return 0;
  const normalizedValues = (Array.isArray(values) ? values : []).map((item) => normalizeText(String(item)));
  const hits = excluded.filter((item) => normalizedValues.includes(normalizeText(item))).length;
  return Number((hits / excluded.length).toFixed(3));
}

function stateTodoIntrusionRate(state, transientTodos) {
  if (!transientTodos.length) return 0;
  const todos = Array.isArray(state?.todos) ? state.todos : [];
  const normalizedTodos = todos.map((item) => normalizeText(String(item)));
  const hits = transientTodos.filter((item) => normalizedTodos.includes(normalizeText(item))).length;
  return Number((hits / transientTodos.length).toFixed(3));
}

function averageMetric(runs, key) {
  const values = runs.map((run) => run[key]).filter((value) => typeof value === "number");
  if (!values.length) return null;
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(3));
}

function averageDefined(values) {
  const defined = values.filter((value) => typeof value === "number");
  if (!defined.length) return 0;
  return defined.reduce((sum, value) => sum + value, 0) / defined.length;
}

function aggregateDriftRate(parts) {
  return Number(averageDefined(parts).toFixed(3));
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    const items = value.map(canonicalize);
    if (items.every((item) => typeof item === "string")) {
      return [...items].sort();
    }
    return items;
  }
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = canonicalize(value[key]);
        return acc;
      }, {});
  }
  return value;
}

function canonicalizeReplayState(state) {
  if (!state || typeof state !== "object") return canonicalize(state);
  const clone = { ...state };
  delete clone.recentChanges;
  return canonicalize(clone);
}

function toStringList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") return item.trim();
      if (item && typeof item === "object") {
        const typed = item;
        return [typed.sourceType, typed.id, typed.key, typed.kind].filter(Boolean).join(":").trim();
      }
      return "";
    })
    .filter(Boolean);
}

function diffStringLists(before, after) {
  const baseline = [...new Set(toStringList(before))].sort();
  const rebuilt = [...new Set(toStringList(after))].sort();
  const baselineSet = new Set(baseline);
  const rebuiltSet = new Set(rebuilt);
  return {
    match: JSON.stringify(baseline) === JSON.stringify(rebuilt),
    missingFromReplay: baseline.filter((item) => !rebuiltSet.has(item)),
    addedInReplay: rebuilt.filter((item) => !baselineSet.has(item))
  };
}

function diffScalar(before, after) {
  return {
    match: before === after,
    baseline: before ?? null,
    rebuilt: after ?? null
  };
}

function flattenValueProvenance(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const value = typeof entry.value === "string" ? entry.value.trim() : "";
      const refs = toStringList(entry.refs);
      if (!value) return [];
      return [`${value}<=${refs.sort().join("|")}`];
    })
    .filter(Boolean);
}

function flattenGoalProvenance(refs) {
  const normalized = toStringList(refs);
  return normalized.length ? [`goal<=${normalized.sort().join("|")}`] : [];
}

function flattenConfidenceList(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const value = typeof entry.value === "string" ? entry.value.trim() : "";
      const score = typeof entry.score === "number" ? entry.score : null;
      if (!value || score === null) return [];
      return [`${value}<=${score}`];
    })
    .filter(Boolean);
}

function flattenRecentChanges(changes) {
  if (!Array.isArray(changes)) return [];
  return changes
    .map((change) => {
      if (!change || typeof change !== "object") return "";
      const evidence = toStringList(change.evidence ? [change.evidence] : []);
      const field = typeof change.field === "string" ? change.field : "";
      const action = typeof change.action === "string" ? change.action : "";
      const value = typeof change.value === "string" ? change.value.trim() : "";
      if (!field || !action || !value) return "";
      return `${field}:${action}:${value}${evidence.length ? `<=${evidence.join("|")}` : ""}`;
    })
    .filter(Boolean);
}

function summarizeTransitionTaxonomy(changes, transitionSummary) {
  if (transitionSummary && typeof transitionSummary === "object" && Object.keys(transitionSummary).length > 0) {
    return Object.fromEntries(
      Object.entries(transitionSummary)
        .filter(([, count]) => Number.isFinite(count) && count > 0)
        .sort(([a], [b]) => a.localeCompare(b))
    );
  }
  const counts = {};
  if (!Array.isArray(changes)) return counts;
  for (const change of changes) {
    if (!change || typeof change !== "object") continue;
    const field = typeof change.field === "string" ? change.field.trim() : "";
    const action = typeof change.action === "string" ? change.action.trim() : "";
    if (!field || !action) continue;
    const key = `${field}:${action}`;
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function diffTransitionTaxonomy(beforeState, afterState) {
  const baseline = summarizeTransitionTaxonomy(beforeState?.recentChanges, beforeState?.transitionSummary);
  const rebuilt = summarizeTransitionTaxonomy(afterState?.recentChanges, afterState?.transitionSummary);
  const keys = [...new Set([...Object.keys(baseline), ...Object.keys(rebuilt)])].sort();
  const mismatchedKeys = keys.filter((key) => (baseline[key] || 0) !== (rebuilt[key] || 0));
  const matchedKeys = keys.filter((key) => !mismatchedKeys.includes(key));
  return {
    match: mismatchedKeys.length === 0,
    baseline,
    rebuilt,
    matchedKeys,
    mismatchedKeys,
    mismatchRate: Number((mismatchedKeys.length / Math.max(1, keys.length)).toFixed(3))
  };
}

function buildStateDiff(baselineState, rebuiltState) {
  const baselineStable = baselineState?.stableFacts ?? {};
  const rebuiltStable = rebuiltState?.stableFacts ?? {};
  const baselineWorking = baselineState?.workingNotes ?? {};
  const rebuiltWorking = rebuiltState?.workingNotes ?? {};
  const baselineProvenance = baselineState?.provenance ?? {};
  const rebuiltProvenance = rebuiltState?.provenance ?? {};
  const baselineConfidence = baselineState?.confidence ?? {};
  const rebuiltConfidence = rebuiltState?.confidence ?? {};

  return {
    goal: diffScalar(baselineStable.goal ?? null, rebuiltStable.goal ?? null),
    constraints: diffStringLists(baselineStable.constraints, rebuiltStable.constraints),
    decisions: diffStringLists(baselineStable.decisions, rebuiltStable.decisions),
    todos: diffStringLists(baselineState?.todos, rebuiltState?.todos),
    volatileContext: diffStringLists(baselineState?.volatileContext, rebuiltState?.volatileContext),
    evidenceRefs: diffStringLists(baselineState?.evidenceRefs, rebuiltState?.evidenceRefs),
    goalProvenance: diffStringLists(flattenGoalProvenance(baselineProvenance.goal), flattenGoalProvenance(rebuiltProvenance.goal)),
    constraintProvenance: diffStringLists(flattenValueProvenance(baselineProvenance.constraints), flattenValueProvenance(rebuiltProvenance.constraints)),
    decisionProvenance: diffStringLists(flattenValueProvenance(baselineProvenance.decisions), flattenValueProvenance(rebuiltProvenance.decisions)),
    todoProvenance: diffStringLists(flattenValueProvenance(baselineProvenance.todos), flattenValueProvenance(rebuiltProvenance.todos)),
    goalConfidence: diffScalar(baselineConfidence.goal ?? null, rebuiltConfidence.goal ?? null),
    constraintConfidence: diffStringLists(flattenConfidenceList(baselineConfidence.constraints), flattenConfidenceList(rebuiltConfidence.constraints)),
    decisionConfidence: diffStringLists(flattenConfidenceList(baselineConfidence.decisions), flattenConfidenceList(rebuiltConfidence.decisions)),
    todoConfidence: diffStringLists(flattenConfidenceList(baselineConfidence.todos), flattenConfidenceList(rebuiltConfidence.todos)),
    volatileContextConfidence: diffStringLists(flattenConfidenceList(baselineConfidence.volatileContext), flattenConfidenceList(rebuiltConfidence.volatileContext)),
    openQuestionConfidence: diffStringLists(flattenConfidenceList(baselineConfidence.openQuestions), flattenConfidenceList(rebuiltConfidence.openQuestions)),
    riskConfidence: diffStringLists(flattenConfidenceList(baselineConfidence.risks), flattenConfidenceList(rebuiltConfidence.risks)),
    recentChanges: diffStringLists(flattenRecentChanges(baselineState?.recentChanges), flattenRecentChanges(rebuiltState?.recentChanges)),
    transitionTaxonomy: diffTransitionTaxonomy(baselineState, rebuiltState),
    openQuestions: diffStringLists(baselineWorking.openQuestions, rebuiltWorking.openQuestions),
    risks: diffStringLists(baselineWorking.risks, rebuiltWorking.risks),
    workingContext: diffScalar(baselineWorking.context ?? null, rebuiltWorking.context ?? null)
  };
}

function summarizeStateDiff(diff) {
  const ignoredCategories = new Set(["recentChanges"]);
  const mismatchedCategories = Object.entries(diff)
    .filter(([key, value]) => !ignoredCategories.has(key) && !value.match)
    .map(([key]) => key);
  const matchedCategories = Object.entries(diff)
    .filter(([key, value]) => !ignoredCategories.has(key) && value.match)
    .map(([key]) => key);
  return {
    stateMatch: mismatchedCategories.length === 0,
    matchedCategories,
    mismatchedCategories
  };
}

async function runReplayRebuild(scopeId, baselineState) {
  const rebuild = await apiFetch("POST", "/memory/digest/rebuild", { scopeId, strategy: "full" });
  if (!rebuild.ok || !rebuild.json.rebuildGroupId) {
    return { ok: false, error: `rebuild_enqueue_failed:${rebuild.status}` };
  }
  const rebuildHistory = await waitForStateHistory(scopeId, rebuild.json.rebuildGroupId);
  if (!rebuildHistory.ok) {
    return { ok: false, error: rebuildHistory.error };
  }

  const latestRebuildState = rebuildHistory.items[0]?.state ?? null;
  const baselineCanonical = canonicalizeReplayState(baselineState);
  const rebuildCanonical = canonicalizeReplayState(latestRebuildState);
  const diff = buildStateDiff(baselineState, latestRebuildState);
  const diffSummary = summarizeStateDiff(diff);

  return {
    ok: true,
    rebuildSnapshots: rebuildHistory.items.length,
    stateMatch: diffSummary.stateMatch,
    matchedCategories: diffSummary.matchedCategories,
    mismatchedCategories: diffSummary.mismatchedCategories,
    diff,
    canonicalState: rebuildCanonical
  };
}

function compareReplayRuns(successfulRuns) {
  if (successfulRuns.length < 2) {
    return {
      crossRunStateDivergenceRate: 0,
      crossRunTransitionDivergenceRate: 0,
      crossRunMatchedCategories: successfulRuns[0]?.matchedCategories ?? [],
      crossRunMismatchedCategories: []
    };
  }

  const categoryUniverse = new Set();
  let mismatchRatioTotal = 0;
  let comparisons = 0;
  let transitionMismatchRatioTotal = 0;
  const mismatched = new Set();
  const matched = new Set();

  for (let i = 1; i < successfulRuns.length; i += 1) {
    const diff = buildStateDiff(successfulRuns[i - 1].canonicalState, successfulRuns[i].canonicalState);
    const summary = summarizeStateDiff(diff);
    const totalCategories = summary.matchedCategories.length + summary.mismatchedCategories.length;
    mismatchRatioTotal += totalCategories > 0 ? summary.mismatchedCategories.length / totalCategories : 0;
    comparisons += 1;
    transitionMismatchRatioTotal += diff.transitionTaxonomy?.mismatchRate ?? 0;

    for (const key of summary.matchedCategories) {
      categoryUniverse.add(key);
      if (!mismatched.has(key)) matched.add(key);
    }
    for (const key of summary.mismatchedCategories) {
      categoryUniverse.add(key);
      mismatched.add(key);
      matched.delete(key);
    }
  }

  return {
    crossRunStateDivergenceRate: Number((mismatchRatioTotal / Math.max(1, comparisons)).toFixed(3)),
    crossRunTransitionDivergenceRate: Number((transitionMismatchRatioTotal / Math.max(1, comparisons)).toFixed(3)),
    crossRunMatchedCategories: [...matched].filter((key) => categoryUniverse.has(key)).sort(),
    crossRunMismatchedCategories: [...mismatched].sort()
  };
}

function containsAny(text, terms) {
  const normalized = normalizeText(text);
  return terms.some((term) => normalized.includes(normalizeText(term).trim()));
}

async function waitForNewDigest(scopeId, previousCount) {
  const start = Date.now();
  while (Date.now() - start <= cfg.timeoutMs) {
    const result = await apiFetch("GET", `/memory/digests?scopeId=${scopeId}&limit=5`);
    if (!result.ok) return { ok: false, error: `digest_list_failed:${result.status}` };
    const items = result.json.items || [];
    if (items.length > previousCount) return { ok: true, digest: items[0] };
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  return { ok: false, error: "digest_timeout" };
}

async function waitForStateSnapshot(scopeId, digestId) {
  const start = Date.now();
  while (Date.now() - start <= cfg.timeoutMs) {
    const result = await apiFetch("GET", `/memory/state?scopeId=${scopeId}`);
    if (!result.ok) return { ok: false, error: `state_failed:${result.status}` };
    if (result.json?.digestId === digestId && result.json?.state) {
      return { ok: true, state: result.json.state };
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  return { ok: false, error: "state_snapshot_timeout" };
}

async function waitForWorkingMemoryVersion(scopeId, previousVersion) {
  const start = Date.now();
  while (Date.now() - start <= cfg.timeoutMs) {
    const result = await apiFetch("GET", `/memory/working-state?scopeId=${scopeId}`);
    if (!result.ok) return { ok: false, error: `working_state_failed:${result.status}` };
    const version = typeof result.json?.version === "number" ? result.json.version : 0;
    if (version > previousVersion) {
      return { ok: true, latencyMs: Date.now() - start, version };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { ok: false, error: "working_state_timeout", latencyMs: cfg.timeoutMs };
}

async function waitForStableStateVersion(scopeId, previousDigestId) {
  const start = Date.now();
  while (Date.now() - start <= cfg.timeoutMs) {
    const result = await apiFetch("GET", `/memory/stable-state?scopeId=${scopeId}`);
    if (!result.ok) return { ok: false, error: `stable_state_failed:${result.status}` };
    const digestId = typeof result.json?.digestId === "string" ? result.json.digestId : null;
    if (digestId && digestId !== previousDigestId) {
      return { ok: true, latencyMs: Date.now() - start, digestId };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { ok: false, error: "stable_state_timeout", latencyMs: cfg.timeoutMs };
}

async function waitForReminderSent(reminderId, dueAtIso) {
  const reminderTimeoutMs = Math.max(cfg.timeoutMs, 75_000);
  const start = Date.now();
  while (Date.now() - start <= reminderTimeoutMs) {
    let cursor = null;
    while (true) {
      const query = cursor
        ? `/reminders?status=sent&limit=100&cursor=${encodeURIComponent(cursor)}`
        : "/reminders?status=sent&limit=100";
      const result = await apiFetch("GET", query);
      if (!result.ok) break;
      const found = (result.json.items || []).find((item) => item.id === reminderId);
      if (found) {
        const delayMs = Date.now() - new Date(dueAtIso).getTime();
        return { ok: true, delayMs };
      }
      cursor = typeof result.json?.nextCursor === "string" && result.json.nextCursor.length > 0
        ? result.json.nextCursor
        : null;
      if (!cursor) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  return { ok: false, delayMs: reminderTimeoutMs };
}

async function waitForStateHistory(scopeId, rebuildGroupId) {
  const start = Date.now();
  let stableRepeats = 0;
  let lastCount = -1;
  while (Date.now() - start <= cfg.timeoutMs) {
    const result = await apiFetch(
      "GET",
      `/memory/state/history?scopeId=${scopeId}&limit=50&rebuildGroupId=${encodeURIComponent(rebuildGroupId)}`
    );
    if (!result.ok) return { ok: false, error: `state_history_failed:${result.status}` };
    const items = result.json.items || [];
    if (items.length > 0) {
      if (items.length === lastCount) {
        stableRepeats += 1;
      } else {
        stableRepeats = 0;
      }
      lastCount = items.length;
      if (stableRepeats >= 1) {
        return { ok: true, items };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  return { ok: false, error: "state_history_timeout" };
}

async function createBenchmarkScope(name) {
  const scopeResp = await apiFetch("POST", "/scopes", { name });
  if (!scopeResp.ok || !scopeResp.json.id) {
    throw new Error(`failed_create_scope:${scopeResp.status}:${JSON.stringify(scopeResp.json)}`);
  }
  return scopeResp.json.id;
}

async function ingestScopeEvents(scopeId, events, concurrency) {
  const ingestStart = performance.now();
  const ingestResults = await withConcurrency(events, concurrency, async (item) => {
    const body = { scopeId, source: "sdk", ...item };
    return apiFetch("POST", "/memory/events", body);
  });
  const ingestDurationSec = (performance.now() - ingestStart) / 1000;
  const ingestLatencies = ingestResults.map((r) => r.latencyMs);
  const ingestSuccess = ingestResults.filter((r) => r.ok).length;
  const ingestThroughput = ingestSuccess / Math.max(0.001, ingestDurationSec);
  return {
    total: events.length,
    success: ingestSuccess,
    failure: events.length - ingestSuccess,
    throughputEventsPerSec: Number(ingestThroughput.toFixed(2)),
    p50Ms: Number(percentile(ingestLatencies, 50).toFixed(2)),
    p95Ms: Number(percentile(ingestLatencies, 95).toFixed(2))
  };
}

async function runBaselineDigest(scopeId) {
  const before = await apiFetch("GET", `/memory/digests?scopeId=${scopeId}&limit=5`);
  const beforeCount = (before.json.items || []).length;
  const enqueue = await apiFetch("POST", "/memory/digest", { scopeId });
  if (!enqueue.ok) {
    return { ok: false, error: `baseline_digest_enqueue_failed:${enqueue.status}` };
  }
  const waited = await waitForNewDigest(scopeId, beforeCount);
  if (!waited.ok) {
    return { ok: false, error: waited.error || "baseline_digest_wait_failed" };
  }
  const stateSnapshot = await waitForStateSnapshot(scopeId, waited.digest.id);
  if (!stateSnapshot.ok || !stateSnapshot.state) {
    return { ok: false, error: stateSnapshot.error || "baseline_state_failed" };
  }
  return { ok: true, digest: waited.digest, state: stateSnapshot.state };
}

async function run() {
  const profiles = {
    quick: { events: 50, concurrency: 8, retrieveQueries: 8, digestRuns: 1 },
    balanced: { events: 120, concurrency: 12, retrieveQueries: 16, digestRuns: 2 },
    stress: { events: 300, concurrency: 20, retrieveQueries: 24, digestRuns: 3 }
  };
  if (profiles[cfg.profile]) {
    cfg.events = Number(process.env.BENCH_EVENTS || profiles[cfg.profile].events);
    cfg.concurrency = Number(process.env.BENCH_INGEST_CONCURRENCY || profiles[cfg.profile].concurrency);
    cfg.retrieveQueries = Number(process.env.BENCH_RETRIEVE_QUERIES || profiles[cfg.profile].retrieveQueries);
    cfg.runtimeRuns = Number(process.env.BENCH_RUNTIME_RUNS || Math.max(2, Math.floor(profiles[cfg.profile].retrieveQueries / 4)));
    cfg.digestRuns = Number(process.env.BENCH_DIGEST_RUNS || profiles[cfg.profile].digestRuns);
  }

  const startedAt = msNow();
  const report = {
    startedAt,
    commit: getGitCommit(),
    describe: getGitDescribe(),
    environment: {
      ...getEnvSnapshot(),
      model: modelConfig
    },
    config: cfg,
    metrics: {},
    scores: {},
    notes: []
  };
  if (process.env.ABLATION_NAME) {
    report.config.ablationName = process.env.ABLATION_NAME;
  }

  const health = await apiFetch("GET", "/health");
  if (health.ok) {
    report.environment.api = health.json;
    if (health.json?.model && typeof health.json.model === "object") {
      report.environment.model = {
        provider: health.json.model.provider || report.environment.model.provider,
        baseUrl: health.json.model.baseUrl || report.environment.model.baseUrl,
        model: health.json.model.model || report.environment.model.model,
        chatModel: health.json.model.chatModel || report.environment.model.chatModel,
        structuredOutputModel: health.json.model.structuredOutputModel || report.environment.model.structuredOutputModel,
        embeddingModel: health.json.model.embeddingModel ?? report.environment.model.embeddingModel
      };
    }
  } else {
    report.notes.push(`Health check failed during benchmark setup (${health.status}); using local benchmark env metadata.`);
  }

  const scopeId = await createBenchmarkScope(`Benchmark ${Date.now()}`);
  report.metrics.scopeId = scopeId;

  const rng = mulberry32(cfg.seed);
  const fixture = loadFixture(cfg.fixture);
  const goldFacts = loadGoldFacts(fixture);
  if (fixture?.source) {
    report.notes.push(`Using fixture: ${fixture.source}`);
    report.fixture = {
      name: fixture.name,
      description: fixture.description,
      benchmarkFocus: fixture.benchmarkFocus,
      source: fixture.source
    };
    if (fixture.name) report.notes.push(`Fixture name: ${fixture.name}`);
    if (fixture.description) report.notes.push(`Fixture description: ${fixture.description}`);
    if (fixture.benchmarkFocus.length) report.notes.push(`Fixture benchmark focus: ${fixture.benchmarkFocus.join(", ")}`);
    if (fixture.gold) report.notes.push("Fixture includes explicit gold labels.");
  }
  if (cfg.retrieveUseEmbeddings && !modelConfig.embeddingModel) {
    report.notes.push("Embedding rerank was requested for benchmark metadata, but MODEL_EMBEDDING_NAME is not configured.");
  }
  const events = fixture?.events ?? generateEvents(cfg.events, rng);
  report.metrics.ingest = await ingestScopeEvents(scopeId, events, cfg.concurrency);

  const retrieveCases = fixture?.retrieveCases ?? [
    { query: "What did we decide?", expected: "decide", aliases: ["decision", "agreed", "we decide", "we will"] },
    { query: "What constraints exist?", expected: "constraint", aliases: ["limitation", "must", "cannot", "blocked"] },
    { query: "Any blockers?", expected: "blocked", aliases: ["blocker", "constraint", "risk"] },
    { query: "What todos are pending?", expected: "todo", aliases: ["next step", "action item", "pending", "follow up"] }
  ];
  const retrieveLimit = fixture?.retrieveLimit ?? cfg.retrieveLimit;
  const retrieveRuns = Array.from({ length: cfg.retrieveQueries }).map((_, i) => retrieveCases[i % retrieveCases.length]);
  const retrieveMode = health.ok ? deriveRetrieveModeFromHealth(health.json) : buildRetrieveModeConfig();
  const retrieveResults = [];
  for (const item of retrieveRuns) {
    const res = await apiFetch("POST", "/memory/retrieve", { scopeId, query: item.query, limit: retrieveLimit });
    const combined = `${res.json.digest || ""}\n${(res.json.events || []).map((e) => e.content).join("\n")}`.toLowerCase();
    const retrieval = res.json.retrieval ?? {};
    const matches = Array.isArray(retrieval.matches) ? retrieval.matches : [];
    const explainedMatches = matches.filter((match) => typeof match?.rankingReason === "string" && match.rankingReason.trim().length > 0);
    const sourceTypes = [...new Set(matches.map((match) => match?.sourceType).filter(Boolean))];
    retrieveResults.push({
      ok: res.ok,
      latencyMs: res.latencyMs,
      strictHit: combined.includes(item.expected),
      hit: containsAny(combined, [item.expected, ...item.aliases]),
      hasExplainableMatches: matches.length > 0 && explainedMatches.length === matches.length,
      reranked: Boolean(retrieval.reranked),
      embeddingTopMatch: matches.some((match, index) => index === 0 && typeof match?.rankingReason === "string" && match.rankingReason.includes("embedding_rerank")),
      sourceDiversity: sourceTypes.length,
      documentTopMatch: matches[0]?.sourceType === "document"
    });
  }
  const retrieveLatencies = retrieveResults.map((r) => r.latencyMs);
  const retrieveHitRate = retrieveResults.filter((r) => r.hit).length / Math.max(1, retrieveResults.length);
  const retrieveStrictHitRate = retrieveResults.filter((r) => r.strictHit).length / Math.max(1, retrieveResults.length);
  const retrieveExplainabilityRate = retrieveResults.filter((r) => r.hasExplainableMatches).length / Math.max(1, retrieveResults.length);
  const retrieveRerankedRate = retrieveResults.filter((r) => r.reranked).length / Math.max(1, retrieveResults.length);
  const retrieveEmbeddingTopMatchRate = retrieveResults.filter((r) => r.embeddingTopMatch).length / Math.max(1, retrieveResults.length);
  const retrieveDocumentTopMatchRate = retrieveResults.filter((r) => r.documentTopMatch).length / Math.max(1, retrieveResults.length);
  const retrieveSourceDiversityRate = retrieveResults.reduce((sum, r) => sum + Math.min(1, r.sourceDiversity / 2), 0) / Math.max(1, retrieveResults.length);
  report.metrics.retrieve = {
    mode: retrieveMode.mode,
    embeddingRequested: retrieveMode.embeddingRequested,
    embeddingConfigured: retrieveMode.embeddingConfigured,
    embeddingCandidateLimit: retrieveMode.embeddingCandidateLimit,
    embeddingModel: retrieveMode.embeddingModel,
    limit: retrieveLimit,
    total: retrieveResults.length,
    success: retrieveResults.filter((r) => r.ok).length,
    strictHitRate: Number(retrieveStrictHitRate.toFixed(3)),
    hitRate: Number(retrieveHitRate.toFixed(3)),
    explainabilityRate: Number(retrieveExplainabilityRate.toFixed(3)),
    rerankedRate: Number(retrieveRerankedRate.toFixed(3)),
    embeddingTopMatchRate: Number(retrieveEmbeddingTopMatchRate.toFixed(3)),
    documentTopMatchRate: Number(retrieveDocumentTopMatchRate.toFixed(3)),
    sourceDiversityRate: Number(retrieveSourceDiversityRate.toFixed(3)),
    p50Ms: Number(percentile(retrieveLatencies, 50).toFixed(2)),
    p95Ms: Number(percentile(retrieveLatencies, 95).toFixed(2))
  };

  let digestMetrics = {
    enabled: cfg.featureLlm,
    runs: 0,
    success: 0,
    consistencyPassRate: 0,
    repeatabilityRate: 0,
    omissionWarningRate: 0,
    avgLatencyMs: 0,
    failureTaxonomy: {},
    consistencyTaxonomy: { errors: {}, warnings: {} },
    goldRetention: null
  };
  let replayMetrics = {
    enabled: cfg.featureLlm && cfg.includeReplay,
    rebuildRuns: cfg.featureLlm && cfg.includeReplay ? cfg.replayRuns : 0,
    successfulRuns: 0,
    rebuildSnapshots: 0,
    stateMatch: false,
    rebuildConsistencyRate: 0,
    crossRunStateDivergenceRate: 0,
    transitionTaxonomy: {},
    transitionTaxonomyMatchRate: 0,
    crossRunTransitionDivergenceRate: 0,
    matchedCategories: [],
    mismatchedCategories: [],
    crossRunMatchedCategories: [],
    crossRunMismatchedCategories: [],
    diff: null,
    error: null
  };
  let runtimeMetrics = {
    enabled: cfg.featureLlm,
    runs: 0,
    success: 0,
    avgLatencyMs: 0,
    evidenceCoverageRate: 0,
    evidenceDigestSummaryRate: 0,
    evidenceEventSnippetRate: 0,
    evidenceEventRankingReasonRate: 0,
    evidenceEventScoreRate: 0,
    evidenceEventEmbeddingReasonRate: 0,
    evidenceEventDocumentSourceRate: 0,
    evidenceStateSummaryRate: 0,
    evidenceStateProvenanceRate: 0,
    evidenceStateConfidenceRate: 0,
    evidenceRecentStateChangesRate: 0,
    runtimeLayerAlignmentRate: 0,
    runtimeWarningsFreeRate: 0,
    layerStatusAlignmentRate: 0,
    layerStatusWarningsFreeRate: 0,
    layerStatusWorkingMemoryCaughtUpRate: 0,
    layerStatusStableStateCaughtUpRate: 0,
    runtimeLayerStatusConsistencyRate: 0,
    digestTriggerRate: 0,
    writeTierCounts: {},
    noteTaxonomy: {},
    runtimeWarningTaxonomy: {},
    layerStatusWarningTaxonomy: {},
    policyProfile: cfg.runtimePolicyProfile
  };
  let answerMetrics = {
    enabled: cfg.featureLlm,
    runs: 0,
    success: 0,
    avgLatencyMs: 0,
    evidenceCoverageRate: 0,
    evidenceEventSnippetRate: 0,
    evidenceEventRankingReasonRate: 0,
    evidenceEventScoreRate: 0,
    evidenceStateSummaryRate: 0,
    evidenceStateConfidenceRate: 0,
    evidenceStateTransitionTaxonomyRate: 0
  };
  let groundedResponseMetrics = {
    enabled: cfg.featureLlm,
    successRate: 0,
    evidenceCoverageRate: 0,
    rankingReasonRate: 0,
    eventScoreRate: 0,
    stateSummaryRate: 0,
    stateConfidenceRate: 0,
    avgLatencyMs: 0
  };

  if (cfg.featureLlm) {
    const durations = [];
    const consistencyPass = [];
    const successfulDigests = [];
    const failureTaxonomy = {};
    const consistencyTaxonomy = { errors: {}, warnings: {} };
    const goldRetentionRuns = [];
    for (let i = 0; i < cfg.digestRuns; i += 1) {
      const before = await apiFetch("GET", `/memory/digests?scopeId=${scopeId}&limit=5`);
      const beforeCount = (before.json.items || []).length;
      const enqueue = await apiFetch("POST", "/memory/digest", { scopeId });
      if (!enqueue.ok) {
        incrementCounter(failureTaxonomy, `enqueue_failed_${enqueue.status}`);
        continue;
      }
      const t0 = performance.now();
      const waited = await waitForNewDigest(scopeId, beforeCount);
      durations.push(performance.now() - t0);
      if (!waited.ok) {
        incrementCounter(failureTaxonomy, waited.error || "digest_wait_failed");
        continue;
      }
      const digest = waited.digest;
      successfulDigests.push(digest);
      const classified = classifyDigestIssues(digest);
      consistencyPass.push(classified.valid);
      if (!classified.valid) {
        for (const issue of classified.issues) incrementCounter(failureTaxonomy, issue);
      }

      const stateSnapshot = await apiFetch("GET", `/memory/state?scopeId=${scopeId}`);
      if (stateSnapshot.ok && stateSnapshot.json?.consistency) {
        const errors = Array.isArray(stateSnapshot.json.consistency.errors)
          ? stateSnapshot.json.consistency.errors
          : [];
        const warnings = Array.isArray(stateSnapshot.json.consistency.warnings)
          ? stateSnapshot.json.consistency.warnings
          : [];
        for (const error of errors) incrementCounter(consistencyTaxonomy.errors, error);
        for (const warning of warnings) incrementCounter(consistencyTaxonomy.warnings, warning);
      }

      if (goldFacts) {
        const combined = [
          String(digest.summary || ""),
          String(digest.changes || ""),
          ...(Array.isArray(digest.nextSteps) ? digest.nextSteps : [])
        ].join("\n");
        const stateText = stateSnapshot.ok && stateSnapshot.json?.state ? stateToFactText(stateSnapshot.json.state) : "";
        goldRetentionRuns.push({
          recallGoal: factRecall(combined, goldFacts.goal),
          recallConstraints: factRecall(combined, goldFacts.constraints),
          recallDecisions: factRecall(combined, goldFacts.decisions),
          recallTodos: factRecall(combined, goldFacts.todos),
          openQuestionContinuityRate: factRecall(combined, goldFacts.openQuestions),
          riskContinuityRate: factRecall(combined, goldFacts.risks),
          stateGoalRetentionRate: stateText ? factRecall(stateText, goldFacts.goal) : null,
          stateConstraintPreservationRate: stateText ? factRecall(stateText, goldFacts.constraints) : null,
          stateDecisionContinuityRate: stateText ? factRecall(stateText, goldFacts.decisions) : null,
          stateTodoContinuityRate: stateText ? factRecall(stateText, goldFacts.todos) : null,
          stateOpenQuestionContinuityRate: stateSnapshot.ok && stateSnapshot.json?.state
            ? factRecall((stateSnapshot.json.state.workingNotes?.openQuestions ?? []).join("\n"), goldFacts.openQuestions)
            : null,
          stateRiskContinuityRate: stateSnapshot.ok && stateSnapshot.json?.state
            ? factRecall((stateSnapshot.json.state.workingNotes?.risks ?? []).join("\n"), goldFacts.risks)
            : null,
          latestDocumentRetentionRate: factRecall(combined, goldFacts.latestDocumentFacts),
          stateLatestDocumentRetentionRate: stateText ? factRecall(stateText, goldFacts.latestDocumentFacts) : null,
          supersededDocumentIntrusionRate: goldFacts.supersededDocumentFacts.length
            ? Number((countMatches(combined, goldFacts.supersededDocumentFacts) / goldFacts.supersededDocumentFacts.length).toFixed(3))
            : 0,
          stateSupersededDocumentIntrusionRate: stateText && goldFacts.supersededDocumentFacts.length
            ? Number((countMatches(stateText, goldFacts.supersededDocumentFacts) / goldFacts.supersededDocumentFacts.length).toFixed(3))
            : null,
          temporaryTodoIntrusionRate: goldFacts.transientTodos.length
            ? Number((countMatches(combined, goldFacts.transientTodos) / goldFacts.transientTodos.length).toFixed(3))
            : 0,
          resolvedOpenQuestionIntrusionRate: goldFacts.resolvedOpenQuestions.length
            ? Number((countMatches(combined, goldFacts.resolvedOpenQuestions) / goldFacts.resolvedOpenQuestions.length).toFixed(3))
            : 0,
          resolvedRiskIntrusionRate: goldFacts.resolvedRisks.length
            ? Number((countMatches(combined, goldFacts.resolvedRisks) / goldFacts.resolvedRisks.length).toFixed(3))
            : 0,
          stateTemporaryTodoIntrusionRate: stateSnapshot.ok && stateSnapshot.json?.state
            ? stateTodoIntrusionRate(stateSnapshot.json.state, goldFacts.transientTodos)
            : null,
          stateResolvedOpenQuestionIntrusionRate: stateSnapshot.ok && stateSnapshot.json?.state
            ? stateWorkingNoteIntrusionRate(stateSnapshot.json.state.workingNotes?.openQuestions, goldFacts.resolvedOpenQuestions)
            : null,
          stateResolvedRiskIntrusionRate: stateSnapshot.ok && stateSnapshot.json?.state
            ? stateWorkingNoteIntrusionRate(stateSnapshot.json.state.workingNotes?.risks, goldFacts.resolvedRisks)
            : null,
          goalContradictionRate: contradictionRate(combined, goldFacts.contradictions.goal),
          constraintContradictionRate: contradictionRate(combined, goldFacts.contradictions.constraints),
          decisionContradictionRate: contradictionRate(combined, goldFacts.contradictions.decisions),
          todoContradictionRate: contradictionRate(combined, goldFacts.contradictions.todos)
        });
      }
    }
    const goldRetention = goldRetentionRuns.length
      ? {
          recallGoal: Number((goldRetentionRuns.reduce((sum, run) => sum + run.recallGoal, 0) / goldRetentionRuns.length).toFixed(3)),
          recallConstraints: Number((goldRetentionRuns.reduce((sum, run) => sum + run.recallConstraints, 0) / goldRetentionRuns.length).toFixed(3)),
          recallDecisions: Number((goldRetentionRuns.reduce((sum, run) => sum + run.recallDecisions, 0) / goldRetentionRuns.length).toFixed(3)),
          recallTodos: Number((goldRetentionRuns.reduce((sum, run) => sum + run.recallTodos, 0) / goldRetentionRuns.length).toFixed(3)),
          goalRetentionRate: Number((goldRetentionRuns.reduce((sum, run) => sum + run.recallGoal, 0) / goldRetentionRuns.length).toFixed(3)),
          constraintPreservationRate: Number((goldRetentionRuns.reduce((sum, run) => sum + run.recallConstraints, 0) / goldRetentionRuns.length).toFixed(3)),
          decisionContinuityRate: Number((goldRetentionRuns.reduce((sum, run) => sum + run.recallDecisions, 0) / goldRetentionRuns.length).toFixed(3)),
          todoContinuityRate: Number((goldRetentionRuns.reduce((sum, run) => sum + run.recallTodos, 0) / goldRetentionRuns.length).toFixed(3)),
          openQuestionContinuityRate: Number((goldRetentionRuns.reduce((sum, run) => sum + run.openQuestionContinuityRate, 0) / goldRetentionRuns.length).toFixed(3)),
          riskContinuityRate: Number((goldRetentionRuns.reduce((sum, run) => sum + run.riskContinuityRate, 0) / goldRetentionRuns.length).toFixed(3)),
          stateGoalRetentionRate: averageMetric(goldRetentionRuns, "stateGoalRetentionRate"),
          stateConstraintPreservationRate: averageMetric(goldRetentionRuns, "stateConstraintPreservationRate"),
          stateDecisionContinuityRate: averageMetric(goldRetentionRuns, "stateDecisionContinuityRate"),
          stateTodoContinuityRate: averageMetric(goldRetentionRuns, "stateTodoContinuityRate"),
          stateOpenQuestionContinuityRate: averageMetric(goldRetentionRuns, "stateOpenQuestionContinuityRate"),
          stateRiskContinuityRate: averageMetric(goldRetentionRuns, "stateRiskContinuityRate"),
          stateFactRetentionRate: averageMetric(
            goldRetentionRuns.map((run) => ({
              stateFactRetentionRate:
                [
                  run.stateGoalRetentionRate,
                  run.stateConstraintPreservationRate,
                  run.stateDecisionContinuityRate,
                  run.stateTodoContinuityRate,
                  run.stateLatestDocumentRetentionRate
                ]
                  .filter((value) => typeof value === "number")
                  .reduce((sum, value, _, items) => sum + value / items.length, 0)
            })),
            "stateFactRetentionRate"
          ),
          digestDriftRate: aggregateDriftRate(goldRetentionRuns.map((run) =>
            aggregateDriftRate([
              1 - run.recallGoal,
              1 - run.recallConstraints,
              1 - run.recallDecisions,
              1 - run.recallTodos,
              1 - run.latestDocumentRetentionRate,
              run.temporaryTodoIntrusionRate,
              run.supersededDocumentIntrusionRate
            ])
          )),
          stateDriftRate: aggregateDriftRate(goldRetentionRuns.map((run) =>
            aggregateDriftRate([
              typeof run.stateGoalRetentionRate === "number" ? 1 - run.stateGoalRetentionRate : null,
              typeof run.stateConstraintPreservationRate === "number" ? 1 - run.stateConstraintPreservationRate : null,
              typeof run.stateDecisionContinuityRate === "number" ? 1 - run.stateDecisionContinuityRate : null,
              typeof run.stateTodoContinuityRate === "number" ? 1 - run.stateTodoContinuityRate : null,
              typeof run.stateLatestDocumentRetentionRate === "number" ? 1 - run.stateLatestDocumentRetentionRate : null,
              run.stateTemporaryTodoIntrusionRate,
              run.stateSupersededDocumentIntrusionRate
            ])
          )),
          latestDocumentRetentionRate: Number((goldRetentionRuns.reduce((sum, run) => sum + run.latestDocumentRetentionRate, 0) / goldRetentionRuns.length).toFixed(3)),
          stateLatestDocumentRetentionRate: averageMetric(goldRetentionRuns, "stateLatestDocumentRetentionRate"),
          factRetentionRate: Number((
            goldRetentionRuns.reduce((sum, run) => sum + ((run.recallGoal + run.recallConstraints + run.recallDecisions + run.recallTodos + run.latestDocumentRetentionRate) / 5), 0) / goldRetentionRuns.length
          ).toFixed(3)),
          temporaryTodoIntrusionRate: Number((goldRetentionRuns.reduce((sum, run) => sum + run.temporaryTodoIntrusionRate, 0) / goldRetentionRuns.length).toFixed(3)),
          stateTemporaryTodoIntrusionRate: averageMetric(goldRetentionRuns, "stateTemporaryTodoIntrusionRate"),
          resolvedOpenQuestionIntrusionRate: Number((goldRetentionRuns.reduce((sum, run) => sum + run.resolvedOpenQuestionIntrusionRate, 0) / goldRetentionRuns.length).toFixed(3)),
          resolvedRiskIntrusionRate: Number((goldRetentionRuns.reduce((sum, run) => sum + run.resolvedRiskIntrusionRate, 0) / goldRetentionRuns.length).toFixed(3)),
          stateResolvedOpenQuestionIntrusionRate: averageMetric(goldRetentionRuns, "stateResolvedOpenQuestionIntrusionRate"),
          stateResolvedRiskIntrusionRate: averageMetric(goldRetentionRuns, "stateResolvedRiskIntrusionRate"),
          supersededDocumentIntrusionRate: Number((goldRetentionRuns.reduce((sum, run) => sum + run.supersededDocumentIntrusionRate, 0) / goldRetentionRuns.length).toFixed(3)),
          stateSupersededDocumentIntrusionRate: averageMetric(goldRetentionRuns, "stateSupersededDocumentIntrusionRate"),
          goalContradictionRate: Number((goldRetentionRuns.reduce((sum, run) => sum + run.goalContradictionRate, 0) / goldRetentionRuns.length).toFixed(3)),
          constraintContradictionRate: Number((goldRetentionRuns.reduce((sum, run) => sum + run.constraintContradictionRate, 0) / goldRetentionRuns.length).toFixed(3)),
          decisionContradictionRate: Number((goldRetentionRuns.reduce((sum, run) => sum + run.decisionContradictionRate, 0) / goldRetentionRuns.length).toFixed(3)),
          todoContradictionRate: Number((goldRetentionRuns.reduce((sum, run) => sum + run.todoContradictionRate, 0) / goldRetentionRuns.length).toFixed(3))
        }
      : null;
    const materialDigests = successfulDigests.filter(isMaterialDigest);
    const repeatabilityRate = materialDigests.length > 1
      ? Number((
          materialDigests
            .slice(1)
            .filter((digest) => sameCanonicalDigest(materialDigests[0], digest)).length /
          Math.max(1, materialDigests.length - 1)
        ).toFixed(3))
      : materialDigests.length === 1 ? 1 : successfulDigests.length === 1 ? 1 : 0;
    digestMetrics = {
      enabled: true,
      runs: cfg.digestRuns,
      success: durations.length,
      consistencyPassRate: Number((consistencyPass.filter(Boolean).length / Math.max(1, consistencyPass.length)).toFixed(3)),
      repeatabilityRate,
      omissionWarningRate: omissionWarningRate(consistencyTaxonomy),
      avgLatencyMs: Number((durations.reduce((a, b) => a + b, 0) / Math.max(1, durations.length)).toFixed(2)),
      failureTaxonomy,
      consistencyTaxonomy,
      goldRetention
    };
  } else {
    report.notes.push("FEATURE_LLM=false; digest/answer benchmarking skipped.");
  }
  report.metrics.digest = digestMetrics;

  if (cfg.featureLlm && cfg.includeReplay) {
    const replayScopeId = await createBenchmarkScope(`Benchmark Replay ${Date.now()}`);
    report.metrics.replayScopeId = replayScopeId;
    const replayIngest = await ingestScopeEvents(replayScopeId, events, cfg.concurrency);
    if (replayIngest.failure > 0) {
      replayMetrics.error = `replay_ingest_failed:${replayIngest.failure}`;
    } else {
      const baselineDigest = await runBaselineDigest(replayScopeId);
      if (!baselineDigest.ok) {
        replayMetrics.error = baselineDigest.error;
      } else {
      const replayRuns = [];
      for (let i = 0; i < cfg.replayRuns; i += 1) {
        const result = await runReplayRebuild(replayScopeId, baselineDigest.state);
        replayRuns.push({ run: i + 1, ...result });
      }
      const successfulRuns = replayRuns.filter((item) => item.ok);
      if (!successfulRuns.length) {
        replayMetrics.error = replayRuns.find((item) => item.error)?.error || "rebuild_failed";
      } else {
        const matchedCategories = successfulRuns
          .map((item) => item.matchedCategories)
          .reduce((acc, items) => acc.filter((key) => items.includes(key)), successfulRuns[0].matchedCategories || []);
        const mismatchedCategories = [...new Set(successfulRuns.flatMap((item) => item.mismatchedCategories || []))].sort();
        const crossRun = compareReplayRuns(successfulRuns);
        const baselineTransitionTaxonomy = summarizeTransitionTaxonomy(
          baselineDigest.state?.recentChanges,
          baselineDigest.state?.transitionSummary
        );
        replayMetrics = {
          enabled: true,
          rebuildRuns: cfg.replayRuns,
          successfulRuns: successfulRuns.length,
          rebuildSnapshots: successfulRuns.reduce((sum, item) => sum + (item.rebuildSnapshots || 0), 0),
          stateMatch: successfulRuns.every((item) => item.stateMatch),
          rebuildConsistencyRate: Number((successfulRuns.filter((item) => item.stateMatch).length / cfg.replayRuns).toFixed(3)),
          crossRunStateDivergenceRate: crossRun.crossRunStateDivergenceRate,
          transitionTaxonomy: baselineTransitionTaxonomy,
          transitionTaxonomyMatchRate: Number((successfulRuns.filter((item) => item.diff?.transitionTaxonomy?.match).length / cfg.replayRuns).toFixed(3)),
          crossRunTransitionDivergenceRate: crossRun.crossRunTransitionDivergenceRate,
          matchedCategories,
          mismatchedCategories,
          crossRunMatchedCategories: crossRun.crossRunMatchedCategories,
          crossRunMismatchedCategories: crossRun.crossRunMismatchedCategories,
          diff: successfulRuns[successfulRuns.length - 1].diff,
          error: successfulRuns.length === cfg.replayRuns ? null : replayRuns.find((item) => !item.ok)?.error || null
        };
      }
      }
    }
  } else if (!cfg.includeReplay) {
    report.notes.push("Replay check skipped because BENCH_INCLUDE_REPLAY=false.");
  }
  report.metrics.replay = replayMetrics;

  if (cfg.featureLlm) {
    const answerCases = (fixture?.retrieveCases ?? retrieveCases).slice(0, Math.max(1, cfg.runtimeRuns));
    const answerResults = [];
    for (const item of answerCases) {
      const res = await apiFetch("POST", "/memory/answer", {
        scopeId,
        question: item.query
      });
      const evidence = res.json?.evidence ?? {};
      const eventSnippets = Array.isArray(evidence.eventSnippets) ? evidence.eventSnippets : [];
      const snippetsWithRankingReason = eventSnippets.filter((snippet) => typeof snippet?.rankingReason === "string" && snippet.rankingReason.length > 0);
      const snippetsWithScores = eventSnippets.filter((snippet) =>
        typeof snippet?.heuristicScore === "number" &&
        typeof snippet?.recencyScore === "number" &&
        typeof snippet?.finalScore === "number"
      );
      const evidenceCoverage = Boolean(
        (typeof evidence.digestSummary === "string" && evidence.digestSummary.length > 0) ||
        eventSnippets.length > 0 ||
        (typeof evidence.stateSummary === "string" && evidence.stateSummary.length > 0) ||
        Boolean(evidence.stateDetails)
      );
      answerResults.push({
        ok: res.ok && typeof res.json?.answer === "string",
        latencyMs: res.latencyMs,
        evidenceCoverage,
        hasEventSnippets: eventSnippets.length > 0,
        hasEventRankingReasons: eventSnippets.length > 0 && snippetsWithRankingReason.length === eventSnippets.length,
        hasEventScores: eventSnippets.length > 0 && snippetsWithScores.length === eventSnippets.length,
        hasStateSummary: typeof evidence.stateSummary === "string" && evidence.stateSummary.length > 0,
        hasStateConfidence: typeof evidence.stateDetails?.confidence === "object" && Object.values(evidence.stateDetails?.confidence || {}).some((value) => Array.isArray(value) ? value.length > 0 : typeof value === "number"),
        hasStateTransitionTaxonomy: typeof evidence.stateDetails?.transitionTaxonomy === "object" && Object.keys(evidence.stateDetails?.transitionTaxonomy || {}).length > 0
      });
    }
    const answerLatencies = answerResults.map((result) => result.latencyMs);
    answerMetrics = {
      enabled: true,
      runs: answerResults.length,
      success: answerResults.filter((result) => result.ok).length,
      avgLatencyMs: Number((answerLatencies.reduce((sum, value) => sum + value, 0) / Math.max(1, answerLatencies.length)).toFixed(2)),
      evidenceCoverageRate: Number((answerResults.filter((result) => result.evidenceCoverage).length / Math.max(1, answerResults.length)).toFixed(3)),
      evidenceEventSnippetRate: Number((answerResults.filter((result) => result.hasEventSnippets).length / Math.max(1, answerResults.length)).toFixed(3)),
      evidenceEventRankingReasonRate: Number((answerResults.filter((result) => result.hasEventRankingReasons).length / Math.max(1, answerResults.length)).toFixed(3)),
      evidenceEventScoreRate: Number((answerResults.filter((result) => result.hasEventScores).length / Math.max(1, answerResults.length)).toFixed(3)),
      evidenceStateSummaryRate: Number((answerResults.filter((result) => result.hasStateSummary).length / Math.max(1, answerResults.length)).toFixed(3)),
      evidenceStateConfidenceRate: Number((answerResults.filter((result) => result.hasStateConfidence).length / Math.max(1, answerResults.length)).toFixed(3)),
      evidenceStateTransitionTaxonomyRate: Number((answerResults.filter((result) => result.hasStateTransitionTaxonomy).length / Math.max(1, answerResults.length)).toFixed(3))
    };

    const runtimeCases = (fixture?.retrieveCases ?? retrieveCases)
      .slice(0, Math.max(1, cfg.runtimeRuns))
      .map((item, index) => ({
        message: cfg.runtimePromoteLongForm && index === 0
          ? `${item.query}\nLong-form runtime note for profile benchmarking.\nThis text is intentionally extended to exercise documented promotion and runtime evidence handling.`
          : item.query,
        digestMode: index === 0 ? "force" : "skip",
        writeTier: "candidate"
      }));
    const prewarmMessage = runtimeCases[0]?.message || "What is the current architecture goal?";
    const prewarmWorkingState = await apiFetch("GET", `/memory/working-state?scopeId=${scopeId}`);
    const prewarmWorkingVersion = typeof prewarmWorkingState.json?.version === "number" ? prewarmWorkingState.json.version : 0;
    const prewarmStableState = await apiFetch("GET", `/memory/stable-state?scopeId=${scopeId}`);
    const prewarmStableDigestId = typeof prewarmStableState.json?.digestId === "string" ? prewarmStableState.json.digestId : null;
    const prewarmLayerStatus = await apiFetch(
      "GET",
      `/memory/layer-status?scopeId=${encodeURIComponent(scopeId)}&message=${encodeURIComponent(prewarmMessage)}`
    );
    const prewarmFreshness = prewarmLayerStatus.json?.freshness ?? null;
    const needsPrewarm =
      prewarmWorkingVersion === 0 ||
      prewarmFreshness?.workingMemoryCaughtUp !== true ||
      prewarmFreshness?.stableStateCaughtUp !== true;
    if (needsPrewarm) {
      await apiFetch("POST", "/memory/runtime/turn", {
        scopeId,
        message: "status: benchmark prewarm working memory",
        source: "sdk",
        policyProfile: cfg.runtimePolicyProfile,
        writeTier: "stable",
        digestMode: "force"
      });
      await waitForWorkingMemoryVersion(scopeId, prewarmWorkingVersion);
      await waitForStableStateVersion(scopeId, prewarmStableDigestId);
      report.notes.push("Runtime benchmark prewarmed Working Memory and Stable State before measuring layer freshness.");
    }
    const runtimeResults = [];
    for (const item of runtimeCases) {
      const beforeWorkingState = await apiFetch("GET", `/memory/working-state?scopeId=${scopeId}`);
      const beforeStableState = await apiFetch("GET", `/memory/stable-state?scopeId=${scopeId}`);
      const beforeLayerStatus = await apiFetch(
        "GET",
        `/memory/layer-status?scopeId=${encodeURIComponent(scopeId)}&message=${encodeURIComponent(item.message)}`
      );
      const previousWorkingVersion = typeof beforeWorkingState.json?.version === "number" ? beforeWorkingState.json.version : 0;
      const previousStableDigestId = typeof beforeStableState.json?.digestId === "string" ? beforeStableState.json.digestId : null;
      const res = await apiFetch("POST", "/memory/runtime/turn", {
        scopeId,
        message: item.message,
        source: "sdk",
        policyProfile: cfg.runtimePolicyProfile,
        ...(cfg.runtimeRecallLimit || cfg.runtimePromoteLongForm || cfg.runtimeDigestOnCandidate
          ? {
              policyOverrides: {
                ...(cfg.runtimeRecallLimit ? { recallLimit: cfg.runtimeRecallLimit } : {}),
                ...(cfg.runtimePromoteLongForm ? { promoteLongFormToDocumented: true } : {}),
                ...(cfg.runtimeDigestOnCandidate ? { digestOnCandidate: true } : {})
              }
            }
          : {}),
        writeTier: item.writeTier,
        digestMode: item.digestMode
      });
      const evidence = res.json?.evidence ?? {};
      const stateDetails = evidence.stateDetails ?? null;
      const eventSnippets = Array.isArray(evidence.eventSnippets) ? evidence.eventSnippets : [];
      const snippetsWithRankingReason = eventSnippets.filter((snippet) => typeof snippet?.rankingReason === "string" && snippet.rankingReason.length > 0);
      const snippetsWithScores = eventSnippets.filter((snippet) =>
        typeof snippet?.heuristicScore === "number" &&
        typeof snippet?.recencyScore === "number" &&
        typeof snippet?.finalScore === "number"
      );
      const evidenceCoverage = Boolean(
        (typeof evidence.digestSummary === "string" && evidence.digestSummary.length > 0) ||
        eventSnippets.length > 0 ||
        (typeof evidence.stateSummary === "string" && evidence.stateSummary.length > 0) ||
        Boolean(stateDetails)
      );
      const workingMemoryUpdate = (res.ok && typeof res.json?.writeTier === "string" && res.json.writeTier !== "ephemeral")
        ? await waitForWorkingMemoryVersion(scopeId, previousWorkingVersion)
        : { ok: false, latencyMs: 0 };
      const stableStateUpdate = Boolean(res.json?.digestTriggered)
        ? await waitForStableStateVersion(scopeId, previousStableDigestId)
        : { ok: false, latencyMs: 0 };
      const runtimeLayerAlignment = res.json?.layerAlignment ?? null;
      const runtimeWarnings = Array.isArray(res.json?.warnings) ? res.json.warnings : [];
      const layerStatusAlignment = beforeLayerStatus.json?.layerAlignment ?? null;
      const layerStatusWarnings = Array.isArray(beforeLayerStatus.json?.warnings) ? beforeLayerStatus.json.warnings : [];
      const layerStatusFreshness = beforeLayerStatus.json?.freshness ?? null;
      const runtimeRetrievalMode = typeof res.json?.retrievalPlan?.mode === "string" ? res.json.retrievalPlan.mode : null;
      const layerStatusRetrievalMode = typeof beforeLayerStatus.json?.retrievalPlan?.mode === "string" ? beforeLayerStatus.json.retrievalPlan.mode : null;
      runtimeResults.push({
        ok: res.ok && typeof res.json?.answer === "string",
        latencyMs: res.latencyMs,
        fastPathLatencyMs: res.latencyMs,
        workingMemoryUpdateLatencyMs: workingMemoryUpdate.ok ? workingMemoryUpdate.latencyMs : null,
        stableStateUpdateLatencyMs: stableStateUpdate.ok ? stableStateUpdate.latencyMs : null,
        evidenceCoverage,
        hasDigestSummary: typeof evidence.digestSummary === "string" && evidence.digestSummary.length > 0,
        hasEventSnippets: eventSnippets.length > 0,
        hasEventRankingReasons: eventSnippets.length > 0 && snippetsWithRankingReason.length === eventSnippets.length,
        hasEventScores: eventSnippets.length > 0 && snippetsWithScores.length === eventSnippets.length,
        hasEmbeddingReason: snippetsWithRankingReason.some((snippet) => snippet.rankingReason.includes("embedding_rerank")),
        hasDocumentSourceSnippet: eventSnippets.some((snippet) => snippet?.sourceType === "document"),
        hasStateSummary: typeof evidence.stateSummary === "string" && evidence.stateSummary.length > 0,
        hasStateProvenance: Array.isArray(stateDetails?.provenanceFields) && stateDetails.provenanceFields.length > 0,
        hasStateConfidence: typeof stateDetails?.confidence === "object" && Object.values(stateDetails?.confidence || {}).some((value) => Array.isArray(value) ? value.length > 0 : typeof value === "number"),
        hasStateTransitionTaxonomy: typeof stateDetails?.transitionTaxonomy === "object" && Object.keys(stateDetails?.transitionTaxonomy || {}).length > 0,
        hasRecentStateChanges: Array.isArray(stateDetails?.recentChanges) && stateDetails.recentChanges.length > 0,
        digestTriggered: Boolean(res.json?.digestTriggered),
        hasWorkingMemoryVersion: typeof res.json?.workingMemoryVersion === "number" || res.json?.workingMemoryVersion === null,
        hasStableStateVersion: typeof res.json?.stableStateVersion === "string" || res.json?.stableStateVersion === null,
        hasFastLayerContextSummary: typeof res.json?.usedFastLayerContextSummary === "string" && res.json.usedFastLayerContextSummary.length > 0,
        runtimeGoalAligned: runtimeLayerAlignment?.goalAligned === true,
        runtimeWarningsFree: runtimeWarnings.length === 0,
        layerStatusGoalAligned: layerStatusAlignment?.goalAligned === true,
        layerStatusWarningsFree: layerStatusWarnings.length === 0,
        layerStatusWorkingMemoryCaughtUp: layerStatusFreshness?.workingMemoryCaughtUp === true,
        layerStatusStableStateCaughtUp: layerStatusFreshness?.stableStateCaughtUp === true,
        runtimeWarnings,
        layerStatusWarnings,
        runtimeLayerStatusConsistent:
          runtimeLayerAlignment?.goalAligned === layerStatusAlignment?.goalAligned &&
          runtimeWarnings.length === layerStatusWarnings.length &&
          runtimeRetrievalMode === layerStatusRetrievalMode,
        writeTier: typeof res.json?.writeTier === "string" ? res.json.writeTier : "unknown",
        notes: Array.isArray(res.json?.notes) ? res.json.notes : []
      });
    }
    const runtimeLatencies = runtimeResults.map((result) => result.latencyMs);
    const fastPathLatencies = runtimeResults.map((result) => result.fastPathLatencyMs);
    const workingMemoryLatencies = runtimeResults
      .map((result) => result.workingMemoryUpdateLatencyMs)
      .filter((value) => typeof value === "number");
    const stableStateLatencies = runtimeResults
      .map((result) => result.stableStateUpdateLatencyMs)
      .filter((value) => typeof value === "number");
    const writeTierCounts = {};
    const noteTaxonomy = {};
    const runtimeWarningTaxonomy = {};
    const layerStatusWarningTaxonomy = {};
    for (const result of runtimeResults) {
      incrementCounter(writeTierCounts, result.writeTier);
      for (const note of Array.isArray(result.notes) ? result.notes : []) {
        incrementCounter(noteTaxonomy, note);
      }
      for (const warning of Array.isArray(result.runtimeWarnings) ? result.runtimeWarnings : []) {
        incrementCounter(runtimeWarningTaxonomy, warning);
      }
      for (const warning of Array.isArray(result.layerStatusWarnings) ? result.layerStatusWarnings : []) {
        incrementCounter(layerStatusWarningTaxonomy, warning);
      }
    }
    runtimeMetrics = {
      enabled: true,
      runs: runtimeResults.length,
      success: runtimeResults.filter((result) => result.ok).length,
      avgLatencyMs: Number((runtimeLatencies.reduce((sum, value) => sum + value, 0) / Math.max(1, runtimeLatencies.length)).toFixed(2)),
      fastPathAvgLatencyMs: Number((fastPathLatencies.reduce((sum, value) => sum + value, 0) / Math.max(1, fastPathLatencies.length)).toFixed(2)),
      workingMemoryUpdateAvgLatencyMs: Number((workingMemoryLatencies.reduce((sum, value) => sum + value, 0) / Math.max(1, workingMemoryLatencies.length)).toFixed(2)),
      stableStateUpdateAvgLatencyMs: Number((stableStateLatencies.reduce((sum, value) => sum + value, 0) / Math.max(1, stableStateLatencies.length)).toFixed(2)),
      evidenceCoverageRate: Number((runtimeResults.filter((result) => result.evidenceCoverage).length / Math.max(1, runtimeResults.length)).toFixed(3)),
      evidenceDigestSummaryRate: Number((runtimeResults.filter((result) => result.hasDigestSummary).length / Math.max(1, runtimeResults.length)).toFixed(3)),
      evidenceEventSnippetRate: Number((runtimeResults.filter((result) => result.hasEventSnippets).length / Math.max(1, runtimeResults.length)).toFixed(3)),
      evidenceEventRankingReasonRate: Number((runtimeResults.filter((result) => result.hasEventRankingReasons).length / Math.max(1, runtimeResults.length)).toFixed(3)),
      evidenceEventScoreRate: Number((runtimeResults.filter((result) => result.hasEventScores).length / Math.max(1, runtimeResults.length)).toFixed(3)),
      evidenceEventEmbeddingReasonRate: Number((runtimeResults.filter((result) => result.hasEmbeddingReason).length / Math.max(1, runtimeResults.length)).toFixed(3)),
      evidenceEventDocumentSourceRate: Number((runtimeResults.filter((result) => result.hasDocumentSourceSnippet).length / Math.max(1, runtimeResults.length)).toFixed(3)),
      evidenceStateSummaryRate: Number((runtimeResults.filter((result) => result.hasStateSummary).length / Math.max(1, runtimeResults.length)).toFixed(3)),
      evidenceStateProvenanceRate: Number((runtimeResults.filter((result) => result.hasStateProvenance).length / Math.max(1, runtimeResults.length)).toFixed(3)),
      evidenceStateConfidenceRate: Number((runtimeResults.filter((result) => result.hasStateConfidence).length / Math.max(1, runtimeResults.length)).toFixed(3)),
      evidenceStateTransitionTaxonomyRate: Number((runtimeResults.filter((result) => result.hasStateTransitionTaxonomy).length / Math.max(1, runtimeResults.length)).toFixed(3)),
      evidenceRecentStateChangesRate: Number((runtimeResults.filter((result) => result.hasRecentStateChanges).length / Math.max(1, runtimeResults.length)).toFixed(3)),
      workingMemoryVersionRate: Number((runtimeResults.filter((result) => result.hasWorkingMemoryVersion).length / Math.max(1, runtimeResults.length)).toFixed(3)),
      stableStateVersionRate: Number((runtimeResults.filter((result) => result.hasStableStateVersion).length / Math.max(1, runtimeResults.length)).toFixed(3)),
      fastLayerContextSummaryRate: Number((runtimeResults.filter((result) => result.hasFastLayerContextSummary).length / Math.max(1, runtimeResults.length)).toFixed(3)),
      directStateFastPathRate: Number((runtimeResults.filter((result) => (Array.isArray(result.notes) ? result.notes : []).includes("answer:direct_state_fast_path")).length / Math.max(1, runtimeResults.length)).toFixed(3)),
      runtimeLayerAlignmentRate: Number((runtimeResults.filter((result) => result.runtimeGoalAligned).length / Math.max(1, runtimeResults.length)).toFixed(3)),
      runtimeWarningsFreeRate: Number((runtimeResults.filter((result) => result.runtimeWarningsFree).length / Math.max(1, runtimeResults.length)).toFixed(3)),
      layerStatusAlignmentRate: Number((runtimeResults.filter((result) => result.layerStatusGoalAligned).length / Math.max(1, runtimeResults.length)).toFixed(3)),
      layerStatusWarningsFreeRate: Number((runtimeResults.filter((result) => result.layerStatusWarningsFree).length / Math.max(1, runtimeResults.length)).toFixed(3)),
      layerStatusWorkingMemoryCaughtUpRate: Number((runtimeResults.filter((result) => result.layerStatusWorkingMemoryCaughtUp).length / Math.max(1, runtimeResults.length)).toFixed(3)),
      layerStatusStableStateCaughtUpRate: Number((runtimeResults.filter((result) => result.layerStatusStableStateCaughtUp).length / Math.max(1, runtimeResults.length)).toFixed(3)),
      runtimeLayerStatusConsistencyRate: Number((runtimeResults.filter((result) => result.runtimeLayerStatusConsistent).length / Math.max(1, runtimeResults.length)).toFixed(3)),
      digestTriggerRate: Number((runtimeResults.filter((result) => result.digestTriggered).length / Math.max(1, runtimeResults.length)).toFixed(3)),
      writeTierCounts,
      noteTaxonomy,
      runtimeWarningTaxonomy,
      layerStatusWarningTaxonomy,
      policyProfile: cfg.runtimePolicyProfile,
      overrides: {
        recallLimit: cfg.runtimeRecallLimit,
        promoteLongFormToDocumented: cfg.runtimePromoteLongForm,
        digestOnCandidate: cfg.runtimeDigestOnCandidate
      }
    };
  }
  report.metrics.runtime = runtimeMetrics;
  report.metrics.answer = answerMetrics;
  groundedResponseMetrics = cfg.featureLlm
    ? {
        enabled: true,
        successRate: Number((
          (
            (runtimeMetrics.success / Math.max(1, runtimeMetrics.runs)) * 0.6 +
            (answerMetrics.success / Math.max(1, answerMetrics.runs)) * 0.4
          )
        ).toFixed(3)),
        evidenceCoverageRate: Number((((runtimeMetrics.evidenceCoverageRate || 0) * 0.6) + ((answerMetrics.evidenceCoverageRate || 0) * 0.4)).toFixed(3)),
        rankingReasonRate: Number((((runtimeMetrics.evidenceEventRankingReasonRate || 0) * 0.6) + ((answerMetrics.evidenceEventRankingReasonRate || 0) * 0.4)).toFixed(3)),
        eventScoreRate: Number((((runtimeMetrics.evidenceEventScoreRate || 0) * 0.6) + ((answerMetrics.evidenceEventScoreRate || 0) * 0.4)).toFixed(3)),
        stateSummaryRate: Number((((runtimeMetrics.evidenceStateSummaryRate || 0) * 0.6) + ((answerMetrics.evidenceStateSummaryRate || 0) * 0.4)).toFixed(3)),
        stateConfidenceRate: Number((((runtimeMetrics.evidenceStateConfidenceRate || 0) * 0.6) + ((answerMetrics.evidenceStateConfidenceRate || 0) * 0.4)).toFixed(3)),
        stateTransitionTaxonomyRate: Number((((runtimeMetrics.evidenceStateTransitionTaxonomyRate || 0) * 0.6) + ((answerMetrics.evidenceStateTransitionTaxonomyRate || 0) * 0.4)).toFixed(3)),
        avgLatencyMs: Number((((runtimeMetrics.avgLatencyMs || 0) * 0.6) + ((answerMetrics.avgLatencyMs || 0) * 0.4)).toFixed(2))
      }
    : groundedResponseMetrics;
  report.metrics.groundedResponse = groundedResponseMetrics;

  const dueAt = new Date(Date.now() + 20000).toISOString();
  const reminderCreate = await apiFetch("POST", "/reminders", { scopeId, dueAt, text: "Benchmark reminder" });
  let reminderMetrics = {
    success: 0,
    delayMs: cfg.timeoutMs
  };
  if (reminderCreate.ok && reminderCreate.json.id) {
    const waited = await waitForReminderSent(reminderCreate.json.id, dueAt);
    reminderMetrics = {
      success: waited.ok ? 1 : 0,
      delayMs: Number(waited.delayMs.toFixed ? waited.delayMs.toFixed(2) : waited.delayMs)
    };
  }
  report.metrics.reminder = reminderMetrics;

  const ingestScore = scoreIngest(report.metrics.ingest.throughputEventsPerSec, report.metrics.ingest.p95Ms);
  const retrieveScore = scoreRetrieve(report.metrics.retrieve.hitRate, report.metrics.retrieve.p95Ms);
  const digestScore = cfg.featureLlm
    ? scoreDigest(
        report.metrics.digest.success / Math.max(1, report.metrics.digest.runs),
        report.metrics.digest.consistencyPassRate,
        report.metrics.digest.avgLatencyMs
      )
    : 0;
  const reminderScore = scoreReminder(report.metrics.reminder.success, report.metrics.reminder.delayMs);
  const reliabilityBreakdown = buildLongTermMemoryReliabilityBreakdown(report.metrics.digest, report.metrics.replay, report.metrics.runtime, report.metrics.answer);

  report.scores = {
    ingest: Number(ingestScore.toFixed(2)),
    retrieve: Number(retrieveScore.toFixed(2)),
    digest: Number(digestScore.toFixed(2)),
    reliability: reliabilityBreakdown.total,
    reliabilityBreakdown,
    reminder: Number(reminderScore.toFixed(2)),
    overall: Number(computeOverallScore({ ingest: ingestScore, retrieve: retrieveScore, digest: digestScore, reminder: reminderScore }, cfg.featureLlm).toFixed(2))
  };

  const endedAt = msNow();
  report.endedAt = endedAt;

  const outDir = path.join(root, cfg.outputDir);
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(outDir, `benchmark-${stamp}.json`);
  const mdPath = path.join(outDir, `benchmark-${stamp}.md`);

  writeFileSync(jsonPath, JSON.stringify(report, null, 2));

  const md = [
    "# StateCore Benchmark Report",
    "",
    `- Started: ${report.startedAt}`,
    `- Ended: ${report.endedAt}`,
    `- API: ${cfg.apiBaseUrl}`,
    `- Seed: ${cfg.seed}`,
    `- Fixture: ${cfg.fixture || "(none)"}`,
    `- Fixture name: ${report.fixture?.name || "(none)"}`,
    `- Fixture description: ${report.fixture?.description || "(none)"}`,
    `- Fixture focus: ${report.fixture?.benchmarkFocus?.length ? report.fixture.benchmarkFocus.join(", ") : "(none)"}`,
    `- Commit: ${report.commit}`,
    `- Describe: ${report.describe}`,
    `- Node: ${report.environment.node} (${report.environment.platform}/${report.environment.arch})`,
    `- CPU: ${report.environment.cpu} (${report.environment.cores} cores, ${report.environment.memoryGb} GB)` ,
    `- Model provider: ${report.environment.model.provider}, model ${report.environment.model.model}, base ${report.environment.model.baseUrl}`,
    `- Model roles: chat ${report.environment.model.chatModel}, structured ${report.environment.model.structuredOutputModel}, embedding ${report.environment.model.embeddingModel || "disabled"}`,
    "",
    "## Scores",
    "",
    `- Overall: **${report.scores.overall}** / 100`,
    `- Ingest: ${report.scores.ingest}`,
    `- Retrieve: ${report.scores.retrieve}`,
    `- Digest: ${report.scores.digest}${cfg.featureLlm ? "" : " (skipped)"}`,
    `- Long-term Memory Reliability: ${report.scores.reliability}${cfg.featureLlm ? "" : " (skipped)"}`,
    `- Reminder: ${report.scores.reminder}`,
    "",
    "## Reliability Breakdown",
    "",
    `- Consistency: ${report.scores.reliabilityBreakdown?.consistency ?? 0}`,
    `- Retention: ${report.scores.reliabilityBreakdown?.retention ?? 0}`,
    `- Contradiction control: ${report.scores.reliabilityBreakdown?.contradictionControl ?? 0}`,
    `- Replay: ${report.scores.reliabilityBreakdown?.replay ?? 0}`,
    `- Runtime grounding: ${report.scores.reliabilityBreakdown?.runtimeGrounding ?? 0}`,
    "",
    "## Metrics",
    "",
    `- Ingest throughput: ${report.metrics.ingest.throughputEventsPerSec} events/s (p95 ${report.metrics.ingest.p95Ms} ms)`,
    `- Retrieve semantic hit rate: ${report.metrics.retrieve.hitRate}, strict hit rate: ${report.metrics.retrieve.strictHitRate} (p95 ${report.metrics.retrieve.p95Ms} ms)`,
    `- Retrieve mode: ${report.metrics.retrieve.mode}, retrieve limit ${report.metrics.retrieve.limit}, embedding requested ${report.metrics.retrieve.embeddingRequested ? "yes" : "no"}, embedding configured ${report.metrics.retrieve.embeddingConfigured ? "yes" : "no"}, candidate limit ${report.metrics.retrieve.embeddingCandidateLimit}, embedding model ${report.metrics.retrieve.embeddingModel || "none"}`,
    `- Retrieve explainability: ranking reasons ${report.metrics.retrieve.explainabilityRate}, reranked queries ${report.metrics.retrieve.rerankedRate}, embedding top-match ${report.metrics.retrieve.embeddingTopMatchRate}, document top-match ${report.metrics.retrieve.documentTopMatchRate}, source diversity ${report.metrics.retrieve.sourceDiversityRate}`,
    `- Grounded response view: success ${report.metrics.groundedResponse.enabled ? report.metrics.groundedResponse.successRate : "n/a"}, evidence coverage ${report.metrics.groundedResponse.enabled ? report.metrics.groundedResponse.evidenceCoverageRate : "n/a"}, ranking reasons ${report.metrics.groundedResponse.enabled ? report.metrics.groundedResponse.rankingReasonRate : "n/a"}, event scores ${report.metrics.groundedResponse.enabled ? report.metrics.groundedResponse.eventScoreRate : "n/a"}, state summary ${report.metrics.groundedResponse.enabled ? report.metrics.groundedResponse.stateSummaryRate : "n/a"}, state confidence ${report.metrics.groundedResponse.enabled ? report.metrics.groundedResponse.stateConfidenceRate : "n/a"}, state transition taxonomy ${report.metrics.groundedResponse.enabled ? report.metrics.groundedResponse.stateTransitionTaxonomyRate : "n/a"}, avg latency ${report.metrics.groundedResponse.enabled ? `${report.metrics.groundedResponse.avgLatencyMs} ms` : "n/a"}`,
    `- Answer grounding: success ${report.metrics.answer.enabled ? `${report.metrics.answer.success}/${report.metrics.answer.runs}` : "skipped"}, evidence coverage ${report.metrics.answer.enabled ? report.metrics.answer.evidenceCoverageRate : "n/a"}, ranking reasons ${report.metrics.answer.enabled ? report.metrics.answer.evidenceEventRankingReasonRate : "n/a"}, event scores ${report.metrics.answer.enabled ? report.metrics.answer.evidenceEventScoreRate : "n/a"}, state summary ${report.metrics.answer.enabled ? report.metrics.answer.evidenceStateSummaryRate : "n/a"}, state confidence ${report.metrics.answer.enabled ? report.metrics.answer.evidenceStateConfidenceRate : "n/a"}, avg latency ${report.metrics.answer.enabled ? `${report.metrics.answer.avgLatencyMs} ms` : "n/a"}`,
    `- Digest success: ${report.metrics.digest.success}/${report.metrics.digest.runs}, consistency pass ${report.metrics.digest.consistencyPassRate}, repeatability ${report.metrics.digest.repeatabilityRate ?? 0}, omission warning rate ${report.metrics.digest.omissionWarningRate ?? 0}, avg latency ${report.metrics.digest.avgLatencyMs} ms`,
    `- Replay state match: ${report.metrics.replay.enabled ? (report.metrics.replay.successfulRuns ? (report.metrics.replay.stateMatch ? "yes" : "no") : `error (${report.metrics.replay.error})`) : "skipped"}${report.metrics.replay.enabled && report.metrics.replay.successfulRuns ? `, successful rebuilds ${report.metrics.replay.successfulRuns}/${report.metrics.replay.rebuildRuns}, snapshots ${report.metrics.replay.rebuildSnapshots}` : ""}`,
    `- Runtime turn success: ${report.metrics.runtime.enabled ? `${report.metrics.runtime.success}/${report.metrics.runtime.runs}` : "skipped"}, evidence coverage ${report.metrics.runtime.enabled ? report.metrics.runtime.evidenceCoverageRate : "n/a"}, avg latency ${report.metrics.runtime.enabled ? `${report.metrics.runtime.avgLatencyMs} ms` : "n/a"}`,
    `- Runtime layer timings: fast path ${report.metrics.runtime.enabled ? `${report.metrics.runtime.fastPathAvgLatencyMs} ms` : "n/a"}, working memory update ${report.metrics.runtime.enabled ? `${report.metrics.runtime.workingMemoryUpdateAvgLatencyMs} ms` : "n/a"}, stable-state update ${report.metrics.runtime.enabled ? `${report.metrics.runtime.stableStateUpdateAvgLatencyMs} ms` : "n/a"}`,
    `- Runtime layer metadata: working-memory version rate ${report.metrics.runtime.enabled ? report.metrics.runtime.workingMemoryVersionRate : "n/a"}, stable-state version rate ${report.metrics.runtime.enabled ? report.metrics.runtime.stableStateVersionRate : "n/a"}, fast-layer summary rate ${report.metrics.runtime.enabled ? report.metrics.runtime.fastLayerContextSummaryRate : "n/a"}, direct-state fast-path rate ${report.metrics.runtime.enabled ? report.metrics.runtime.directStateFastPathRate : "n/a"}`,
    `- Runtime layer diagnostics: runtime goal-alignment rate ${report.metrics.runtime.enabled ? report.metrics.runtime.runtimeLayerAlignmentRate : "n/a"}, runtime warnings-free rate ${report.metrics.runtime.enabled ? report.metrics.runtime.runtimeWarningsFreeRate : "n/a"}, layer-status goal-alignment rate ${report.metrics.runtime.enabled ? report.metrics.runtime.layerStatusAlignmentRate : "n/a"}, layer-status warnings-free rate ${report.metrics.runtime.enabled ? report.metrics.runtime.layerStatusWarningsFreeRate : "n/a"}, working-memory caught-up rate ${report.metrics.runtime.enabled ? report.metrics.runtime.layerStatusWorkingMemoryCaughtUpRate : "n/a"}, stable-state caught-up rate ${report.metrics.runtime.enabled ? report.metrics.runtime.layerStatusStableStateCaughtUpRate : "n/a"}, runtime/layer-status consistency rate ${report.metrics.runtime.enabled ? report.metrics.runtime.runtimeLayerStatusConsistencyRate : "n/a"}`,
    `- Reminder sent: ${report.metrics.reminder.success === 1 ? "yes" : "no"}, delay ${report.metrics.reminder.delayMs} ms`,
    ...(report.metrics.digest.goldRetention
        ? [
          `- Digest gold recall: goal ${report.metrics.digest.goldRetention.recallGoal}, constraints ${report.metrics.digest.goldRetention.recallConstraints}, decisions ${report.metrics.digest.goldRetention.recallDecisions}, todos ${report.metrics.digest.goldRetention.recallTodos}`,
          `- Retention metrics: fact ${report.metrics.digest.goldRetention.factRetentionRate}, goal ${report.metrics.digest.goldRetention.goalRetentionRate}, constraints ${report.metrics.digest.goldRetention.constraintPreservationRate}, decisions ${report.metrics.digest.goldRetention.decisionContinuityRate}, todos ${report.metrics.digest.goldRetention.todoContinuityRate}`,
          `- Working-note continuity: open-questions ${report.metrics.digest.goldRetention.openQuestionContinuityRate ?? "n/a"}, risks ${report.metrics.digest.goldRetention.riskContinuityRate ?? "n/a"}, state open-questions ${report.metrics.digest.goldRetention.stateOpenQuestionContinuityRate ?? "n/a"}, state risks ${report.metrics.digest.goldRetention.stateRiskContinuityRate ?? "n/a"}`,
          `- Latest document retention rate: digest ${report.metrics.digest.goldRetention.latestDocumentRetentionRate ?? "n/a"}, state ${report.metrics.digest.goldRetention.stateLatestDocumentRetentionRate ?? "n/a"}`,
          `- State retention metrics: fact ${report.metrics.digest.goldRetention.stateFactRetentionRate ?? "n/a"}, goal ${report.metrics.digest.goldRetention.stateGoalRetentionRate ?? "n/a"}, constraints ${report.metrics.digest.goldRetention.stateConstraintPreservationRate ?? "n/a"}, decisions ${report.metrics.digest.goldRetention.stateDecisionContinuityRate ?? "n/a"}, todos ${report.metrics.digest.goldRetention.stateTodoContinuityRate ?? "n/a"}`,
          `- Drift rates: digest ${report.metrics.digest.goldRetention.digestDriftRate ?? "n/a"}, state ${report.metrics.digest.goldRetention.stateDriftRate ?? "n/a"}`,
          `- Digest contradiction rates: goal ${report.metrics.digest.goldRetention.goalContradictionRate}, constraints ${report.metrics.digest.goldRetention.constraintContradictionRate}, decisions ${report.metrics.digest.goldRetention.decisionContradictionRate}, todos ${report.metrics.digest.goldRetention.todoContradictionRate}`,
          `- Intrusion rates: temporary todos digest ${report.metrics.digest.goldRetention.temporaryTodoIntrusionRate ?? 0}, temporary todos state ${report.metrics.digest.goldRetention.stateTemporaryTodoIntrusionRate ?? "n/a"}, resolved open-questions digest ${report.metrics.digest.goldRetention.resolvedOpenQuestionIntrusionRate ?? 0}, resolved open-questions state ${report.metrics.digest.goldRetention.stateResolvedOpenQuestionIntrusionRate ?? "n/a"}, resolved risks digest ${report.metrics.digest.goldRetention.resolvedRiskIntrusionRate ?? 0}, resolved risks state ${report.metrics.digest.goldRetention.stateResolvedRiskIntrusionRate ?? "n/a"}, superseded docs digest ${report.metrics.digest.goldRetention.supersededDocumentIntrusionRate ?? 0}, superseded docs state ${report.metrics.digest.goldRetention.stateSupersededDocumentIntrusionRate ?? "n/a"}`
        ]
      : []),
    "",
    "## Digest Failure Taxonomy",
    ...(cfg.featureLlm
      ? Object.keys(report.metrics.digest.failureTaxonomy || {}).length
        ? Object.entries(report.metrics.digest.failureTaxonomy)
          .sort((a, b) => b[1] - a[1])
          .map(([name, count]) => `- ${name}: ${count}`)
        : ["- none"]
      : ["- skipped"]),
    "",
    "## Digest Consistency Taxonomy",
    ...(cfg.featureLlm
      ? [
          "- Errors:",
          ...(Object.keys(report.metrics.digest.consistencyTaxonomy?.errors || {}).length
            ? Object.entries(report.metrics.digest.consistencyTaxonomy.errors)
              .sort((a, b) => b[1] - a[1])
              .map(([name, count]) => `  - ${name}: ${count}`)
            : ["  - none"]),
          "- Warnings:",
          ...(Object.keys(report.metrics.digest.consistencyTaxonomy?.warnings || {}).length
            ? Object.entries(report.metrics.digest.consistencyTaxonomy.warnings)
              .sort((a, b) => b[1] - a[1])
              .map(([name, count]) => `  - ${name}: ${count}`)
            : ["  - none"])
        ]
      : ["- skipped"]),
    "",
    "## Assistant Runtime",
    ...(report.metrics.runtime.enabled
      ? [
          `- Success: ${report.metrics.runtime.success}/${report.metrics.runtime.runs}`,
          `- Policy profile: ${report.metrics.runtime.policyProfile}`,
          `- Overrides: recallLimit=${report.metrics.runtime.overrides?.recallLimit ?? "default"}, promoteLongForm=${report.metrics.runtime.overrides?.promoteLongFormToDocumented ? "yes" : "no"}, digestOnCandidate=${report.metrics.runtime.overrides?.digestOnCandidate ? "yes" : "no"}`,
          `- Avg latency: ${report.metrics.runtime.avgLatencyMs} ms`,
          `- Evidence coverage rate: ${report.metrics.runtime.evidenceCoverageRate}`,
          `- Evidence digest summary rate: ${report.metrics.runtime.evidenceDigestSummaryRate}`,
          `- Evidence event snippet rate: ${report.metrics.runtime.evidenceEventSnippetRate}`,
          `- Evidence event ranking-reason rate: ${report.metrics.runtime.evidenceEventRankingReasonRate ?? 0}`,
          `- Evidence event score rate: ${report.metrics.runtime.evidenceEventScoreRate ?? 0}`,
          `- Evidence event embedding-reason rate: ${report.metrics.runtime.evidenceEventEmbeddingReasonRate ?? 0}`,
          `- Evidence event document-source rate: ${report.metrics.runtime.evidenceEventDocumentSourceRate ?? 0}`,
          `- Evidence state summary rate: ${report.metrics.runtime.evidenceStateSummaryRate}`,
          `- Evidence state provenance rate: ${report.metrics.runtime.evidenceStateProvenanceRate ?? 0}`,
          `- Evidence state confidence rate: ${report.metrics.runtime.evidenceStateConfidenceRate ?? 0}`,
          `- Evidence state transition-taxonomy rate: ${report.metrics.runtime.evidenceStateTransitionTaxonomyRate ?? 0}`,
          `- Evidence recent state changes rate: ${report.metrics.runtime.evidenceRecentStateChangesRate ?? 0}`,
          `- Direct-state fast-path rate: ${report.metrics.runtime.directStateFastPathRate ?? 0}`,
          `- Runtime goal-alignment rate: ${report.metrics.runtime.runtimeLayerAlignmentRate ?? 0}`,
          `- Runtime warnings-free rate: ${report.metrics.runtime.runtimeWarningsFreeRate ?? 0}`,
          `- Layer-status goal-alignment rate: ${report.metrics.runtime.layerStatusAlignmentRate ?? 0}`,
          `- Layer-status warnings-free rate: ${report.metrics.runtime.layerStatusWarningsFreeRate ?? 0}`,
          `- Layer-status working-memory caught-up rate: ${report.metrics.runtime.layerStatusWorkingMemoryCaughtUpRate ?? 0}`,
          `- Layer-status stable-state caught-up rate: ${report.metrics.runtime.layerStatusStableStateCaughtUpRate ?? 0}`,
          `- Runtime/layer-status consistency rate: ${report.metrics.runtime.runtimeLayerStatusConsistencyRate ?? 0}`,
          `- Digest trigger rate: ${report.metrics.runtime.digestTriggerRate}`,
          `- Write tiers: ${Object.keys(report.metrics.runtime.writeTierCounts || {}).length ? Object.entries(report.metrics.runtime.writeTierCounts).map(([name, count]) => `${name}=${count}`).join(", ") : "none"}`,
          `- Note taxonomy: ${Object.keys(report.metrics.runtime.noteTaxonomy || {}).length ? Object.entries(report.metrics.runtime.noteTaxonomy).sort((a, b) => b[1] - a[1]).map(([name, count]) => `${name}=${count}`).join(", ") : "none"}`,
          `- Runtime warning taxonomy: ${Object.keys(report.metrics.runtime.runtimeWarningTaxonomy || {}).length ? Object.entries(report.metrics.runtime.runtimeWarningTaxonomy).sort((a, b) => b[1] - a[1]).map(([name, count]) => `${name}=${count}`).join(", ") : "none"}`,
          `- Layer-status warning taxonomy: ${Object.keys(report.metrics.runtime.layerStatusWarningTaxonomy || {}).length ? Object.entries(report.metrics.runtime.layerStatusWarningTaxonomy).sort((a, b) => b[1] - a[1]).map(([name, count]) => `${name}=${count}`).join(", ") : "none"}`
        ]
      : ["- skipped"]),
    "",
    "## Grounded Response",
    ...(report.metrics.groundedResponse.enabled
      ? [
          `- Success rate: ${report.metrics.groundedResponse.successRate}`,
          `- Avg latency: ${report.metrics.groundedResponse.avgLatencyMs} ms`,
          `- Evidence coverage rate: ${report.metrics.groundedResponse.evidenceCoverageRate}`,
          `- Ranking-reason rate: ${report.metrics.groundedResponse.rankingReasonRate}`,
          `- Event score rate: ${report.metrics.groundedResponse.eventScoreRate}`,
          `- State summary rate: ${report.metrics.groundedResponse.stateSummaryRate}`,
          `- State confidence rate: ${report.metrics.groundedResponse.stateConfidenceRate ?? 0}`,
          `- State transition-taxonomy rate: ${report.metrics.groundedResponse.stateTransitionTaxonomyRate ?? 0}`
        ]
      : ["- skipped"]),
    "",
    "## Answer Grounding",
    ...(report.metrics.answer.enabled
      ? [
          `- Success: ${report.metrics.answer.success}/${report.metrics.answer.runs}`,
          `- Avg latency: ${report.metrics.answer.avgLatencyMs} ms`,
          `- Evidence coverage rate: ${report.metrics.answer.evidenceCoverageRate}`,
          `- Evidence event snippet rate: ${report.metrics.answer.evidenceEventSnippetRate}`,
          `- Evidence event ranking-reason rate: ${report.metrics.answer.evidenceEventRankingReasonRate}`,
          `- Evidence event score rate: ${report.metrics.answer.evidenceEventScoreRate}`,
          `- Evidence state summary rate: ${report.metrics.answer.evidenceStateSummaryRate}`,
          `- Evidence state confidence rate: ${report.metrics.answer.evidenceStateConfidenceRate ?? 0}`,
          `- Evidence state transition-taxonomy rate: ${report.metrics.answer.evidenceStateTransitionTaxonomyRate ?? 0}`
        ]
      : ["- skipped"]),
    "",
    "## Replay Consistency",
    ...(report.metrics.replay.enabled
      ? report.metrics.replay.successfulRuns
        ? [
            `- State match: ${report.metrics.replay.stateMatch ? "yes" : "no"}`,
            `- Rebuild consistency rate: ${report.metrics.replay.rebuildConsistencyRate}`,
            `- Cross-run state divergence rate: ${report.metrics.replay.crossRunStateDivergenceRate}`,
            `- Transition taxonomy match rate: ${report.metrics.replay.transitionTaxonomyMatchRate ?? 0}`,
            `- Cross-run transition divergence rate: ${report.metrics.replay.crossRunTransitionDivergenceRate ?? 0}`,
            `- Replay stability blend: ${Number((((1 - (report.metrics.replay.crossRunStateDivergenceRate ?? 0)) * 0.5) + ((report.metrics.replay.transitionTaxonomyMatchRate ?? 0) * 0.25) + ((1 - (report.metrics.replay.crossRunTransitionDivergenceRate ?? 0)) * 0.25)).toFixed(3))}`,
            `- Successful rebuilds: ${report.metrics.replay.successfulRuns}/${report.metrics.replay.rebuildRuns}`,
            `- Rebuild snapshots: ${report.metrics.replay.rebuildSnapshots}`,
            `- Baseline transition taxonomy: ${Object.keys(report.metrics.replay.transitionTaxonomy || {}).length ? Object.entries(report.metrics.replay.transitionTaxonomy).map(([key, count]) => `${key}=${count}`).join(", ") : "none"}`,
            `- Matched categories: ${report.metrics.replay.matchedCategories.length ? report.metrics.replay.matchedCategories.join(", ") : "none"}`,
            `- Mismatched categories: ${report.metrics.replay.mismatchedCategories.length ? report.metrics.replay.mismatchedCategories.join(", ") : "none"}`,
            `- Cross-run matched categories: ${report.metrics.replay.crossRunMatchedCategories.length ? report.metrics.replay.crossRunMatchedCategories.join(", ") : "none"}`,
            `- Cross-run mismatched categories: ${report.metrics.replay.crossRunMismatchedCategories.length ? report.metrics.replay.crossRunMismatchedCategories.join(", ") : "none"}`,
            ...Object.entries(report.metrics.replay.diff || {}).flatMap(([key, value]) => {
              const lines = [`- ${key}: ${value.match ? "match" : "mismatch"}`];
              if ("missingFromReplay" in value) {
                lines.push(`  missing=${value.missingFromReplay.length ? value.missingFromReplay.join(" | ") : "none"}`);
                lines.push(`  added=${value.addedInReplay.length ? value.addedInReplay.join(" | ") : "none"}`);
              } else if ("mismatchedKeys" in value) {
                lines.push(`  matched=${value.matchedKeys.length ? value.matchedKeys.join(" | ") : "none"}`);
                lines.push(`  mismatched=${value.mismatchedKeys.length ? value.mismatchedKeys.join(" | ") : "none"}`);
                lines.push(`  baseline=${Object.keys(value.baseline || {}).length ? Object.entries(value.baseline).map(([name, count]) => `${name}=${count}`).join(" | ") : "none"}`);
                lines.push(`  rebuilt=${Object.keys(value.rebuilt || {}).length ? Object.entries(value.rebuilt).map(([name, count]) => `${name}=${count}`).join(" | ") : "none"}`);
              } else {
                lines.push(`  baseline=${value.baseline ?? "null"}`);
                lines.push(`  rebuilt=${value.rebuilt ?? "null"}`);
              }
              return lines;
            })
          ]
        : [`- Error: ${report.metrics.replay.error}`]
      : ["- skipped"]),
    "",
    "## Notes",
    ...(report.notes.length ? report.notes.map((note) => `- ${note}`) : ["- none"]),
    "",
    `JSON source: ${path.basename(jsonPath)}`
  ].join("\n");

  writeFileSync(mdPath, md);

  // eslint-disable-next-line no-console
  console.log(`Benchmark complete. Overall score: ${report.scores.overall}/100`);
  // eslint-disable-next-line no-console
  console.log(`Report: ${jsonPath}`);
  // eslint-disable-next-line no-console
  console.log(`Report: ${mdPath}`);
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Benchmark failed:", err.message || err);
  process.exit(1);
});
