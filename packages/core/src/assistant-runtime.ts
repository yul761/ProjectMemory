import { createHash } from "crypto";
import type { ChatModel, LlmChatOptions } from "./model-provider";
import {
  compileFastLayerContext,
  type FastLayerContext,
  type RecentTurnView,
} from "./fast-layer-context.compiler";
import {
  compileStateLayerView,
  compileWorkingMemoryView,
  type StateLayerView,
  type WorkingMemoryView
} from "./working-memory.compiler";
import {
  extractWorkingMemoryState,
  type WorkingMemoryState
} from "./working-memory.extractor";

const FAST_LAYER_MAX_OUTPUT_TOKENS = 400;

export type MemorySource = "telegram" | "cli" | "api" | "sdk";

export interface Digest {
  id: string;
  scopeId: string;
  summary: string;
  changes: string;
  nextSteps: string[];
  rebuildGroupId?: string | null;
  createdAt: Date;
}

export interface RuntimeMemoryService {
  ingestEvent(input: {
    userId: string;
    scopeId: string;
    type: "stream" | "document";
    source: MemorySource;
    key?: string | null;
    content: string;
  }): Promise<unknown>;
}

export interface RuntimeRetrieveService {
  retrieve(scopeId: string, limit: number, query?: string): Promise<{
    digest: Digest | null;
    events: Array<{ id: string; content: string; createdAt: Date }>;
    retrieval?: {
      matches?: Array<{
        id: string;
        sourceType?: "stream" | "document";
        key?: string | null;
        heuristicScore?: number;
        recencyScore?: number;
        embeddingScore?: number;
        finalScore?: number;
        rankingReason?: string;
      }>;
    };
  }>;
}

export type MemoryWriteTier = "ephemeral" | "candidate" | "stable" | "documented";
export type RuntimePolicyProfile = "default" | "conservative" | "document-heavy";

export interface RuntimePolicyOverrides {
  recallLimit?: number;
  promoteLongFormToDocumented?: boolean;
  digestOnCandidate?: boolean;
}

export interface RuntimeTurnInput {
  message: string;
  source?: MemorySource;
  policyProfile?: RuntimePolicyProfile;
  policyOverrides?: RuntimePolicyOverrides;
  writeTier?: MemoryWriteTier;
  documentKey?: string;
  digestMode?: "auto" | "force" | "skip";
  metadata?: Record<string, unknown>;
}

export interface ResolvedRecall {
  digest: Digest | null;
  events: Array<{ id: string; content: string; createdAt: Date }>;
  retrieval?: {
    matches?: Array<{
      id: string;
      sourceType?: "stream" | "document";
      key?: string | null;
      heuristicScore?: number;
      recencyScore?: number;
      embeddingScore?: number;
      finalScore?: number;
      rankingReason?: string;
    }>;
  };
  stateRef?: string | null;
  stateSnapshot?: RuntimeStateSnapshot | null;
  workingMemorySnapshot?: RuntimeWorkingMemorySnapshot | null;
  workingMemoryView?: WorkingMemoryView | null;
  stableStateView?: StateLayerView | null;
  recentTurns?: RecentTurnView[];
  fastLayerContext?: FastLayerContext;
  retrievalPlan?: {
    mode: "none" | "light" | "full";
    reason: string;
    limit: number;
    query?: string;
    cacheHit?: boolean;
  };
}

interface RuntimeRetrievalPlan {
  mode: "none" | "light" | "full";
  reason: string;
  limit: number;
  query: string;
  cacheHit?: boolean;
}

export interface RuntimeStateSnapshot {
  digestId: string | null;
  createdAt?: Date;
  state?: {
    stableFacts?: {
      goal?: string;
      constraints?: string[];
      decisions?: string[];
    };
    todos?: string[];
    confidence?: {
      goal?: number;
      constraints?: Array<{ value?: string; score?: number }>;
      decisions?: Array<{ value?: string; score?: number }>;
      todos?: Array<{ value?: string; score?: number }>;
    };
    workingNotes?: {
      risks?: string[];
      openQuestions?: string[];
    };
    provenance?: {
      goal?: Array<{
        id?: string;
        sourceType?: "document" | "event";
        key?: string;
        kind?: "decision" | "constraint" | "todo" | "note" | "status" | "question" | "noise";
      }>;
      constraints?: Array<{ value?: string; refs?: Array<{ id?: string; sourceType?: "document" | "event"; key?: string; kind?: "decision" | "constraint" | "todo" | "note" | "status" | "question" | "noise" }> }>;
      decisions?: Array<{ value?: string; refs?: Array<{ id?: string; sourceType?: "document" | "event"; key?: string; kind?: "decision" | "constraint" | "todo" | "note" | "status" | "question" | "noise" }> }>;
      todos?: Array<{ value?: string; refs?: Array<{ id?: string; sourceType?: "document" | "event"; key?: string; kind?: "decision" | "constraint" | "todo" | "note" | "status" | "question" | "noise" }> }>;
    };
    transitionSummary?: Record<string, number>;
    recentChanges?: Array<{
      field?: "goal" | "constraints" | "decisions" | "todos" | "volatileContext" | "openQuestions" | "risks";
      action?: "set" | "add" | "remove" | "reaffirm";
      value?: string;
    }>;
  } | null;
}

export interface RuntimeWorkingMemorySnapshot {
  id?: string;
  scopeId: string;
  version: number;
  state: WorkingMemoryState;
  view?: WorkingMemoryView | null;
  updatedAt: Date;
  createdAt?: Date;
}

