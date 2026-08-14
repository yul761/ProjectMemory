import {
  createModelProvider,
  resolveFacetPackForScope,
  buildFacetPromptSection,
  runDigestControlPipeline,
  type Digest,
  type DigestState,
  type FacetPackStore
} from "@statecore/core";
import {
  digestClassifySystemPrompt,
  digestClassifyUserPrompt,
  buildDigestStage2SystemPrompt,
  digestStage2UserPrompt,
  consolidateFacetSystemPrompt,
  consolidateFacetUserPrompt
} from "@statecore/prompts";
import type { LitePrisma } from "./store";
import { acquireDigestLock, releaseDigestLock } from "./digest-lock";
import { selectDigestEventWindow } from "./digest-lookback";
import { createDigestWithSnapshot } from "./digest-write";

export { acquireDigestLock, releaseDigestLock };

/**
 * Fixed digest-pipeline tuning. Copied from apps/worker/src/env.ts's
 * `DIGEST_*` defaults — the embedded backend has no deployment operator to
 * expose these to, so they are constants rather than env-configurable knobs.
 * Only the trigger threshold (below) varies per install.
 */
const DIGEST_CONFIG = {
  maxRecentEvents: 50, // DIGEST_MAX_RECENT_EVENTS
  firstRunMaxEvents: 200, // DIGEST_FIRST_RUN_MAX_EVENTS
  maxDaysLookback: 14, // DIGEST_MAX_DAYS_LOOKBACK
  eventBudgetTotal: 40, // DIGEST_EVENT_BUDGET_TOTAL
  charBudgetTotal: 240_000, // DIGEST_CHAR_BUDGET_TOTAL
  eventBudgetDocs: 10, // DIGEST_EVENT_BUDGET_DOCS
  eventBudgetStream: 30, // DIGEST_EVENT_BUDGET_STREAM
  noveltyThreshold: 0.15, // DIGEST_NOVELTY_THRESHOLD
  maxRetries: 1, // DIGEST_MAX_RETRIES
  useLlmClassifier: false, // DIGEST_USE_LLM_CLASSIFIER
  debug: false // DIGEST_DEBUG
} as const;

const DEFAULT_THRESHOLD = 20;

