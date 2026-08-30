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
 * Chat-model seam the digest pipeline calls for stage 1/2 classification and
 * consolidation. `runDigestPipeline` (env-configured path) builds one from
 * `MODEL_*` env fields; {@link runScopeDigest} takes one directly, letting a
 * caller outside this package (e.g. the dsh-statecore plugin) supply its own
 * LLM client instead of an env-derived provider.
 */
export interface DigestChatModel {
  chat(messages: { role: "system" | "user"; content: string }[]): Promise<string>;
}

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
  structuredOutputReasoningEffort?: "low" | "medium" | "high";
  structuredOutputMaxOutputTokens?: number;
  timeoutMs: number;
}

/**
 * Parses `STATECORE_DIGEST_THRESHOLD`. Unset falls back to
 * {@link DEFAULT_THRESHOLD} silently — that is normal, not a misconfiguration.
 * A value that parses to `NaN` or to `<= 0`, though, would otherwise silently
 * disable distillation forever (`NaN` makes every `shouldDigest` comparison
 * false; `<= 0` makes it always true, i.e. no threshold at all) — both fall
 * back to the same default, but log the bad value so the operator can fix it.
 */
function parseDigestThreshold(raw: string | undefined): number {
  const trimmed = clean(raw);
  if (!trimmed) return DEFAULT_THRESHOLD;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(
      `[statecore-mcp] digest: invalid STATECORE_DIGEST_THRESHOLD ${JSON.stringify(trimmed)} (must be a positive number); falling back to ${DEFAULT_THRESHOLD}`
    );
    return DEFAULT_THRESHOLD;
  }
  return parsed;
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
  const modelName = clean(env.MODEL_NAME) || clean(env.OPENAI_MODEL) || "gpt-5-mini";
  const apiKey = clean(env.MODEL_API_KEY) || clean(env.OPENAI_API_KEY) || "";
  return {
    featureLlm: env.FEATURE_LLM === "true",
    threshold: parseDigestThreshold(env.STATECORE_DIGEST_THRESHOLD),
    provider: clean(env.MODEL_PROVIDER) || "openai-compatible",
    apiKey,
    baseUrl,
    modelName,
    structuredOutputApiKey: clean(env.MODEL_STRUCTURED_OUTPUT_API_KEY),
    structuredOutputBaseUrl: clean(env.MODEL_STRUCTURED_OUTPUT_BASE_URL),
    structuredOutputModelName: clean(env.MODEL_STRUCTURED_OUTPUT_NAME),
    // Unparsed/untrimmed, matching apps/worker/src/env.ts exactly: an unset
    // reasoning effort must stay unsent (spec guarantee), not fall back to a
    // default, and the max-output-tokens cast mirrors worker's own `? Number(...) : undefined`.
    structuredOutputReasoningEffort: env.MODEL_STRUCTURED_OUTPUT_REASONING_EFFORT as "low" | "medium" | "high" | undefined,
    structuredOutputMaxOutputTokens: env.MODEL_STRUCTURED_OUTPUT_MAX_OUTPUT_TOKENS
      ? Number(env.MODEL_STRUCTURED_OUTPUT_MAX_OUTPUT_TOKENS)
      : undefined,
    timeoutMs: Number(env.MODEL_TIMEOUT_MS || 120000)
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
 * Digest-pipeline body shared by the env-configured path
 * ({@link runDigestPipeline}) and the injected-llm path ({@link runScopeDigest}):
 * resolves the tenant's facet pack, selects the lookback event window, runs
 * stage 1/2 + consolidation against `llm`, and persists the result. Mirrors
 * apps/worker/src/main.ts#runDigestScopeJob minus Telegram delivery,
 * working-memory refresh, BullMQ job logging, and drift metrics — none of
 * which the embedded backend has anywhere to send.
 */
async function runDigestPipelineCore(prisma: LitePrisma, userId: string, scopeId: string, llm: DigestChatModel): Promise<void> {
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

/**
 * Env-configured entry: builds a chat model from `digestEnv`'s `MODEL_*`
 * fields and delegates to {@link runDigestPipelineCore}. Used by
 * `maybeRunDigest`'s default (non-injected) path.
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
  // Mirrors apps/worker/src/main.ts:204-213's `llm.chat` wrapper: an unset
  // reasoningEffort/maxOutputTokens must stay absent from the options object
  // rather than default in, since reasoning_effort's absence is itself a
  // spec guarantee the wire call relies on.
  const llm: DigestChatModel = {
    chat: (messages) =>
      provider.structuredOutput.chat(messages, {
        ...(typeof digestEnv.structuredOutputMaxOutputTokens === "number"
          ? { maxOutputTokens: digestEnv.structuredOutputMaxOutputTokens }
          : {}),
        ...(digestEnv.structuredOutputReasoningEffort ? { reasoningEffort: digestEnv.structuredOutputReasoningEffort } : {})
      })
  };
  await runDigestPipelineCore(prisma, userId, scopeId, llm);
}

/**
 * Public wrapper: runs one digest attempt for a scope through the same
 * lock + pipeline path `maybeRunDigest` uses, against an injected chat model
 * instead of one constructed from env. For a caller that has already decided
 * a digest should run (e.g. a threshold check owned outside this package);
 * it does not itself re-check pending-event thresholds. Skips digesting and
 * returns (does not throw) if another process already holds the scope's
 * `DigestLock`, the same as `maybeRunDigest`'s lock-contention path.
 *
 * Unlike `maybeRunDigest`, this function does not catch errors: any failure
 * from the pipeline (provider/network/validation) rejects the returned
 * promise. A fire-and-forget caller must wrap this call itself; use
 * `maybeRunDigest` where a never-rejecting call is required.
 *
 * @param opts.prisma - Lite client for the scope's SQLite file, typed
 *   `unknown` at this public surface (the concrete generated-client type is
 *   internal to this package) and cast back before use.
 * @param opts.userId - Owning user id.
 * @param opts.scopeId - Scope to digest.
 * @param opts.llm - Chat model the pipeline calls for stage 1/2 + consolidation.
 * @param opts.env - Unused by this path; kept for signature parity with
 *   `maybeRunDigest`. The injected `llm` replaces every env-derived
 *   `MODEL_*` field the env-configured path would otherwise need.
 * @throws Whatever the pipeline throws (e.g. a provider call failure or an
 *   invalid model response) — propagated uncaught.
 */
export async function runScopeDigest(opts: {
  prisma: unknown;
  userId: string;
  scopeId: string;
  llm: DigestChatModel;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const prisma = opts.prisma as LitePrisma;
  const locked = await acquireDigestLock(prisma, opts.scopeId);
  if (!locked) return;
  try {
    await runDigestPipelineCore(prisma, opts.userId, opts.scopeId, opts.llm);
  } finally {
    await releaseDigestLock(prisma, opts.scopeId);
  }
}

// In-process single-flight guard: a second call for a scope this process is
// already digesting bails before touching the DigestLock table at all. The
// lock table (digest-lock.ts) is the cross-process guarantee; this is the
// cheap same-process fast path in front of it.
let running = false;

/**
 * How one `maybeRunDigest` invocation ended: `"ran"` means the pipeline
 * completed and wrote a digest; each `"skipped-*"` names the gate that
 * stopped the run before the pipeline started; `"failed"` means a read, the
 * lock, or the pipeline threw — the error is logged to stderr and the
 * triggering events remain pending for the next attempt.
 */
export type DigestRunOutcome =
  | "ran"
  | "skipped-no-llm"
  | "skipped-below-threshold"
  | "skipped-locked"
  | "failed";

/**
 * Digest trigger: threshold-based on new stream events, plus threshold-1
 * catch-up paths (`"startup"` on boot, `"explicit"` on caller demand — any
 * backlog is worth digesting once). No-ops gracefully whenever the LLM isn't
 * configured, so keyless embedded callers never pay for a lock or a query
 * they can't use the result of.
 *
 * @param opts.prisma - Lite client for the scope's SQLite file.
 * @param opts.userId - Owning user id.
 * @param opts.scopeId - Scope to consider for a digest run.
 * @param opts.env - Process env carrying `FEATURE_LLM`/`MODEL_*`/`STATECORE_DIGEST_THRESHOLD`.
 * @param opts.reason - `"threshold"` (post-ingest check), `"startup"`
 *   (catch-up on boot), or `"explicit"` (caller-demanded catch-up — e.g. a
 *   host about to compact conversation context out of a model's view).
 * @param opts.digestLlm - Optional injected chat model. When present, the
 *   `FEATURE_LLM`/API-key env gate and env-derived provider construction are
 *   both skipped, and the pipeline runs against this model instead — the
 *   embedded backend's opt-in for a caller supplying its own LLM client.
 * @returns how the invocation ended; never rejects.
 */
export async function maybeRunDigest(opts: {
  prisma: LitePrisma;
  userId: string;
  scopeId: string;
  env: NodeJS.ProcessEnv;
  reason: "startup" | "threshold" | "explicit";
  digestLlm?: DigestChatModel;
}): Promise<DigestRunOutcome> {
  const { prisma, userId, scopeId, env, reason, digestLlm } = opts;
  try {
    const digestEnv = readDigestEnv(env);
    if (!digestLlm) {
      const effectiveApiKey = digestEnv.structuredOutputApiKey ?? digestEnv.apiKey;
      if (!digestEnv.featureLlm || !effectiveApiKey) return "skipped-no-llm";
    }

    const lastDigest = await prisma.digest.findFirst({
      where: { scopeId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { createdAt: true }
    });
    // Same either-clock condition as the lookback window this trigger feeds
    // (selectDigestEventWindow, digest-lookback.ts): an event is "pending"
    // if it is new by either createdAt (occurredAt-overridden "when it
    // happened") or ingestedAt (never overwritten "when we learned it"), so
    // an event that would be selected into the run also counts toward
    // triggering it.
    const sinceLastDigest = lastDigest?.createdAt ?? new Date(0);
    const pendingCount = await prisma.memoryEvent.count({
      where: {
        scopeId,
        type: "stream",
        suppressedAt: null,
        OR: [{ createdAt: { gt: sinceLastDigest } }, { ingestedAt: { gt: sinceLastDigest } }]
      }
    });
    const threshold = reason === "threshold" ? digestEnv.threshold : 1;
    if (!shouldDigest(pendingCount, threshold)) return "skipped-below-threshold";

    if (running) return "skipped-locked";
    const locked = await acquireDigestLock(prisma, scopeId);
    if (!locked) return "skipped-locked"; // another process is already catching this scope up; skipping is harmless

    running = true;
    try {
      if (digestLlm) {
        await runDigestPipelineCore(prisma, userId, scopeId, digestLlm);
      } else {
        await runDigestPipeline(prisma, userId, scopeId, digestEnv);
      }
    } finally {
      // Always runs once the lock is held, whether the pipeline resolved or
      // threw — release on failure too, so a crashed run doesn't strand the
      // scope for the full 30-minute stale-lock reap.
      running = false;
      await releaseDigestLock(prisma, scopeId);
    }
    return "ran";
  } catch (err) {
    // stdout is the MCP protocol channel; diagnostics go to stderr only.
    // Every await above this catch — including the pending-count reads and
    // the lock acquire that run before any lock is held — can reject (e.g. a
    // SQLite busy-timeout under cross-process DigestLock contention), and
    // both call sites invoke this fire-and-forget (`void maybeRunDigest(...)`
    // in embedded.ts). An unhandled rejection there crashes the process on
    // modern Node, so maybeRunDigest must never let one escape. The
    // triggering events stay in the store, so the next threshold/startup
    // check retries them.
    console.error("[statecore-mcp] digest run failed", err);
    return "failed";
  }
}