export interface GroundingEvidence {
  digestIds: string[];
  eventIds: string[];
  stateRefs: string[];
  digestSummary?: string | null;
  eventSnippets?: Array<{
    id: string;
    createdAt: string;
    snippet: string;
    sourceType?: "stream" | "document";
    key?: string | null;
    rankingReason?: string;
    heuristicScore?: number;
    recencyScore?: number;
    embeddingScore?: number;
    finalScore?: number;
  }>;
  stateSummary?: string | null;
  stateDetails?: {
    digestId: string | null;
    goal?: string;
    constraints?: string[];
    todos?: string[];
    risks?: string[];
    confidence?: {
      goal?: number;
      constraints?: Array<{ value?: string; score?: number }>;
      decisions?: Array<{ value?: string; score?: number }>;
      todos?: Array<{ value?: string; score?: number }>;
    };
    provenanceFields?: string[];
    transitionTaxonomy?: Record<string, number>;
    recentChanges?: Array<{
      field?: "goal" | "constraints" | "decisions" | "todos" | "volatileContext" | "openQuestions" | "risks";
      action?: "set" | "add" | "remove" | "reaffirm";
      value?: string;
    }>;
  } | null;
}

export interface GroundedAnswer {
  answer: string;
  answerMode?: "direct_state_fast_path" | "llm_fast_path";
  writeTier: MemoryWriteTier;
  digestTriggered: boolean;
  workingMemoryVersion?: number | null;
  stableStateVersion?: string | null;
  usedFastLayerContextSummary?: string;
  retrievalPlan?: ResolvedRecall["retrievalPlan"];
  layerAlignment?: LayerAlignment;
  warnings?: string[];
  notes?: string[];
  evidence: GroundingEvidence;
}

export interface LayerAlignment {
  goalAligned: boolean;
  sharedConstraintCount: number;
  sharedDecisionCount: number;
  fastPathReady: boolean;
}

function normalizeLayerText(value?: string | null) {
  return value?.trim().replace(/\s+/g, " ").toLowerCase() ?? "";
}

function overlapCount(left?: string[] | null, right?: string[] | null) {
  const leftNorm = (left ?? []).map(normalizeLayerText).filter((s) => s.length >= 10);
  const rightNorm = (right ?? []).map(normalizeLayerText).filter((s) => s.length >= 10);
  if (!leftNorm.length || !rightNorm.length) return 0;
  return leftNorm.filter((l) => rightNorm.some((r) => r.includes(l) || l.includes(r))).length;
}

function detectLayerWarnings(input: {
  workingGoal?: string | null;
  stableGoal?: string | null;
  sharedConstraintCount: number;
  sharedDecisionCount: number;
  workingConstraints?: string[] | null;
  stableConstraints?: string[] | null;
  workingDecisions?: string[] | null;
  stableDecisions?: string[] | null;
}) {
  const warnings = [];
  const structuredLeakPattern = /(^|\n|\\n)\s*(constraint|decision|todo|question|open question|risk|status)\s*:/i;

  if (input.workingGoal && structuredLeakPattern.test(input.workingGoal)) {
    warnings.push("working_goal_contains_structured_lines");
  }
  if (input.stableGoal && structuredLeakPattern.test(input.stableGoal)) {
    warnings.push("stable_goal_contains_structured_lines");
  }
  if (input.stableGoal && !input.workingGoal) {
    warnings.push("working_goal_missing");
  }
  if (input.workingGoal && !input.stableGoal) {
    warnings.push("stable_goal_missing");
  }
  if (input.workingGoal && input.stableGoal && normalizeLayerText(input.workingGoal) !== normalizeLayerText(input.stableGoal)) {
    warnings.push("goal_mismatch");
  }
  if ((input.workingConstraints?.length ?? 0) > 0 && (input.stableConstraints?.length ?? 0) > 0 && input.sharedConstraintCount === 0) {
    warnings.push("constraint_sets_do_not_overlap");
  }
  if ((input.workingDecisions?.length ?? 0) > 0 && (input.stableDecisions?.length ?? 0) > 0 && input.sharedDecisionCount === 0) {
    warnings.push("decision_sets_do_not_overlap");
  }

  return warnings;
}

export function computeLayerDiagnostics(input: {
  workingMemoryView?: WorkingMemoryView | null;
  stableStateView?: StateLayerView | null;
  workingMemoryVersion?: number | null;
  stableStateVersion?: string | null;
}) {
  const sharedConstraintCount = overlapCount(input.workingMemoryView?.constraints, input.stableStateView?.constraints);
  const sharedDecisionCount = overlapCount(input.workingMemoryView?.decisions, input.stableStateView?.decisions);
  const workingGoalNorm = normalizeLayerText(input.workingMemoryView?.goal);
  // stable state may not have digested a goal yet; fall back to working memory goal so absence ≠ drift
  const effectiveStableGoalNorm = normalizeLayerText(input.stableStateView?.goal) || workingGoalNorm;
  const layerAlignment: LayerAlignment = {
    goalAligned: Boolean(workingGoalNorm && workingGoalNorm === effectiveStableGoalNorm),
    sharedConstraintCount,
    sharedDecisionCount,
    fastPathReady: Boolean(input.workingMemoryVersion && input.stableStateVersion)
  };

  return {
    layerAlignment,
    warnings: detectLayerWarnings({
      workingGoal: input.workingMemoryView?.goal,
      stableGoal: input.stableStateView?.goal,
      sharedConstraintCount,
      sharedDecisionCount,
      workingConstraints: input.workingMemoryView?.constraints,
      stableConstraints: input.stableStateView?.constraints,
      workingDecisions: input.workingMemoryView?.decisions,
      stableDecisions: input.stableStateView?.decisions
    })
  };
}

function normalizeSnapshotRef(ref?: {
  id?: string;
  sourceType?: "document" | "event";
  key?: string;
  kind?: "decision" | "constraint" | "todo" | "note" | "status" | "question" | "noise";
}) {
  if (!ref?.id || !ref?.sourceType) return null;
  return {
    id: ref.id,
    sourceType: ref.sourceType,
    key: ref.key,
    kind: ref.kind
  };
}