/** Pure trigger check: fires once `pendingCount` reaches `threshold`. */
export function shouldDigest(pendingCount: number, threshold: number): boolean {
  return pendingCount >= threshold;
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

interface DigestEnvConfig {
  featureLlm: boolean;
  threshold: number;
  provider: string;
  apiKey: string;
  baseUrl: string;
  modelName: string;
  structuredOutputApiKey?: string;
  structuredOutputBaseUrl?: string;
  structuredOutputModelName?: string;
  timeoutMs: number;
}

/**
 * Small local reader for the env fields the digest path needs. Mirrors
 * apps/worker/src/env.ts's MODEL_ and FEATURE_LLM semantics, but the embedded
 * backend is a single in-process backend, not a queue worker, so it skips
 * everything worker/env.ts also parses for BullMQ/Telegram/working-memory
 * that this path never reads.
 */
function readDigestEnv(env: NodeJS.ProcessEnv): DigestEnvConfig {
  const baseUrl = clean(env.MODEL_BASE_URL) || clean(env.OPENAI_BASE_URL) || "https://api.openai.com/v1";
  const modelName = clean(env.MODEL_NAME) || clean(env.OPENAI_MODEL) || "gpt-4o-mini";
  const apiKey = clean(env.MODEL_API_KEY) || clean(env.OPENAI_API_KEY) || "";
  return {
    featureLlm: env.FEATURE_LLM === "true",
    threshold: Number(env.STATECORE_DIGEST_THRESHOLD || DEFAULT_THRESHOLD),
    provider: clean(env.MODEL_PROVIDER) || "openai-compatible",
    apiKey,
    baseUrl,
    modelName,
    structuredOutputApiKey: clean(env.MODEL_STRUCTURED_OUTPUT_API_KEY),
    structuredOutputBaseUrl: clean(env.MODEL_STRUCTURED_OUTPUT_BASE_URL),
    structuredOutputModelName: clean(env.MODEL_STRUCTURED_OUTPUT_NAME),
    timeoutMs: Number(env.MODEL_TIMEOUT_MS || 20000)
  };
}

function makeFacetPackStore(prisma: LitePrisma): FacetPackStore {
  return {
    findFacetPack: async (userId) => (await prisma.user.findUnique({ where: { id: userId }, select: { facetPack: true } }))?.facetPack ?? null
  };
}

type DigestRow = {
  id: string;
  scopeId: string;
  summary: string;
  changes: string;
  nextSteps: unknown;
  createdAt: Date;
  rebuildGroupId?: string | null;
};

// Local equivalent of apps/worker/src/main.ts#toCoreDigest; converts a raw
// digest row into the shape runDigestControlPipeline requires.
function toCoreDigest(row: DigestRow): Digest {
  return {
    id: row.id,
    scopeId: row.scopeId,
    summary: row.summary,
    changes: row.changes,
    nextSteps: Array.isArray(row.nextSteps) ? (row.nextSteps as string[]) : [],
    createdAt: row.createdAt,
    rebuildGroupId: row.rebuildGroupId ?? null
  };
}

/**
 * Runs the digest pipeline for one scope: resolve the tenant's facet pack,
 * select the lookback event window, run stage 1/2 + consolidation, and
 * persist the result. Mirrors apps/worker/src/main.ts#runDigestScopeJob minus
 * Telegram delivery, working-memory refresh, BullMQ job logging, and drift
 * metrics — none of which the embedded backend has anywhere to send.
 */
async function runDigestPipeline(prisma: LitePrisma, userId: string, scopeId: string, digestEnv: DigestEnvConfig): Promise<void> {
  const provider = createModelProvider({
    provider: digestEnv.provider,
    apiKey: digestEnv.apiKey,
    baseUrl: digestEnv.baseUrl,
    model: digestEnv.modelName,
    structuredOutputApiKey: digestEnv.structuredOutputApiKey,
    structuredOutputBaseUrl: digestEnv.structuredOutputBaseUrl,
    structuredOutputModel: digestEnv.structuredOutputModelName,
    timeoutMs: digestEnv.timeoutMs
  });
  if (!provider) {
    console.error("[statecore-mcp] digest: model provider unavailable despite FEATURE_LLM=true; skipping");
    return;
  }
  const llm = { chat: (messages: { role: "system" | "user"; content: string }[]) => provider.structuredOutput.chat(messages) };

  const scope = await prisma.projectScope.findFirst({ where: { id: scopeId, userId } });
  if (!scope) {
    console.error(`[statecore-mcp] digest: scope ${scopeId} not found for user ${userId}; skipping`);
    return;
  }
  const facetPack = await resolveFacetPackForScope(makeFacetPackStore(prisma), userId, scope.template);

  const lastDigestRow = await prisma.digest.findFirst({
    where: { scopeId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }]
  });
  const lastStateRow = await prisma.digestStateSnapshot.findFirst({
    where: { scopeId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }]
  });

  const lookbackWindow = selectDigestEventWindow({ scopeId, lookbackDays: DIGEST_CONFIG.maxDaysLookback });
  const recentStreamEvents = await prisma.memoryEvent.findMany({
    where: { ...lookbackWindow, type: "stream" },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: lastDigestRow ? DIGEST_CONFIG.maxRecentEvents : DIGEST_CONFIG.firstRunMaxEvents
  });
  const recentDocumentEvents = await prisma.memoryEvent.findMany({
    where: { ...lookbackWindow, type: "document" },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }]
  });
  const recentEvents = [...recentStreamEvents, ...recentDocumentEvents];

  const prevDigestState = (lastStateRow?.state as unknown as DigestState) ?? null;

  const forgottenRows = await prisma.forgottenFact.findMany({
    where: { scopeId },
    orderBy: { forgottenAt: "desc" },
    take: 100,
    select: { factKey: true, contentSnapshot: true }
  });
  const forgottenFactKeys = new Set(forgottenRows.map((f) => f.factKey));
  const forgottenFactContents = forgottenRows.map((f) => (f.contentSnapshot ?? "").trim()).filter(Boolean);

  const result = await runDigestControlPipeline({
    scope,
    lastDigest: lastDigestRow ? toCoreDigest(lastDigestRow) : null,
    prevState: prevDigestState,
    recentEvents,
    llm,
    prompts: {
      digestStage2SystemPrompt: buildDigestStage2SystemPrompt(buildFacetPromptSection(facetPack)),
      digestStage2UserPrompt,
      digestClassifySystemPrompt,
      digestClassifyUserPrompt,
      consolidateFacetSystemPrompt,
      consolidateFacetUserPrompt
    },
    pack: facetPack,
    config: {
      eventBudgetTotal: DIGEST_CONFIG.eventBudgetTotal,
      eventBudgetDocs: DIGEST_CONFIG.eventBudgetDocs,
      eventBudgetStream: DIGEST_CONFIG.eventBudgetStream,
      charBudgetTotal: DIGEST_CONFIG.charBudgetTotal,
      noveltyThreshold: DIGEST_CONFIG.noveltyThreshold,
      maxRetries: DIGEST_CONFIG.maxRetries,
      useLlmClassifier: DIGEST_CONFIG.useLlmClassifier,
      debug: DIGEST_CONFIG.debug
    },
    forgottenFactKeys,
    forgottenFactContents
  });

  await createDigestWithSnapshot(prisma, {
    scopeId,
    summary: result.digest.summary,
    changes: result.digest.changes.map((c) => `- ${c}`).join("\n"),
    nextSteps: result.digest.nextSteps,
    state: result.state,
    consistency: result.consistency,
    selectionLog: { rationale: result.selection.rationale, drops: result.dropLog }
  });
}