function scoreSnapshotConfidence(refs?: Array<{
  id?: string;
  sourceType?: "document" | "event";
  key?: string;
  kind?: "decision" | "constraint" | "todo" | "note" | "status" | "question" | "noise";
}> | null) {
  const unique = [...new Map((refs ?? []).map((ref) => {
    const normalized = normalizeSnapshotRef(ref);
    return normalized
      ? [`${normalized.sourceType}:${normalized.id}:${normalized.key ?? ""}:${normalized.kind ?? ""}`, normalized]
      : ["", null];
  })).values()].filter(Boolean) as Array<{ sourceType: "document" | "event" }>;
  if (!unique.length) return undefined;
  const residual = unique.reduce((product, ref) => product * (1 - (ref.sourceType === "document" ? 1 : 0.7)), 1);
  return Number((1 - residual).toFixed(3));
}

function buildSnapshotConfidenceList(entries?: Array<{
  value?: string;
  refs?: Array<{
    id?: string;
    sourceType?: "document" | "event";
    key?: string;
    kind?: "decision" | "constraint" | "todo" | "note" | "status" | "question" | "noise";
  }>;
}> | null) {
  return (entries ?? [])
    .map((entry) => ({
      value: entry?.value?.trim() ?? "",
      score: scoreSnapshotConfidence(entry?.refs)
    }))
    .filter((entry) => entry.value && typeof entry.score === "number");
}

export interface MemoryWriteDecision {
  tier: MemoryWriteTier;
  reason?: string;
}

export interface MemoryWritePolicy {
  classifyTurn(input: RuntimeTurnInput): MemoryWriteTier | MemoryWriteDecision | Promise<MemoryWriteTier | MemoryWriteDecision>;
}

export interface RecallPolicy {
  resolve(input: {
    scopeId: string;
    message: string;
  }): Promise<ResolvedRecall>;
}

export interface RuntimeBackgroundProcessor {
  persistTurnArtifacts(input: {
    userId: string;
    scopeId: string;
    turn: RuntimeTurnInput;
    writeTier: MemoryWriteTier;
    answer: string;
    assistantReplySource: MemorySource;
  }): Promise<void>;
  requestWorkingMemoryUpdate?(scopeId: string): Promise<void>;
  requestStableStateDigest?(scopeId: string): Promise<void>;
}

export interface DigestPolicy {
  shouldDigest(input: {
    turn: RuntimeTurnInput;
    writeTier: MemoryWriteTier;
    recall: ResolvedRecall;
  }): boolean | { shouldDigest: boolean; reason?: string } | Promise<boolean | { shouldDigest: boolean; reason?: string }>;
}

export interface DigestTrigger {
  requestDigest(scopeId: string): Promise<void>;
}

export interface AssistantSessionOptions {
  userId: string;
  scopeId: string;
  memoryService: RuntimeMemoryService;
  recallPolicy: RecallPolicy;
  llm: ChatModel;
  prompts: {
    system: string;
    user: string;
  };
  memoryWritePolicy?: MemoryWritePolicy;
  digestPolicy?: DigestPolicy;
  digestTrigger?: DigestTrigger;
  backgroundProcessor?: RuntimeBackgroundProcessor;
  assistantReplySource?: MemorySource;
  runtimeResponseOptions?: LlmChatOptions;
}

function isEmptyContentError(error: unknown) {
  return error instanceof Error && /LLM response missing content/i.test(error.message);
}

const RUNTIME_RECALL_CACHE_TTL_MS = 15_000;
const runtimeRecallCache = new Map<string, {
  expiresAt: number;
  result: Awaited<ReturnType<RuntimeRetrieveService["retrieve"]>>;
}>();
const runtimeResolvedRecallCache = new Map<string, {
  expiresAt: number;
  result: ResolvedRecall;
}>();

function buildRecallCacheKey(input: {
  scopeId: string;
  mode: "none" | "light" | "full";
  limit: number;
  query: string;
  stateRef?: string | null;
  workingMemoryVersion?: number | null;
  recentTurnIds?: string[];
}) {
  return [
    input.scopeId,
    input.mode,
    String(input.limit),
    input.query,
    input.stateRef ?? "",
    String(input.workingMemoryVersion ?? ""),
    (input.recentTurnIds ?? []).join(",")
  ].join("::");
}