// In-process single-flight guard: a second call for a scope this process is
// already digesting bails before touching the DigestLock table at all. The
// lock table (digest-lock.ts) is the cross-process guarantee; this is the
// cheap same-process fast path in front of it.
let running = false;

/**
 * Digest trigger: threshold-based on new stream events, plus a startup
 * catch-up (threshold of 1 — any backlog is worth digesting once). No-ops
 * gracefully whenever the LLM isn't configured, so keyless embedded callers
 * never pay for a lock or a query they can't use the result of.
 *
 * @param opts.prisma - Lite client for the scope's SQLite file.
 * @param opts.userId - Owning user id.
 * @param opts.scopeId - Scope to consider for a digest run.
 * @param opts.env - Process env carrying `FEATURE_LLM`/`MODEL_*`/`STATECORE_DIGEST_THRESHOLD`.
 * @param opts.reason - `"threshold"` (post-ingest check) or `"startup"` (catch-up on boot).
 */
export async function maybeRunDigest(opts: {
  prisma: LitePrisma;
  userId: string;
  scopeId: string;
  env: NodeJS.ProcessEnv;
  reason: "startup" | "threshold";
}): Promise<void> {
  const { prisma, userId, scopeId, env, reason } = opts;
  const digestEnv = readDigestEnv(env);
  const effectiveApiKey = digestEnv.structuredOutputApiKey ?? digestEnv.apiKey;
  if (!digestEnv.featureLlm || !effectiveApiKey) return;

  const lastDigest = await prisma.digest.findFirst({
    where: { scopeId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { createdAt: true }
  });
  const pendingCount = await prisma.memoryEvent.count({
    where: {
      scopeId,
      type: "stream",
      suppressedAt: null,
      createdAt: { gt: lastDigest?.createdAt ?? new Date(0) }
    }
  });
  const threshold = reason === "threshold" ? digestEnv.threshold : 1;
  if (!shouldDigest(pendingCount, threshold)) return;

  if (running) return;
  const locked = await acquireDigestLock(prisma, scopeId);
  if (!locked) return; // another process is already catching this scope up; skipping is harmless

  running = true;
  try {
    await runDigestPipeline(prisma, userId, scopeId, digestEnv);
  } catch (err) {
    // stdout is the MCP protocol channel; diagnostics go to stderr only. The
    // triggering events stay in the store, so the next threshold/startup
    // check retries them.
    console.error("[statecore-mcp] digest run failed", err);
  } finally {
    running = false;
    await releaseDigestLock(prisma, scopeId);
  }
}