function compactQueryLine(value?: string | null) {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

function selectRetrieveQuery(input: {
  message: string;
  workingMemoryView: WorkingMemoryView;
  stableStateView: StateLayerView;
}) {
  return [
    compactQueryLine(input.message),
    compactQueryLine(input.workingMemoryView.goal),
    compactQueryLine(input.stableStateView.goal),
    ...(input.workingMemoryView.constraints ?? []).slice(0, 1).map((item) => compactQueryLine(item)),
    ...(input.stableStateView.constraints ?? []).slice(0, 1).map((item) => compactQueryLine(item))
  ].filter(Boolean).join("\n");
}

function classifyTurnRetrievalPlan(input: {
  message: string;
  limit: number;
  forceLimit?: boolean;
  workingMemoryView: WorkingMemoryView;
  stableStateView: StateLayerView;
}): RuntimeRetrievalPlan {
  const normalized = input.message.trim().toLowerCase();
  const retrieveQuery = selectRetrieveQuery(input);
  const noRetrievalPatterns = [
    /^(goal|constraint|decision|todo)\s*:/i,
    /^(thanks|thank you|ok|okay|cool|got it|sounds good)[.!]?$/i,
    /\b(rewrite|rephrase|shorten|expand|format|rename|title|commit message|polish|clean up)\b/i
  ];
  const fullRetrievalPatterns = [
    /\b(source|sources|evidence|quote|quoted|reference|references|replay|history|timeline|document|docs|file|files)\b/i,
    /\b(why did|what changed|according to|show me)\b/i
  ];
  const goalRetrievalPatterns = [
    /\b(goal|objective|architecture goal|project goal)\b/i
  ];
  const lightRetrievalPatterns = [
    /\?$/,
    /\b(goal|constraints?|decisions?|todos?|open questions?|remaining|remains|status|progress|current|state|plan|task|runtime)\b/i
  ];

  if (noRetrievalPatterns.some((pattern) => pattern.test(normalized))) {
    return {
      mode: "none" as const,
      reason: "local_turn_only",
      limit: 0,
      query: ""
    };
  }
  if (fullRetrievalPatterns.some((pattern) => pattern.test(normalized))) {
    return {
      mode: "full" as const,
      reason: "evidence_or_history_request",
      limit: Math.max(1, input.limit),
      query: retrieveQuery || input.message
    };
  }
  if (goalRetrievalPatterns.some((pattern) => pattern.test(normalized))) {
    return {
      mode: "light" as const,
      reason: "goal_lookup",
      limit: input.forceLimit ? Math.max(1, input.limit) : Math.max(3, Math.min(input.limit, 4)),
      query: retrieveQuery || input.message
    };
  }
  if (lightRetrievalPatterns.some((pattern) => pattern.test(normalized))) {
    return {
      mode: "light" as const,
      reason: "state_or_status_request",
      limit: input.forceLimit ? Math.max(1, input.limit) : Math.max(1, Math.min(input.limit, 2)),
      query: retrieveQuery || input.message
    };
  }
  return {
    mode: "light" as const,
    reason: "default_light_recall",
    limit: input.forceLimit ? Math.max(1, input.limit) : Math.max(1, Math.min(input.limit, 2)),
    query: retrieveQuery || input.message
  };
}

export function buildGroundingStateDetails(snapshot?: RuntimeStateSnapshot | null) {
  if (!snapshot?.digestId) return null;
  const provenance = snapshot.state?.provenance;
  const recentChanges = snapshot.state?.recentChanges ?? [];
  const confidence = snapshot.state?.confidence;
  const provenanceFields = [
    Array.isArray(provenance?.goal) && provenance.goal.length ? "goal" : null,
    Array.isArray(provenance?.constraints) && provenance.constraints.length ? "constraints" : null,
    Array.isArray(provenance?.decisions) && provenance.decisions.length ? "decisions" : null,
    Array.isArray(provenance?.todos) && provenance.todos.length ? "todos" : null
  ].filter((value): value is string => Boolean(value));
  const transitionTaxonomy = Object.keys(snapshot.state?.transitionSummary ?? {}).length
    ? Object.fromEntries(
        Object.entries(snapshot.state?.transitionSummary ?? {})
          .filter((entry): entry is [string, number] => typeof entry[0] === "string" && typeof entry[1] === "number")
          .sort(([a], [b]) => a.localeCompare(b))
      )
    : Object.fromEntries(
        Object.entries(
          recentChanges.reduce<Record<string, number>>((acc, change) => {
            if (!change?.field || !change?.action) return acc;
            const key = `${change.field}:${change.action}`;
            acc[key] = (acc[key] || 0) + 1;
            return acc;
          }, {})
        ).sort(([a], [b]) => a.localeCompare(b))
      );

  return {
    digestId: snapshot.digestId,
    goal: snapshot.state?.stableFacts?.goal,
    constraints: snapshot.state?.stableFacts?.constraints ?? [],
    todos: snapshot.state?.todos ?? [],
    risks: snapshot.state?.workingNotes?.risks ?? [],
    confidence: {
      goal: confidence?.goal ?? scoreSnapshotConfidence(provenance?.goal),
      constraints: confidence?.constraints ?? buildSnapshotConfidenceList(provenance?.constraints),
      decisions: confidence?.decisions ?? buildSnapshotConfidenceList(provenance?.decisions),
      todos: confidence?.todos ?? buildSnapshotConfidenceList(provenance?.todos)
    },
    provenanceFields,
    transitionTaxonomy,
    recentChanges
  };
}

export function summarizeGroundingStateSnapshot(snapshot?: RuntimeStateSnapshot | null) {
  if (!snapshot?.digestId) return null;
  const goal = snapshot.state?.stableFacts?.goal;
  const constraints = snapshot.state?.stableFacts?.constraints ?? [];
  const todos = snapshot.state?.todos ?? [];
  const risks = snapshot.state?.workingNotes?.risks ?? [];
  const provenance = snapshot.state?.provenance;
  const recentChanges = snapshot.state?.recentChanges ?? [];
  const parts = [`digest:${snapshot.digestId}`];
  if (goal) parts.push(`goal:${goal}`);
  if (constraints.length) parts.push(`constraints:${constraints.slice(0, 2).join(" | ")}`);
  if (todos.length) parts.push(`todos:${todos.slice(0, 2).join(" | ")}`);
  if (risks.length) parts.push(`risks:${risks.slice(0, 2).join(" | ")}`);
  const provenanceParts = [
    Array.isArray(provenance?.goal) && provenance.goal.length ? "goal" : null,
    Array.isArray(provenance?.constraints) && provenance.constraints.length ? "constraints" : null,
    Array.isArray(provenance?.decisions) && provenance.decisions.length ? "decisions" : null,
    Array.isArray(provenance?.todos) && provenance.todos.length ? "todos" : null
  ].filter(Boolean);
  if (provenanceParts.length) {
    parts.push(`provenance:${provenanceParts.join("|")}`);
  }
  if (recentChanges.length) {
    parts.push(
      `recent:${recentChanges
        .slice(-2)
        .map((change) => `${change.field}:${change.action}:${change.value}`)
        .join(" | ")}`
    );
  }
  return parts.join("; ");
}

export function buildGroundingEvidence(input: {
  digest?: Digest | null;
  events: Array<{ id: string; content: string; createdAt: Date }>;
  retrieval?: ResolvedRecall["retrieval"];
  stateRef?: string | null;
  stateSnapshot?: RuntimeStateSnapshot | null;
}): GroundingEvidence {
  const stateDetails = buildGroundingStateDetails(input.stateSnapshot);
  const stateSummary = summarizeGroundingStateSnapshot(input.stateSnapshot);
  const retrievalMatches = new Map(
    input.retrieval?.matches?.map((match) => [match.id, match]) ?? []
  );
  return {
    digestIds: input.digest ? [input.digest.id] : [],
    eventIds: input.events.map((event) => event.id),
    stateRefs: input.stateRef ? [input.stateRef] : [],
    digestSummary: input.digest?.summary ?? null,
    eventSnippets: input.events.slice(0, 5).map((event) => {
      const match = retrievalMatches.get(event.id);
      return {
        id: event.id,
        createdAt: event.createdAt.toISOString(),
        snippet: event.content.length > 160 ? `${event.content.slice(0, 157)}...` : event.content,
        sourceType: match?.sourceType,
        key: match?.key ?? null,
        rankingReason: match?.rankingReason,
        heuristicScore: match?.heuristicScore,
        recencyScore: match?.recencyScore,
        embeddingScore: match?.embeddingScore,
        finalScore: match?.finalScore
      };
    }),
    stateSummary,
    stateDetails
  };
}

function shouldPromoteLongForm(text: string, overrides?: RuntimePolicyOverrides) {
  return overrides?.promoteLongFormToDocumented === true && (text.includes("\n") || text.length > 280);
}

function uniqueList(items: Array<string | undefined | null>, limit = 5) {
  return [...new Set(items.map((item) => item?.trim() ?? "").filter(Boolean))].slice(0, limit);
}

function formatListAnswer(prefix: string, items: string[]) {
  if (!items.length) return null;
  return `${prefix}: ${items.join("; ")}.`;
}

function extractTodoItemsFromEvents(events: Array<{ content: string }>) {
  const todos = new Set<string>();
  for (const event of events) {
    const lines = event.content
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    for (const line of lines) {
      if (/^todo\s*:/i.test(line)) {
        todos.add(line.replace(/^todo\s*:/i, "").trim());
      }
      if (/^next step\s*:/i.test(line)) {
        todos.add(line.replace(/^next step\s*:/i, "").trim());
      }
    }
  }
  return [...todos].filter(Boolean);
}

function maybeBuildDirectRuntimeAnswer(question: string, recall: ResolvedRecall) {
  const normalized = question.trim().toLowerCase();
  const isQuestionLike = normalized.endsWith("?")
    || /^(what|which|list|summarize|tell me|what's|whats)\b/i.test(normalized);
  if (!isQuestionLike) {
    return null;
  }
  const stable = recall.stableStateView ?? {
    goal: undefined,
    constraints: [],
    decisions: [],
    todos: [],
    openQuestions: [],
    risks: []
  };
  const working = recall.workingMemoryView ?? {
    goal: undefined,
    constraints: [],
    decisions: [],
    progressSummary: undefined,
    openQuestions: [],
    taskFrame: undefined
  };
  const derivedWorking = extractWorkingMemoryState(
    recall.events.map((event) => ({
      id: event.id,
      type: "stream" as const,
      content: event.content,
      createdAt: event.createdAt
    }))
  );
  const derivedTodos = extractTodoItemsFromEvents(recall.events);

  if (/\b(goal|objective|architecture goal|project goal)\b/i.test(normalized)) {
    const goal = stable.goal ?? working.goal ?? derivedWorking.currentGoal;
    if (goal) {
      return `Current goal: ${goal}.`;
    }
  }

  if (/\bconstraints?\b/i.test(normalized)) {
    const constraints = uniqueList([
      ...stable.constraints,
      ...working.constraints,
      ...derivedWorking.activeConstraints
    ]);
    return formatListAnswer("Current constraints", constraints);
  }

  if (/\b(decision|decisions|decide|decided)\b/i.test(normalized)) {
    const decisions = uniqueList([
      ...stable.decisions,
      ...working.decisions,
      ...derivedWorking.recentDecisions
    ]);
    return formatListAnswer("Key decisions", decisions);
  }

  if (/\b(open|remaining|remains|todo|todos|work is still open|left to do|next steps?)\b/i.test(normalized)) {
    const openWork = uniqueList([
      ...stable.todos,
      ...derivedTodos,
      ...working.openQuestions.map((item) => `open question: ${item}`)
    ]);
    return formatListAnswer("Open work", openWork);
  }

  return null;
}

export class DefaultMemoryWritePolicy implements MemoryWritePolicy {
  classifyTurn(input: RuntimeTurnInput): MemoryWriteDecision {
    if (input.writeTier) return { tier: input.writeTier, reason: "explicit_write_tier" };
    const text = input.message.trim().toLowerCase();
    if (!text) return { tier: "ephemeral", reason: "empty_message" };
    if (/^(thanks|thank you|ok|okay|cool|got it|sounds good)[.!]?$/i.test(text)) {
      return { tier: "ephemeral", reason: "acknowledgement_only" };
    }
    if (/^(goal|constraint|decision|todo)\s*:/i.test(text)) {
      return { tier: "stable", reason: "explicit_structured_memory" };
    }
    if (
      /\b(i am|i'm)\s+trying\s+to\b/i.test(text)
      || /\b(i want to|i'd like to|i would like to|my goal is to|i prefer|i'd prefer|i'm looking to|i am looking to)\b/i.test(text)
    ) {
      return { tier: "stable", reason: "natural_language_memory_signal" };
    }
    if (/\b(uploaded doc|document update|spec|architecture|roadmap)\b/i.test(text)) {
      return { tier: "documented", reason: "document_like_update" };
    }
    if (/\b(decide|decision|constraint|must|cannot|todo|next step|action item|blocked|risk)\b/i.test(text)) {
      return { tier: "stable", reason: "stable_fact_signal" };
    }
    return { tier: "candidate", reason: "default_candidate_memory" };
  }
}

export class ProfiledMemoryWritePolicy implements MemoryWritePolicy {
  constructor(private profile: RuntimePolicyProfile = "default") {}

  classifyTurn(input: RuntimeTurnInput): MemoryWriteDecision {
    if (input.writeTier) return { tier: input.writeTier, reason: "explicit_write_tier" };

    const text = input.message.trim().toLowerCase();
    if (!text) return { tier: "ephemeral", reason: "empty_message" };
    if (/^(thanks|thank you|ok|okay|cool|got it|sounds good)[.!]?$/i.test(text)) {
      return { tier: "ephemeral", reason: "acknowledgement_only" };
    }
    if (/^(goal|constraint|decision|todo)\s*:/i.test(text)) {
      return { tier: "stable", reason: `profile_${this.profile}_explicit_structured_memory` };
    }
    if (
      /\b(i am|i'm)\s+trying\s+to\b/i.test(text)
      || /\b(i want to|i'd like to|i would like to|my goal is to|i prefer|i'd prefer|i'm looking to|i am looking to)\b/i.test(text)
    ) {
      return { tier: "stable", reason: `profile_${this.profile}_natural_language_memory_signal` };
    }
    if (shouldPromoteLongForm(input.message, input.policyOverrides)) {
      return { tier: "documented", reason: "override_promote_long_form" };
    }

    if (this.profile === "conservative") {
      if (/\b(uploaded doc|document update|spec|architecture|roadmap)\b/i.test(text)) {
        return { tier: "documented", reason: "profile_conservative_document_like_update" };
      }
      if (/\b(decide|decision|constraint|must|cannot|todo|next step|action item|blocked|risk)\b/i.test(text)) {
        return { tier: "candidate", reason: "profile_conservative_requires_explicit_promotion" };
      }
      return { tier: "ephemeral", reason: "profile_conservative_default_ephemeral" };
    }

    if (this.profile === "document-heavy") {
      if (/\b(uploaded doc|document update|spec|architecture|roadmap)\b/i.test(text) || text.includes("\n") || text.length > 280) {
        return { tier: "documented", reason: "profile_document_heavy_long_form_memory" };
      }
      if (/\b(decide|decision|constraint|must|cannot|todo|next step|action item|blocked|risk)\b/i.test(text)) {
        return { tier: "stable", reason: "profile_document_heavy_stable_fact_signal" };
      }
      return { tier: "candidate", reason: "profile_document_heavy_default_candidate" };
    }

    return new DefaultMemoryWritePolicy().classifyTurn(input);
  }
}

export class DefaultRecallPolicy implements RecallPolicy {
  constructor(
    private retrieveService: RuntimeRetrieveService,
    private options?: {
      scopeStateLoader?: (scopeId: string) => Promise<RuntimeStateSnapshot | null>;
      workingMemoryLoader?: (scopeId: string) => Promise<RuntimeWorkingMemorySnapshot | null>;
      recentTurnsLoader?: (scopeId: string, limit: number) => Promise<Array<{ id: string; content: string; createdAt: Date }>>;
      limit?: number;
      recentTurnsLimit?: number;
      forceRecallLimit?: boolean;
    }
  ) {}

  async resolve(input: { scopeId: string; message: string }): Promise<ResolvedRecall> {
    const [state, workingMemory, recentTurnEvents] = await Promise.all([
      this.options?.scopeStateLoader ? this.options.scopeStateLoader(input.scopeId) : Promise.resolve(null),
      this.options?.workingMemoryLoader ? this.options.workingMemoryLoader(input.scopeId) : Promise.resolve(null),
      this.options?.recentTurnsLoader
        ? this.options.recentTurnsLoader(input.scopeId, this.options?.recentTurnsLimit ?? 3)
        : Promise.resolve([])
    ]);
    const stableStateView = compileStateLayerView(state?.state ?? null);
    const workingMemoryView = workingMemory?.view ?? compileWorkingMemoryView(workingMemory?.state ?? null);
    const recentTurns = recentTurnEvents.map((event) => ({
      id: event.id,
      role: /^assistant reply:/i.test(event.content) ? "assistant" : "user",
      content: event.content.replace(/^assistant reply:\s*/i, "").trim(),
      createdAt: event.createdAt
    })) satisfies RecentTurnView[];
    const retrievalPlan = classifyTurnRetrievalPlan({
      message: input.message,
      limit: this.options?.limit ?? 4,
      forceLimit: this.options?.forceRecallLimit,
      workingMemoryView,
      stableStateView
    });
    const resolvedCacheKey = buildRecallCacheKey({
      scopeId: input.scopeId,
      mode: retrievalPlan.mode,
      limit: retrievalPlan.limit,
      query: `${input.message}\n${retrievalPlan.query}`,
      stateRef: state?.digestId ?? null,
      workingMemoryVersion: workingMemory?.version ?? null,
      recentTurnIds: recentTurns.map((turn) => turn.id)
    });
    const resolvedCached = runtimeResolvedRecallCache.get(resolvedCacheKey);
    if (resolvedCached && resolvedCached.expiresAt > Date.now()) {
      return {
        ...resolvedCached.result,
        retrievalPlan: resolvedCached.result.retrievalPlan
          ? { ...resolvedCached.result.retrievalPlan, cacheHit: true }
          : undefined
      };
    }
    let result: Awaited<ReturnType<RuntimeRetrieveService["retrieve"]>> = {
      digest: null,
      events: [],
      retrieval: { matches: [] }
    };
    if (retrievalPlan.mode !== "none") {
      const cacheKey = buildRecallCacheKey({
        scopeId: input.scopeId,
        mode: retrievalPlan.mode,
        limit: retrievalPlan.limit,
        query: retrievalPlan.query,
        stateRef: state?.digestId ?? null,
        workingMemoryVersion: workingMemory?.version ?? null,
        recentTurnIds: recentTurns.map((turn) => turn.id)
      });
      const cached = runtimeRecallCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        result = cached.result;
      } else {
        result = await this.retrieveService.retrieve(
          input.scopeId,
          retrievalPlan.limit,
          retrievalPlan.query || input.message
        );
        runtimeRecallCache.set(cacheKey, {
          expiresAt: Date.now() + RUNTIME_RECALL_CACHE_TTL_MS,
          result
        });
      }
      retrievalPlan.cacheHit = Boolean(cached && cached.expiresAt > Date.now());
    }
    const fastLayerContext = compileFastLayerContext({
      message: input.message,
      workingMemoryView,
      stateLayerView: stableStateView,
      retrievalSnippets: result.events.map((event) => ({
        id: event.id,
        content: event.content,
        createdAt: event.createdAt
      })),
      recentTurns
    });
    const resolvedRecall = {
      digest: result.digest,
      events: result.events,
      retrieval: result.retrieval,
      stateRef: state?.digestId ?? null,
      stateSnapshot: state,
      workingMemorySnapshot: workingMemory,
      workingMemoryView,
      stableStateView,
      recentTurns,
      fastLayerContext,
      retrievalPlan
    };
    runtimeResolvedRecallCache.set(resolvedCacheKey, {
      expiresAt: Date.now() + RUNTIME_RECALL_CACHE_TTL_MS,
      result: resolvedRecall
    });
    return resolvedRecall;
  }
}

export class ThresholdDigestPolicy implements DigestPolicy {
  constructor(private threshold = 1) {}

  async shouldDigest(input: { writeTier: MemoryWriteTier }): Promise<{ shouldDigest: boolean; reason?: string }> {
    if (this.threshold <= 1) {
      return {
        shouldDigest: input.writeTier === "stable" || input.writeTier === "documented",
        reason: input.writeTier === "stable" || input.writeTier === "documented"
          ? "stable_or_documented_turn"
          : "write_tier_below_threshold"
      };
    }
    return {
      shouldDigest: input.writeTier === "documented",
      reason: input.writeTier === "documented"
        ? "documented_turn"
        : "threshold_requires_documented_turn"
    };
  }
}

export class ProfiledDigestPolicy implements DigestPolicy {
  constructor(private profile: RuntimePolicyProfile = "default") {}

  async shouldDigest(input: { turn: RuntimeTurnInput; writeTier: MemoryWriteTier }): Promise<{ shouldDigest: boolean; reason?: string }> {
    if (input.turn.policyOverrides?.digestOnCandidate && input.writeTier === "candidate") {
      return {
        shouldDigest: true,
        reason: "override_digest_on_candidate"
      };
    }
    if (this.profile === "conservative") {
      return {
        shouldDigest: input.writeTier === "documented",
        reason: input.writeTier === "documented"
          ? "profile_conservative_documented_turn"
          : "profile_conservative_skip_non_documented"
      };
    }
    if (this.profile === "document-heavy") {
      return {
        shouldDigest: input.writeTier === "stable" || input.writeTier === "documented" || input.writeTier === "candidate",
        reason: input.writeTier === "ephemeral"
          ? "profile_document_heavy_skip_ephemeral"
          : "profile_document_heavy_digest_memory_turn"
      };
    }
    return new ThresholdDigestPolicy().shouldDigest(input);
  }
}

export function createRuntimePolicyBundle(profile: RuntimePolicyProfile = "default") {
  return {
    memoryWritePolicy: new ProfiledMemoryWritePolicy(profile),
    digestPolicy: new ProfiledDigestPolicy(profile)
  };
}

export function createRuntimeRecallPolicy(
  retrieveService: RuntimeRetrieveService,
  options?: {
    profile?: RuntimePolicyProfile;
    overrides?: RuntimePolicyOverrides;
    scopeStateLoader?: (scopeId: string) => Promise<RuntimeStateSnapshot | null>;
    workingMemoryLoader?: (scopeId: string) => Promise<RuntimeWorkingMemorySnapshot | null>;
    recentTurnsLoader?: (scopeId: string, limit: number) => Promise<Array<{ id: string; content: string; createdAt: Date }>>;
  }
) {
  const profile = options?.profile ?? "default";
  const profileLimit = profile === "conservative" ? 2 : profile === "document-heavy" ? 6 : 4;
  const recentTurnsLimit = profile === "conservative" ? 2 : profile === "document-heavy" ? 4 : 3;
  return new DefaultRecallPolicy(retrieveService, {
    scopeStateLoader: options?.scopeStateLoader,
    workingMemoryLoader: options?.workingMemoryLoader,
    recentTurnsLoader: options?.recentTurnsLoader,
    limit: options?.overrides?.recallLimit ?? profileLimit,
    recentTurnsLimit,
    forceRecallLimit: typeof options?.overrides?.recallLimit === "number"
  });
}

export class AssistantSession {
  private memoryWritePolicy: MemoryWritePolicy;
  private digestPolicy: DigestPolicy | null;

  constructor(private options: AssistantSessionOptions) {
    this.memoryWritePolicy = options.memoryWritePolicy ?? new DefaultMemoryWritePolicy();
    this.digestPolicy = options.digestPolicy ?? null;
  }

  async handleTurn(input: RuntimeTurnInput): Promise<GroundedAnswer> {
    const writeDecision = this.normalizeWriteDecision(await this.memoryWritePolicy.classifyTurn(input));
    const writeTier = writeDecision.tier;
    const notes = writeDecision.reason ? [`write_tier:${writeDecision.reason}`] : [];

    const recall = await this.options.recallPolicy.resolve({
      scopeId: this.options.scopeId,
      message: input.message
    });

    const directAnswer = maybeBuildDirectRuntimeAnswer(input.message, recall);
    const answerMode = directAnswer ? "direct_state_fast_path" : "llm_fast_path";
    const answer = directAnswer ?? await this.generateGroundedAnswer(input.message, recall);
    if (directAnswer) {
      notes.push("answer:direct_state_fast_path");
    }

    let digestTriggered = false;
    const shouldAttemptDigest = input.digestMode !== "skip" && Boolean(this.options.backgroundProcessor?.requestStableStateDigest || this.options.digestTrigger);
    if (shouldAttemptDigest) {
      if (input.digestMode === "force") {
        digestTriggered = true;
        notes.push("digest:forced_by_input");
      } else if (this.digestPolicy) {
        const digestDecision = this.normalizeDigestDecision(await this.digestPolicy.shouldDigest({
          turn: input,
          writeTier,
          recall
        }));
        digestTriggered = digestDecision.shouldDigest;
        if (digestDecision.reason) {
          notes.push(`digest:${digestDecision.reason}`);
        }
      }
    } else if (input.digestMode === "skip") {
      notes.push("digest:skipped_by_input");
    }

    this.scheduleBackgroundTasks(input, writeTier, answer, digestTriggered);

    const stableStateView = recall.stableStateView ?? compileStateLayerView(recall.stateSnapshot?.state ?? null);
    const diagnostics = computeLayerDiagnostics({
      workingMemoryView: recall.workingMemoryView ?? null,
      stableStateView,
      workingMemoryVersion: recall.workingMemorySnapshot?.version ?? null,
      stableStateVersion: recall.stateRef ?? null
    });

    return {
      answer,
      answerMode,
      writeTier,
      digestTriggered,
      workingMemoryVersion: recall.workingMemorySnapshot?.version ?? null,
      stableStateVersion: recall.stateRef ?? null,
      usedFastLayerContextSummary: recall.fastLayerContext?.summary,
      retrievalPlan: recall.retrievalPlan,
      layerAlignment: diagnostics.layerAlignment,
      warnings: diagnostics.warnings,
      notes,
      evidence: this.buildEvidence(recall)
    };
  }

  private scheduleBackgroundTasks(
    input: RuntimeTurnInput,
    writeTier: MemoryWriteTier,
    answer: string,
    digestTriggered: boolean
  ) {
    const backgroundProcessor = this.options.backgroundProcessor;
    if (!backgroundProcessor) {
      return;
    }
    queueMicrotask(() => {
      void (async () => {
        if (writeTier !== "ephemeral") {
          await backgroundProcessor.persistTurnArtifacts({
            userId: this.options.userId,
            scopeId: this.options.scopeId,
            turn: input,
            writeTier,
            answer,
            assistantReplySource: this.options.assistantReplySource ?? "sdk"
          });
        }
        if (writeTier !== "ephemeral" && backgroundProcessor.requestWorkingMemoryUpdate) {
          await backgroundProcessor.requestWorkingMemoryUpdate(this.options.scopeId);
        }
        if (digestTriggered) {
          if (backgroundProcessor.requestStableStateDigest) {
            await backgroundProcessor.requestStableStateDigest(this.options.scopeId);
          } else if (this.options.digestTrigger) {
            await this.options.digestTrigger.requestDigest(this.options.scopeId);
          }
        }
      })().catch(() => undefined);
    });
  }

  private async writeTurn(input: RuntimeTurnInput, writeTier: MemoryWriteTier) {
    if (writeTier === "documented") {
      const explicitKey = input.documentKey ?? (typeof input.metadata?.documentKey === "string" ? input.metadata.documentKey : null);
      await this.options.memoryService.ingestEvent({
        userId: this.options.userId,
        scopeId: this.options.scopeId,
        type: "document",
        source: input.source ?? "sdk",
        key: explicitKey ?? this.deriveDocumentKey(input.message),
        content: input.message
      });
      return;
    }

    await this.options.memoryService.ingestEvent({
      userId: this.options.userId,
      scopeId: this.options.scopeId,
      type: "stream",
      source: input.source ?? "sdk",
      content: input.message
    });
  }

  private deriveDocumentKey(message: string) {
    return `runtime:${createHash("sha1").update(message).digest("hex").slice(0, 12)}`;
  }

  private normalizeWriteDecision(decision: MemoryWriteTier | MemoryWriteDecision): MemoryWriteDecision {
    if (typeof decision === "string") {
      return { tier: decision };
    }
    return decision;
  }

  private normalizeDigestDecision(
    decision: boolean | { shouldDigest: boolean; reason?: string }
  ): { shouldDigest: boolean; reason?: string } {
    if (typeof decision === "boolean") {
      return { shouldDigest: decision };
    }
    return decision;
  }

  private buildEvidence(recall: ResolvedRecall): GroundingEvidence {
    return buildGroundingEvidence(recall);
  }

  private async generateGroundedAnswer(question: string, recall: ResolvedRecall) {
    const userPrompt = this.options.prompts.user
      .replaceAll("{{question}}", question)
      .replaceAll("{{currentTurn}}", question)
      .replaceAll("{{digest}}", recall.digest?.summary ?? "(none)")
      .replaceAll("{{workingMemory}}", recall.fastLayerContext?.workingMemoryBlock ?? "(none)")
      .replaceAll("{{stableState}}", recall.fastLayerContext?.stableStateBlock ?? "(none)")
      .replaceAll("{{retrieval}}", recall.fastLayerContext?.retrievalBlock ?? "(none)")
      .replaceAll("{{recentTurns}}", recall.fastLayerContext?.recentTurnsBlock ?? "(none)")
      .replaceAll("{{fastSystemContext}}", recall.fastLayerContext?.systemContext ?? "(none)")
      .replaceAll(
        "{{events}}",
        recall.events.map((event) => `- ${event.createdAt.toISOString()}: ${event.content}`).join("\n") || "(no events)"
      );

    const messages: Array<{ role: "system" | "user"; content: string }> = [
      { role: "system", content: this.options.prompts.system },
      { role: "user", content: userPrompt }
    ];
    const primaryOptions: LlmChatOptions = {
      maxOutputTokens: this.options.runtimeResponseOptions?.maxOutputTokens ?? FAST_LAYER_MAX_OUTPUT_TOKENS,
      reasoningEffort: this.options.runtimeResponseOptions?.reasoningEffort ?? "low"
    };

    try {
      return await this.options.llm.chat(messages, primaryOptions);
    } catch (error) {
      if (!isEmptyContentError(error)) {
        throw error;
      }
      return this.options.llm.chat(messages, {
        reasoningEffort: primaryOptions.reasoningEffort
      });
    }
  }
}
