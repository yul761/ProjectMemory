import { z } from "zod";
import type { Digest, MemoryEvent, ProjectScope } from "./index";

export type MemoryEventKind = "decision" | "constraint" | "todo" | "note" | "status" | "question" | "noise";

export interface EventFeatures {
  kind: MemoryEventKind;
  importanceScore: number;
  noveltyScore: number;
  docKey?: string;
  references?: string[];
}

export interface DigestState {
  stableFacts: {
    goal?: string;
    constraints?: string[];
    decisions: string[];
  };
  workingNotes: {
    openQuestions?: string[];
    risks?: string[];
    context?: string;
  };
  todos: string[];
  volatileContext?: string[];
  evidenceRefs?: DigestEvidenceRef[];
  confidence?: {
    goal?: number;
    constraints?: DigestStateValueConfidence[];
    decisions?: DigestStateValueConfidence[];
    todos?: DigestStateValueConfidence[];
    volatileContext?: DigestStateValueConfidence[];
    openQuestions?: DigestStateValueConfidence[];
    risks?: DigestStateValueConfidence[];
  };
  provenance?: {
    goal?: DigestEvidenceRef[];
    constraints?: DigestStateValueProvenance[];
    decisions?: DigestStateValueProvenance[];
    todos?: DigestStateValueProvenance[];
    volatileContext?: DigestStateValueProvenance[];
    openQuestions?: DigestStateValueProvenance[];
    risks?: DigestStateValueProvenance[];
  };
  transitionSummary?: Record<string, number>;
  recentChanges?: DigestStateChange[];
  factRegistry?: FactRegistryEntry[];
}

export interface FactRegistryEntry {
  id: string;
  content: string;
  type: "decision" | "constraint";
  confidence: number;
  addedAt: string;
  evidenceId: string;
  evidenceType: "event" | "document";
  supersededBy?: string;
}

export interface DigestEvidenceRef {
  id: string;
  sourceType: "document" | "event";
  key?: string;
  kind?: MemoryEventKind;
}

export interface DigestStateValueProvenance {
  value: string;
  refs: DigestEvidenceRef[];
}

export interface DigestStateValueConfidence {
  value: string;
  score: number;
}

export interface DigestStateChange {
  field: "goal" | "constraints" | "decisions" | "todos" | "volatileContext" | "openQuestions" | "risks";
  action: "set" | "add" | "remove" | "reaffirm";
  value: string;
  evidence: DigestEvidenceRef;
}

export interface SelectedEvent {
  event: MemoryEvent;
  features: EventFeatures;
}

export interface SelectionResult {
  selectedEvents: SelectedEvent[];
  documents: MemoryEvent[];
  includeLastDigest: boolean;
  rationale: string[];
}

export interface DeltaCandidate {
  eventId: string;
  reason: string;
  features: EventFeatures;
  event: MemoryEvent;
}

export interface DigestControlConfig {
  eventBudgetTotal: number;
  eventBudgetDocs: number;
  eventBudgetStream: number;
  noveltyThreshold: number;
  maxRetries: number;
  useLlmClassifier: boolean;
  debug: boolean;
}

export interface DigestOutput {
  goal?: string;
  summary: string;
  changes: string[];
  nextSteps: string[];
}

export interface DigestConsistencyResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export const DigestOutputSchema = z.object({
  goal: z.string().optional(),
  summary: z.string(),
  changes: z.array(z.string()),
  nextSteps: z.array(z.string())
});

const DEFAULT_DIGEST_STATE: DigestState = {
  stableFacts: { decisions: [] },
  workingNotes: {},
  todos: [],
  volatileContext: [],
  evidenceRefs: [],
  confidence: {},
  provenance: {},
  transitionSummary: {},
  recentChanges: [],
  factRegistry: []
};

function deriveStateFromDigest(digest?: Digest | null): DigestState | null {
  if (!digest) return null;
  const decisions = digest.changes
    .split("\n")
    .map((line) => line.replace(/^-\s*/, "").trim())
    .filter((line) => /\b(decide|decision|we will|agreed)\b/i.test(line));
  const constraints = digest.changes
    .split("\n")
    .map((line) => line.replace(/^-\s*/, "").trim())
    .filter((line) => /\b(constraint|blocked|limitation)\b/i.test(line));
  return {
    stableFacts: {
      goal: parseGoal(digest.summary),
      constraints,
      decisions
    },
    workingNotes: {},
    todos: digest.nextSteps ?? [],
    volatileContext: [],
    evidenceRefs: [],
    confidence: {},
    provenance: {},
    transitionSummary: {},
    recentChanges: []
  };
}

function normalizeEvidenceRef(ref: string | DigestEvidenceRef): DigestEvidenceRef {
  if (typeof ref === "string") {
    return {
      id: ref,
      sourceType: ref.startsWith("doc:") ? "document" : "event",
      ...(ref.startsWith("doc:") ? { key: ref } : {})
    };
  }
  return {
    id: ref.id,
    sourceType: ref.sourceType,
    key: ref.key,
    kind: ref.kind
  };
}

export function normalizeDigestState(state?: DigestState | null): DigestState {
  const base = JSON.parse(JSON.stringify(state ?? DEFAULT_DIGEST_STATE)) as DigestState & {
    evidenceRefs?: Array<string | DigestEvidenceRef>;
    confidence?: {
      goal?: number;
      constraints?: Array<{ value?: string; score?: number }>;
      decisions?: Array<{ value?: string; score?: number }>;
      todos?: Array<{ value?: string; score?: number }>;
      volatileContext?: Array<{ value?: string; score?: number }>;
      openQuestions?: Array<{ value?: string; score?: number }>;
      risks?: Array<{ value?: string; score?: number }>;
    };
    provenance?: {
      goal?: Array<string | DigestEvidenceRef>;
      constraints?: Array<{ value?: string; refs?: Array<string | DigestEvidenceRef> }>;
      decisions?: Array<{ value?: string; refs?: Array<string | DigestEvidenceRef> }>;
      todos?: Array<{ value?: string; refs?: Array<string | DigestEvidenceRef> }>;
      volatileContext?: Array<{ value?: string; refs?: Array<string | DigestEvidenceRef> }>;
      openQuestions?: Array<{ value?: string; refs?: Array<string | DigestEvidenceRef> }>;
      risks?: Array<{ value?: string; refs?: Array<string | DigestEvidenceRef> }>;
    };
    recentChanges?: Array<{ field?: DigestStateChange["field"]; action?: DigestStateChange["action"]; value?: string; evidence?: string | DigestEvidenceRef }>;
  };
  return {
    stableFacts: {
      goal: base.stableFacts?.goal,
      constraints: [...new Set(base.stableFacts?.constraints ?? [])],
      decisions: [...new Set(base.stableFacts?.decisions ?? [])]
    },
    workingNotes: {
      openQuestions: [...new Set(base.workingNotes?.openQuestions ?? [])].slice(-25),
      risks: [...new Set(base.workingNotes?.risks ?? [])].slice(-25),
      context: base.workingNotes?.context
    },
    todos: [...new Set(base.todos ?? [])],
    volatileContext: [...new Set(base.volatileContext ?? [])].slice(-25),
    evidenceRefs: [...new Map((base.evidenceRefs ?? []).map((ref) => {
      const normalized = normalizeEvidenceRef(ref);
      return [`${normalized.sourceType}:${normalized.id}:${normalized.key ?? ""}:${normalized.kind ?? ""}`, normalized];
    })).values()].slice(-50),
    confidence: {
      goal: computeGoalConfidence(base.provenance?.goal),
      constraints: buildConfidenceList(base.provenance?.constraints, base.confidence?.constraints),
      decisions: buildConfidenceList(base.provenance?.decisions, base.confidence?.decisions),
      todos: buildConfidenceList(base.provenance?.todos, base.confidence?.todos),
      volatileContext: buildConfidenceList(base.provenance?.volatileContext, base.confidence?.volatileContext),
      openQuestions: buildConfidenceList(base.provenance?.openQuestions, base.confidence?.openQuestions),
      risks: buildConfidenceList(base.provenance?.risks, base.confidence?.risks)
    },
    provenance: {
      goal: [...new Map(((base.provenance?.goal ?? []) as Array<string | DigestEvidenceRef>).map((ref) => {
        const normalized = normalizeEvidenceRef(ref);
        return [`${normalized.sourceType}:${normalized.id}:${normalized.key ?? ""}:${normalized.kind ?? ""}`, normalized];
      })).values()],
      constraints: normalizeValueProvenanceList(base.provenance?.constraints),
      decisions: normalizeValueProvenanceList(base.provenance?.decisions),
      todos: normalizeValueProvenanceList(base.provenance?.todos),
      volatileContext: normalizeValueProvenanceList(base.provenance?.volatileContext),
      openQuestions: normalizeValueProvenanceList(base.provenance?.openQuestions),
      risks: normalizeValueProvenanceList(base.provenance?.risks)
    },
    transitionSummary: normalizeTransitionSummary((base as { transitionSummary?: Record<string, number> }).transitionSummary),
    recentChanges: normalizeRecentChanges(base.recentChanges),
    factRegistry: (base as DigestState).factRegistry ?? []
  };
}

function normalizeTransitionSummary(summary?: Record<string, number> | null) {
  return Object.fromEntries(
    Object.entries(summary ?? {})
      .filter((entry): entry is [string, number] => typeof entry[0] === "string" && entry[0].length > 0 && Number.isFinite(entry[1]) && entry[1] > 0)
      .map(([key, count]): [string, number] => [key, Number(count)])
      .sort(([a], [b]) => a.localeCompare(b))
  );
}

function normalizeValueProvenanceList(entries?: Array<{ value?: string; refs?: Array<string | DigestEvidenceRef> }> | null) {
  const normalized = (entries ?? [])
    .map((entry) => ({
      value: entry?.value?.trim() ?? "",
      refs: [...new Map((entry?.refs ?? []).map((ref) => {
        const item = normalizeEvidenceRef(ref);
        return [`${item.sourceType}:${item.id}:${item.key ?? ""}:${item.kind ?? ""}`, item];
      })).values()]
    }))
    .filter((entry) => entry.value);

  return [...new Map(normalized.map((entry) => [normalizeText(entry.value), entry])).values()].slice(-50);
}

function normalizeRecentChanges(entries?: Array<{
  field?: DigestStateChange["field"];
  action?: DigestStateChange["action"];
  value?: string;
  evidence?: string | DigestEvidenceRef;
}> | null): DigestStateChange[] {
  return (entries ?? [])
    .map((entry) => {
      if (!entry?.field || !entry?.action || !entry?.value || !entry?.evidence) return null;
      return {
        field: entry.field,
        action: entry.action,
        value: entry.value.trim(),
        evidence: normalizeEvidenceRef(entry.evidence)
      };
    })
    .filter((entry): entry is DigestStateChange => Boolean(entry))
    .slice(-25);
}

function normalizeConfidenceList(entries?: Array<{ value?: string; score?: number }> | null) {
  return (entries ?? [])
    .map((entry) => ({
      value: entry?.value?.trim() ?? "",
      score: Number.isFinite(entry?.score) ? Math.max(0, Math.min(1, Number(entry?.score))) : 0
    }))
    .filter((entry) => entry.value)
    .slice(-50);
}

function normalizeText(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9\s:]/g, " ").replace(/\s+/g, " ").trim();
}

function tokenize(value: string) {
  const normalized = normalizeText(value);
  return normalized
    .split(" ")
    .map((token) => token.replace(/:+$/g, ""))
    .filter((token) => token.length > 2)
    .map((token) => {
      if (token === "docs" || token === "doc") return "documentation";
      if (token === "blocker") return "blocked";
      return token;
    });
}

function jaccardSimilarity(a: string, b: string) {
  const tokensA = new Set(tokenize(a));
  const tokensB = new Set(tokenize(b));
  if (tokensA.size === 0 && tokensB.size === 0) return 1;
  const intersection = [...tokensA].filter((token) => tokensB.has(token)).length;
  const union = new Set([...tokensA, ...tokensB]).size;
  return union === 0 ? 0 : intersection / union;
}

function evidenceWeight(ref: DigestEvidenceRef) {
  return ref.sourceType === "document" ? 1 : 0.7;
}

function scoreEvidenceConfidence(refs?: DigestEvidenceRef[] | null) {
  const unique = [...new Map((refs ?? []).map((ref) => [`${ref.sourceType}:${ref.id}:${ref.key ?? ""}:${ref.kind ?? ""}`, ref])).values()];
  if (!unique.length) return 0;
  return Number(Math.max(...unique.map((ref) => evidenceWeight(ref))).toFixed(3));
}

function computeGoalConfidence(refs?: Array<string | DigestEvidenceRef> | null) {
  if (!Array.isArray(refs) || refs.length === 0) return undefined;
  return scoreEvidenceConfidence(refs.map((ref) => normalizeEvidenceRef(ref)));
}

function buildConfidenceList(
  provenanceEntries?: Array<{ value?: string; refs?: Array<string | DigestEvidenceRef> }> | null,
  fallbackEntries?: Array<{ value?: string; score?: number }> | null
) {
  const provenance = normalizeValueProvenanceList(provenanceEntries);
  if (provenance.length) {
    return provenance.map((entry) => ({
      value: entry.value,
      score: scoreEvidenceConfidence(entry.refs)
    }));
  }
  return normalizeConfidenceList(fallbackEntries);
}

function sameDedupeGroup(a: MemoryEvent, b: MemoryEvent) {
  return a.type === b.type && (a.key ?? "") === (b.key ?? "");
}

function compareEventDesc(a: MemoryEvent, b: MemoryEvent) {
  const timeDiff = b.createdAt.getTime() - a.createdAt.getTime();
  if (timeDiff !== 0) return timeDiff;
  return b.id.localeCompare(a.id);
}

function compareEventAsc(a: MemoryEvent, b: MemoryEvent) {
  const timeDiff = a.createdAt.getTime() - b.createdAt.getTime();
  if (timeDiff !== 0) return timeDiff;
  return a.id.localeCompare(b.id);
}

function extractKind(content: string): MemoryEventKind {
  const text = content.toLowerCase();
  if (/^assistant reply\s*:/i.test(content.trim())) return "noise";
  if (/^(what|which)\b.*\b(open question|questions|risks|risk|decide|decision|remembered|state|context)\b/i.test(content.trim())) {
    return "noise";
  }
  if (/\b(decide|decision|we will|agreed|approved)\b/.test(text)) return "decision";
  if (/\b(constraint|limitation|cannot|must not)\b/.test(text)) return "constraint";
  if (/\b(todo|next step|action item|follow up|follow-up)\b/.test(text)) return "todo";
  if (/\b(question|\?)\b/.test(text)) return "question";
  if (/\b(progress|status|done|shipped|completed|finished)\b/.test(text)) return "status";
  if (text.length < 8 || /^(ok|thanks|noted|lol)$/.test(text.trim())) return "noise";
  return "note";
}

function importanceForKind(kind: MemoryEventKind, content: string) {
  const keywordBoost = /\b(decide|decision|constraint|blocked|todo|next)\b/i.test(content) ? 0.15 : 0;
  const base: Record<MemoryEventKind, number> = {
    decision: 0.85,
    constraint: 0.8,
    todo: 0.7,
    status: 0.55,
    question: 0.5,
    note: 0.45,
    noise: 0.05
  };
  return Math.min(1, base[kind] + keywordBoost);
}

function makeFeatures(event: MemoryEvent): EventFeatures {
  const kind = extractKind(event.content);
  return {
    kind,
    importanceScore: importanceForKind(kind, event.content),
    noveltyScore: 0,
    docKey: event.key ?? undefined
  };
}

function shouldPreserveDurablePair(existing: MemoryEvent, candidate: MemoryEvent) {
  const existingKind = makeFeatures(existing).kind;
  const candidateKind = makeFeatures(candidate).kind;
  if (existingKind !== candidateKind) return false;
  if (existingKind === "decision" || existingKind === "todo") {
    return !decisionValuesAreComparable(existing.content, candidate.content);
  }
  return false;
}

function dedupeConsecutiveEvents(events: MemoryEvent[], rationale: string[]) {
  const output: MemoryEvent[] = [];
  let prev: MemoryEvent | null = null;
  for (const event of events) {
    const preserveDurablePair = prev ? shouldPreserveDurablePair(prev, event) : false;
    if (!preserveDurablePair && prev && sameDedupeGroup(prev, event) && jaccardSimilarity(prev.content, event.content) >= 0.92) {
      rationale.push(`dedup:${event.id}`);
      continue;
    }
    output.push(event);
    prev = event;
  }
  return output;
}

function dedupeNearDuplicateEvents(events: MemoryEvent[], rationale: string[]) {
  const kept: MemoryEvent[] = [];
  for (const event of events) {
    const duplicate = kept.find(
      (existing) => {
        if (shouldPreserveDurablePair(existing, event)) {
          return false;
        }
        return sameDedupeGroup(existing, event) && jaccardSimilarity(existing.content, event.content) >= 0.92;
      }
    );
    if (duplicate) {
      rationale.push(`dedup_near:${event.id}`);
      continue;
    }
    kept.push(event);
  }
  return kept;
}

function latestDocumentsByKey(events: MemoryEvent[]) {
  const map = new Map<string, MemoryEvent>();
  for (const event of events) {
    if (event.type !== "document" || !event.key) continue;
    if (!map.has(event.key)) {
      map.set(event.key, event);
    }
  }
  return [...map.values()];
}

export function selectEventsForDigest(input: {
  lastDigest?: Digest | null;
  recentEvents: MemoryEvent[];
  eventBudgetTotal: number;
  eventBudgetDocs: number;
  eventBudgetStream: number;
}): SelectionResult {
  const rationale: string[] = [];
  const sorted = [...input.recentEvents].sort(compareEventDesc);
  const dedupedConsecutive = dedupeConsecutiveEvents(sorted, rationale);
  const deduped = dedupeNearDuplicateEvents(dedupedConsecutive, rationale);

  const docs = latestDocumentsByKey(deduped)
    .sort(compareEventDesc)
    .slice(0, input.eventBudgetDocs);

  const docsById = new Set(docs.map((doc) => doc.id));
  const newestTs = deduped[0]?.createdAt.getTime() ?? Date.now();
  const oldestTs = deduped[deduped.length - 1]?.createdAt.getTime() ?? newestTs;
  const timeRange = Math.max(1, newestTs - oldestTs);
  const scoredStreamCandidates = deduped
    .filter((event) => !docsById.has(event.id) && event.type === "stream")
    .map((event) => {
      const features = makeFeatures(event);
      const recency = (event.createdAt.getTime() - oldestTs) / timeRange;
      const keywordBoost = /\b(decide|decision|we will|constraint|blocked|todo|next|risk|goal)\b/i.test(event.content) ? 0.1 : 0;
      const score = features.importanceScore * 0.7 + recency * 0.3 + keywordBoost;
      return { event, features, score };
    })
    .sort((a, b) => {
      const scoreDiff = b.score - a.score;
      if (scoreDiff !== 0) return scoreDiff;
      return compareEventDesc(a.event, b.event);
    });

  const durableKinds = new Set<MemoryEventKind>(["decision", "constraint", "todo"]);
  const durableStreamCandidates = scoredStreamCandidates.filter((candidate) => durableKinds.has(candidate.features.kind));
  const durableStreamIds = new Set(durableStreamCandidates.map((candidate) => candidate.event.id));
  const contextualStreamCandidates = scoredStreamCandidates
    .filter((candidate) => !durableStreamIds.has(candidate.event.id))
    .slice(0, input.eventBudgetStream);
  const streamCandidates = [...durableStreamCandidates, ...contextualStreamCandidates];

  const docSelected = docs.map((event) => ({ event, features: makeFeatures(event), score: 1 }));
  const merged = [...docSelected, ...streamCandidates]
    .slice(0, input.eventBudgetTotal)
    .map(({ event, features }) => ({ event, features }));

  rationale.push(`selected_docs:${docSelected.length}`);
  rationale.push(`selected_stream_durable:${durableStreamCandidates.length}`);
  rationale.push(`selected_stream:${Math.max(0, merged.length - docSelected.length)}`);
  if (input.lastDigest) {
    rationale.push("included_last_digest");
  }

  return {
    selectedEvents: merged,
    documents: docs,
    includeLastDigest: Boolean(input.lastDigest),
    rationale
  };
}

function noveltyAgainstDigest(content: string, lastDigestText: string) {
  const overlap = jaccardSimilarity(content, lastDigestText);
  return Math.max(0, 1 - overlap);
}

export function detectDeltas(input: {
  lastDigestText?: string;
  selectedEvents: SelectedEvent[];
  noveltyThreshold: number;
}): DeltaCandidate[] {
  const lastDigestText = input.lastDigestText ?? "";
  const deltas: DeltaCandidate[] = [];
  for (const selected of input.selectedEvents) {
    if (selected.event.type === "document") continue;
    if (selected.features.kind === "noise") continue;
    const novelty = noveltyAgainstDigest(selected.event.content, lastDigestText);
    selected.features.noveltyScore = novelty;
    const keep =
      selected.features.kind === "decision" ||
      selected.features.kind === "constraint" ||
      novelty >= input.noveltyThreshold;
    if (!keep) continue;
    deltas.push({
      eventId: selected.event.id,
      reason: selected.features.kind === "decision" || selected.features.kind === "constraint"
        ? "stable_fact_signal"
        : "novel_event",
      features: selected.features,
      event: selected.event
    });
  }
  return deltas;
}

function parseLinesWithPrefix(text: string, prefix: string) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.toLowerCase().startsWith(prefix.toLowerCase()))
    .map((line) => line.slice(prefix.length).trim())
    .filter(Boolean);
}

function parseGoal(text: string) {
  const line = text
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => /^goal\s*:/i.test(entry));
  if (!line) return undefined;
  const raw = line.replace(/^goal\s*:/i, "").trim();
  const sectionBoundary = raw.match(/^(.*?)(?:\.\s+(?:constraints?|decisions?|todos?|next steps?|(?:active\s+)?risks?|(?:open\s+)?questions?|changes?|status)\b.*)?$/i);
  return sectionBoundary?.[1]?.trim().replace(/\.$/, "") || undefined;
}

function cleanNaturalGoalPhrase(value: string) {
  return value
    .replace(/\b(?:without|while|but)\b.+$/i, "")
    .replace(/^to\s+/i, "")
    .replace(/\s+/g, " ")
    .replace(/[.?!]+$/g, "")
    .trim();
}

function extractNaturalGoal(text: string) {
  const lines = text
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean);

  for (const line of lines) {
    const match = line.match(
      /(?:^|[,:]\s*|\b)(?:i am|i'm)\s+trying\s+to\s+([^,.;?!]+)/i
    ) || line.match(
      /(?:^|[,:]\s*|\b)(?:i want to|i'd like to|i would like to|i need to|my goal is to|i'm looking to|i am looking to)\s+([^,.;?!]+)/i
    );

    if (match?.[1]) {
      return cleanNaturalGoalPhrase(match[1]);
    }
  }

  return undefined;
}

function findBestSemanticMatch(values: string[], candidate: string, threshold = 0.8) {
  let best: { value: string; score: number } | null = null;
  for (const value of values) {
    const score = normalizeText(value) === normalizeText(candidate) ? 1 : jaccardSimilarity(value, candidate);
    if (!best || score > best.score) {
      best = { value, score };
    }
  }
  return best && best.score >= threshold ? best.value : null;
}

function extractNumberTokens(value: string) {
  return normalizeText(value).match(/\b\d+\b/g) ?? [];
}

function decisionValuesAreComparable(existing: string, candidate: string) {
  const existingNumbers = extractNumberTokens(existing);
  const candidateNumbers = extractNumberTokens(candidate);
  if (existingNumbers.length || candidateNumbers.length) {
    return existingNumbers.join(",") === candidateNumbers.join(",");
  }
  return true;
}

function findBestDecisionMatch(values: string[], candidate: string, threshold = 0.8) {
  const comparableValues = values.filter((value) => decisionValuesAreComparable(value, candidate));
  return findBestSemanticMatch(comparableValues, candidate, threshold);
}

function decisionTopicTokens(value: string) {
  const stop = new Set([
    "we", "decide", "decided", "to", "the", "a", "an", "and", "or", "of", "for", "as",
    "on", "in", "into", "with", "that", "this", "is", "be", "keep"
  ]);
  return tokenize(value).filter((token) => token.length > 3 && !stop.has(token));
}

function decisionConflictDirection(value: string) {
  const lowered = normalizeText(value);
  if (/\b(merge|collapse|combine|single|one prompt path|same path)\b/.test(lowered)) return "collapse";
  if (/\b(boundary|separate|scoped|controlled digest pipeline|digest pipeline|layer|runtime diagnostics)\b/.test(lowered)) return "separate";
  return null;
}

function findConflictingDecision(values: string[], candidate: string) {
  const candidateDirection = decisionConflictDirection(candidate);
  if (!candidateDirection) return null;
  const candidateTokens = new Set(decisionTopicTokens(candidate));
  const architectureTokens = new Set(["memory", "layer", "layers", "runtime", "prompt", "boundary", "digest", "working", "state"]);
  const candidateArchitecture = [...candidateTokens].some((token) => architectureTokens.has(token));
  for (const value of values) {
    const existingDirection = decisionConflictDirection(value);
    if (!existingDirection || existingDirection === candidateDirection) continue;
    const valueTokens = decisionTopicTokens(value);
    const sharedTokens = valueTokens.filter((token) => candidateTokens.has(token));
    const existingArchitecture = valueTokens.some((token) => architectureTokens.has(token));
    if (sharedTokens.length >= 1 || (candidateArchitecture && existingArchitecture)) {
      return value;
    }
  }
  return null;
}

function findBestTodoMatch(values: string[], candidate: string, threshold = 0.8) {
  const normalizedCandidate = normalizeTodoFactText(candidate);
  const comparableValues = values.filter((value) =>
    decisionValuesAreComparable(normalizeTodoFactText(value), normalizedCandidate)
  );
  return findBestSemanticMatch(comparableValues.map(normalizeTodoFactText), normalizedCandidate, threshold)
    ? values.find((value) => normalizeText(normalizeTodoFactText(value)) === normalizeText(
      findBestSemanticMatch(comparableValues.map(normalizeTodoFactText), normalizedCandidate, threshold) ?? ""
    )) ?? null
    : null;
}

function stripDecisionRevocationPrefix(text: string) {
  return text
    .replace(/^\s*(revoke|undo|cancel decision|cancel|drop|remove)\s+/i, "")
    .trim();
}

function stripTodoRemovalPrefix(text: string) {
  return text
    .replace(/^\s*(done|completed|complete|cancel|remove|drop|close)\s+/i, "")
    .trim();
}

function stripStructuredLabel(text: string, labels: string[]) {
  if (!labels.length) return text.trim();
  const pattern = labels
    .map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  return text.replace(new RegExp(`^\\s*(?:${pattern})\\s*:\\s*`, "i"), "").trim();
}

function normalizeConstraintFactText(text: string) {
  return stripStructuredLabel(text, ["constraint"]).trim();
}

function normalizeTodoFactText(text: string) {
  return text.replace(/^\s*todo\s*:\s*/i, "").trim();
}

function isTransientCleanupTodo(text: string) {
  const normalized = normalizeTodoFactText(text).toLowerCase();
  return /\b(tmp|temporary|cleanup|clean old|sort .*logs?|rename .*screenshot|duplicate .*screenshot|duplicate .*notebook)\b/.test(normalized);
}

function stripWorkingNoteResolutionPrefix(text: string) {
  return text
    .replace(/^\s*(status update|status|question|note|risk)\s*[:\-]?\s*/i, "")
    .replace(/^\s*(we decide to|we decided to|we will|decision)\s+/i, "")
    .replace(/^\s*(resolved|answer(?:ed)?|clarified|decided|decision|fixed|mitigated|unblocked|cleared)\s*[:\-]?\s*/i, "")
    .replace(/\b(is now|now)\s+(resolved|fixed|mitigated|unblocked|cleared)\b/gi, "")
    .trim();
}

function findBestWorkingNoteMatch(values: string[] | undefined, candidate: string, threshold = 0.45) {
  const normalizedCandidate = stripWorkingNoteResolutionPrefix(candidate);
  let best: { value: string; score: number } | null = null;
  for (const value of values ?? []) {
    const normalizedValue = stripWorkingNoteResolutionPrefix(value);
    const score = normalizeText(normalizedValue) === normalizeText(normalizedCandidate)
      ? 1
      : jaccardSimilarity(normalizedValue, normalizedCandidate);
    if (!best || score > best.score) {
      best = { value, score };
    }
  }
  return best && best.score >= threshold ? best.value : null;
}

function upsertValueProvenance(
  entries: DigestStateValueProvenance[] | undefined,
  value: string,
  evidence: DigestEvidenceRef
) {
  const normalizedValue = normalizeText(value);
  const list = [...(entries ?? [])];
  const existing = list.find((entry) => normalizeText(entry.value) === normalizedValue);
  if (existing) {
    existing.refs = [...new Map([...existing.refs, evidence].map((ref) => [`${ref.sourceType}:${ref.id}:${ref.key ?? ""}:${ref.kind ?? ""}`, ref])).values()];
  } else {
    list.push({ value, refs: [evidence] });
  }
  return normalizeValueProvenanceList(list);
}

function setGoalProvenance(refs: DigestEvidenceRef[] | undefined, evidence: DigestEvidenceRef) {
  return [...new Map([...(refs ?? []), evidence].map((ref) => [`${ref.sourceType}:${ref.id}:${ref.key ?? ""}:${ref.kind ?? ""}`, ref])).values()];
}

function hasEvidenceRef(refs: DigestEvidenceRef[] | undefined, evidence: DigestEvidenceRef) {
  return (refs ?? []).some((ref) =>
    ref.id === evidence.id &&
    ref.sourceType === evidence.sourceType &&
    (ref.key ?? "") === (evidence.key ?? "") &&
    (ref.kind ?? "") === (evidence.kind ?? "")
  );
}

function valueHasEvidence(
  entries: DigestStateValueProvenance[] | undefined,
  value: string,
  evidence: DigestEvidenceRef
) {
  const normalizedValue = normalizeText(value);
  const existing = (entries ?? []).find((entry) => normalizeText(entry.value) === normalizedValue);
  return hasEvidenceRef(existing?.refs, evidence);
}

function replaceGoalProvenance(evidence: DigestEvidenceRef) {
  return [evidence];
}

function removeValueProvenance(
  entries: DigestStateValueProvenance[] | undefined,
  value: string
) {
  const normalizedValue = normalizeText(value);
  return normalizeValueProvenanceList((entries ?? []).filter((entry) => normalizeText(entry.value) !== normalizedValue));
}

function pushRecentChange(next: DigestState, change: DigestStateChange) {
  const transitionKey = `${change.field}:${change.action}`;
  next.transitionSummary = {
    ...(next.transitionSummary ?? {}),
    [transitionKey]: (next.transitionSummary?.[transitionKey] ?? 0) + 1
  };
  next.recentChanges = [...(next.recentChanges ?? []), change].slice(-25);
}

function removeWorkingNoteValue(input: {
  values: string[] | undefined;
  provenance: DigestStateValueProvenance[] | undefined;
  field: "openQuestions" | "risks";
  next: DigestState;
  evidence: DigestEvidenceRef;
  candidate: string;
  threshold?: number;
}) {
  const matched = findBestWorkingNoteMatch(input.values ?? [], input.candidate, input.threshold ?? 0.45);
  if (!matched) {
    return {
      values: input.values ?? [],
      provenance: input.provenance,
      removedValue: null
    };
  }
  pushRecentChange(input.next, { field: input.field, action: "remove", value: matched, evidence: input.evidence });
  return {
    values: (input.values ?? []).filter((item) => item !== matched),
    provenance: removeValueProvenance(input.provenance, matched),
    removedValue: matched
  };
}

function removeVolatileContextValue(input: {
  values: string[] | undefined;
  provenance: DigestStateValueProvenance[] | undefined;
  candidate: string;
  threshold?: number;
}) {
  const matched = findBestWorkingNoteMatch(input.values ?? [], input.candidate, input.threshold ?? 0.45);
  if (!matched) {
    return {
      values: input.values ?? [],
      provenance: input.provenance,
      removedValue: null
    };
  }
  return {
    values: (input.values ?? []).filter((item) => item !== matched),
    provenance: removeValueProvenance(input.provenance, matched),
    removedValue: matched
  };
}

function isInFactRegistry(state: DigestState, content: string): boolean {
  const norm = normalizeText(content);
  return (state.factRegistry ?? []).some(
    (entry) => !entry.supersededBy && jaccardSimilarity(normalizeText(entry.content), norm) >= 0.6
  );
}

export function getActiveFactRegistry(state: DigestState): FactRegistryEntry[] {
  return (state.factRegistry ?? []).filter((entry) => !entry.supersededBy);
}

function promoteToFactRegistry(
  state: DigestState,
  content: string,
  type: FactRegistryEntry["type"],
  confidence: number,
  evidence: DigestEvidenceRef
): void {
  if (!state.factRegistry) state.factRegistry = [];
  if (isInFactRegistry(state, content)) return;
  state.factRegistry.push({
    id: `fact-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    content,
    type,
    confidence,
    addedAt: new Date().toISOString(),
    evidenceId: evidence.id,
    evidenceType: evidence.sourceType
  });
}

function supersedeFact(state: DigestState, content: string, newContent: string, evidence: DigestEvidenceRef): void {
  if (!state.factRegistry) return;
  const norm = normalizeText(content);
  const toSupersede = state.factRegistry.find(
    (entry) => !entry.supersededBy && jaccardSimilarity(normalizeText(entry.content), norm) >= 0.6
  );
  if (!toSupersede) return;
  const newId = `fact-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  toSupersede.supersededBy = newId;
  state.factRegistry.push({
    id: newId,
    content: newContent,
    type: toSupersede.type,
    confidence: toSupersede.confidence,
    addedAt: new Date().toISOString(),
    evidenceId: evidence.id,
    evidenceType: evidence.sourceType
  });
}

function mergeGoalUpdate(next: DigestState, goal: string, evidence: DigestEvidenceRef) {
  const previousGoal = next.stableFacts.goal?.trim();
  if (!previousGoal) {
    next.stableFacts.goal = goal;
    next.provenance!.goal = replaceGoalProvenance(evidence);
    pushRecentChange(next, { field: "goal", action: "set", value: goal, evidence });
    return;
  }

  // Documents are authoritative; stream events require very high similarity to avoid
  // noisy conversation turns silently replacing the project goal.
  const isDocument = evidence.sourceType === "document";
  const overwriteThreshold = isDocument ? 0.7 : 0.95;
  const sameGoal =
    normalizeText(previousGoal) === normalizeText(goal) ||
    jaccardSimilarity(previousGoal, goal) >= overwriteThreshold;

  if (sameGoal) {
    if (!hasEvidenceRef(next.provenance?.goal, evidence)) {
      next.provenance!.goal = setGoalProvenance(next.provenance?.goal, evidence);
      pushRecentChange(next, { field: "goal", action: "reaffirm", value: previousGoal, evidence });
    }
    return;
  }

  // Stream events that diverge from the stable goal are logged but do not overwrite.
  if (!isDocument) {
    pushRecentChange(next, { field: "goal", action: "reaffirm", value: previousGoal, evidence });
    return;
  }

  pushRecentChange(next, { field: "goal", action: "remove", value: previousGoal, evidence });
  next.stableFacts.goal = goal;
  next.provenance!.goal = replaceGoalProvenance(evidence);
  pushRecentChange(next, { field: "goal", action: "set", value: goal, evidence });
}

function valuesBackedOnlyByDocumentKey(
  entries: DigestStateValueProvenance[] | undefined,
  documentKey: string
) {
  return (entries ?? [])
    .filter((entry) =>
      entry.refs.length > 0 &&
      entry.refs.every((ref) => ref.sourceType === "document" && ref.key === documentKey)
    )
    .map((entry) => entry.value);
}

function mergeDocumentBackedList(input: {
  currentValues: string[];
  currentProvenance: DigestStateValueProvenance[] | undefined;
  incomingValues: string[];
  evidence: DigestEvidenceRef;
  field: "constraints" | "decisions" | "todos";
  documentKey?: string;
  next: DigestState;
}) {
  const incoming = [...new Map(input.incomingValues.map((value) => [normalizeText(value), value])).values()];
  const existingByNormalized = new Map(input.currentValues.map((value) => [normalizeText(value), value]));

  if (input.documentKey) {
    const removableValues = valuesBackedOnlyByDocumentKey(input.currentProvenance, input.documentKey);
    for (const value of removableValues) {
      if (!incoming.some((candidate) => normalizeText(candidate) === normalizeText(value))) {
        input.currentValues.splice(input.currentValues.findIndex((item) => normalizeText(item) === normalizeText(value)), 1);
        input.currentProvenance = removeValueProvenance(input.currentProvenance, value);
        pushRecentChange(input.next, { field: input.field, action: "remove", value, evidence: input.evidence });
      }
    }
  }

  for (const value of incoming) {
    const existing = existingByNormalized.get(normalizeText(value))
      ?? (input.field === "decisions" ? findBestDecisionMatch(input.currentValues, value) : findBestSemanticMatch(input.currentValues, value));
    if (!existing) {
      input.currentValues.push(value);
      pushRecentChange(input.next, { field: input.field, action: "add", value, evidence: input.evidence });
      input.currentProvenance = upsertValueProvenance(input.currentProvenance, value, input.evidence);
      continue;
    }

    const sameValue = normalizeText(existing) === normalizeText(value) || jaccardSimilarity(existing, value) >= 0.8;
    if (sameValue && !valueHasEvidence(input.currentProvenance, existing, input.evidence)) {
      input.currentProvenance = upsertValueProvenance(input.currentProvenance, existing, input.evidence);
      pushRecentChange(input.next, { field: input.field, action: "reaffirm", value: existing, evidence: input.evidence });
    }
  }

  return {
    values: [...new Set(input.currentValues)],
    provenance: input.currentProvenance
  };
}

export function protectedStateMerge(input: {
  prevState?: DigestState | null;
  deltaCandidates: DeltaCandidate[];
  documents: MemoryEvent[];
}): DigestState {
  const next = normalizeDigestState(input.prevState ?? DEFAULT_DIGEST_STATE);
  next.stableFacts.decisions = next.stableFacts.decisions ?? [];
  next.stableFacts.constraints = next.stableFacts.constraints ?? [];
  next.todos = next.todos ?? [];
  next.volatileContext = next.volatileContext ?? [];
  next.evidenceRefs = next.evidenceRefs ?? [];
  next.provenance = next.provenance ?? {};
  next.transitionSummary = next.transitionSummary ?? {};
  next.recentChanges = next.recentChanges ?? [];
  next.transitionSummary = {};
  next.recentChanges = [];
  const resolvedQuestionKeys = new Set<string>();
  const resolvedRiskKeys = new Set<string>();

  const docText = input.documents.map((doc) => doc.content).join("\n");
  const docGoal = parseGoal(docText);
  if (docGoal) {
    const evidence = input.documents[input.documents.length - 1]
      ? {
          id: input.documents[input.documents.length - 1].id,
          sourceType: "document" as const,
          key: input.documents[input.documents.length - 1].key ?? undefined
        }
      : null;
    if (evidence) {
      mergeGoalUpdate(next, docGoal, evidence);
    }
  }

  for (const doc of input.documents) {
    const docConstraints = parseLinesWithPrefix(doc.content, "constraint:");
    if (!docConstraints.length) continue;
    const mergedConstraints = mergeDocumentBackedList({
      currentValues: [...(next.stableFacts.constraints ?? [])],
      currentProvenance: next.provenance.constraints,
      incomingValues: docConstraints,
      evidence: { id: doc.id, sourceType: "document", key: doc.key ?? undefined },
      field: "constraints",
      documentKey: doc.key ?? undefined,
      next
    });
    next.stableFacts.constraints = mergedConstraints.values;
    next.provenance.constraints = mergedConstraints.provenance;
  }

  for (const doc of input.documents) {
    const docDecisions = parseLinesWithPrefix(doc.content, "decision:");
    if (!docDecisions.length) continue;
    const mergedDecisions = mergeDocumentBackedList({
      currentValues: [...(next.stableFacts.decisions ?? [])],
      currentProvenance: next.provenance.decisions,
      incomingValues: docDecisions,
      evidence: { id: doc.id, sourceType: "document", key: doc.key ?? undefined },
      field: "decisions",
      documentKey: doc.key ?? undefined,
      next
    });
    next.stableFacts.decisions = mergedDecisions.values;
    next.provenance.decisions = mergedDecisions.provenance;
  }

  for (const doc of input.documents) {
    const docTodos = parseLinesWithPrefix(doc.content, "todo:");
    if (!docTodos.length) continue;
    const mergedTodos = mergeDocumentBackedList({
      currentValues: [...(next.todos ?? [])],
      currentProvenance: next.provenance.todos,
      incomingValues: docTodos,
      evidence: { id: doc.id, sourceType: "document", key: doc.key ?? undefined },
      field: "todos",
      documentKey: doc.key ?? undefined,
      next
    });
    next.todos = mergedTodos.values;
    next.provenance.todos = mergedTodos.provenance;
  }

  for (const doc of input.documents) {
    next.evidenceRefs.push({
      id: doc.id,
      sourceType: "document",
      key: doc.key ?? undefined
    });
  }

  const orderedDeltas = [...input.deltaCandidates].sort(
    (a, b) => compareEventAsc(a.event, b.event)
  );

  // Snapshot factRegistry IDs from prevState — only these are write-protected from stream events
  const prevFactRegistryIds = new Set((next.factRegistry ?? []).map((e) => e.id));

  for (const delta of orderedDeltas) {
    const evidence = {
      id: delta.eventId,
      sourceType: "event" as const,
      kind: delta.features.kind
    };
    next.evidenceRefs.push(evidence);
    const text = delta.event.content.trim();
    const lowered = text.toLowerCase();
    const mentionedGoal = parseGoal(text) ?? extractNaturalGoal(text);

    if (mentionedGoal && delta.features.kind !== "noise") {
      mergeGoalUpdate(next, mentionedGoal, evidence);
    }

    if (delta.features.kind === "decision") {
      if (/\b(revoke|undo|cancel decision)\b/.test(lowered)) {
        const revokeTarget = stripDecisionRevocationPrefix(text);
        const matched = findBestDecisionMatch(next.stableFacts.decisions, revokeTarget, 0.45);
        if (matched) {
          const protectedByRegistry = (next.factRegistry ?? []).some(
            (e) => prevFactRegistryIds.has(e.id) && !e.supersededBy && jaccardSimilarity(normalizeText(e.content), normalizeText(matched)) >= 0.6
          );
          if (!protectedByRegistry) {
            next.stableFacts.decisions = next.stableFacts.decisions.filter((item) => item !== matched);
            next.provenance.decisions = removeValueProvenance(next.provenance.decisions, matched);
            pushRecentChange(next, { field: "decisions", action: "remove", value: matched, evidence });
          }
        }
      } else {
        const conflicting = findConflictingDecision(next.stableFacts.decisions, text);
        if (conflicting) {
          const protectedByRegistry = (next.factRegistry ?? []).some(
            (e) => prevFactRegistryIds.has(e.id) && !e.supersededBy && jaccardSimilarity(normalizeText(e.content), normalizeText(conflicting)) >= 0.6
          );
          if (!protectedByRegistry) {
            next.stableFacts.decisions = next.stableFacts.decisions.filter((item) => item !== conflicting);
            next.provenance.decisions = removeValueProvenance(next.provenance.decisions, conflicting);
            pushRecentChange(next, { field: "decisions", action: "remove", value: conflicting, evidence });
          }
        }
        const existing = findBestDecisionMatch(next.stableFacts.decisions, text);
        if (!existing) {
          next.stableFacts.decisions.push(text);
          pushRecentChange(next, { field: "decisions", action: "add", value: text, evidence });
          next.provenance.decisions = upsertValueProvenance(next.provenance.decisions, text, evidence);
          if (delta.features.importanceScore >= 0.7) {
            promoteToFactRegistry(next, text, "decision", delta.features.importanceScore, evidence);
          }
        } else if (!valueHasEvidence(next.provenance.decisions, existing, evidence)) {
          pushRecentChange(next, { field: "decisions", action: "reaffirm", value: existing, evidence });
          next.provenance.decisions = upsertValueProvenance(next.provenance.decisions, existing, evidence);
        }
      }

      const resolvedQuestion = removeWorkingNoteValue({
        values: next.workingNotes.openQuestions,
        provenance: next.provenance.openQuestions,
        field: "openQuestions",
        next,
        evidence,
        candidate: stripWorkingNoteResolutionPrefix(text) || text,
        threshold: 0.35
      });
      next.workingNotes.openQuestions = resolvedQuestion.values.slice(-10);
      next.provenance.openQuestions = resolvedQuestion.provenance;
      if (resolvedQuestion.removedValue) {
        resolvedQuestionKeys.add(normalizeText(stripWorkingNoteResolutionPrefix(resolvedQuestion.removedValue) || resolvedQuestion.removedValue));
      }
    }

    if (delta.features.kind === "constraint" && delta.features.importanceScore >= 0.75) {
      const normalizedConstraint = normalizeConstraintFactText(text);
      const existing = findBestSemanticMatch(next.stableFacts.constraints, normalizedConstraint);
      if (!existing) {
        next.stableFacts.constraints.push(normalizedConstraint);
        pushRecentChange(next, { field: "constraints", action: "add", value: normalizedConstraint, evidence });
        next.provenance.constraints = upsertValueProvenance(next.provenance.constraints, normalizedConstraint, evidence);
        promoteToFactRegistry(next, normalizedConstraint, "constraint", delta.features.importanceScore, evidence);
      } else if (!valueHasEvidence(next.provenance.constraints, existing, evidence)) {
        pushRecentChange(next, { field: "constraints", action: "reaffirm", value: existing, evidence });
        next.provenance.constraints = upsertValueProvenance(next.provenance.constraints, existing, evidence);
      }
    }

    if (delta.features.kind === "todo") {
      if (/\b(done|completed|complete|cancel|remove|drop|close)\b/.test(lowered)) {
        const removalTarget = stripTodoRemovalPrefix(text);
        const matched = findBestTodoMatch(next.todos, removalTarget, 0.45);
        if (matched) {
          next.todos = next.todos.filter((item) => item !== matched);
          next.provenance.todos = removeValueProvenance(next.provenance.todos, matched);
          pushRecentChange(next, { field: "todos", action: "remove", value: matched, evidence });
        }
      } else {
        const existing = findBestTodoMatch(next.todos, text);
        if (!existing) {
          next.todos.push(text);
          pushRecentChange(next, { field: "todos", action: "add", value: text, evidence });
          next.provenance.todos = upsertValueProvenance(next.provenance.todos, text, evidence);
        } else if (!valueHasEvidence(next.provenance.todos, existing, evidence)) {
          pushRecentChange(next, { field: "todos", action: "reaffirm", value: existing, evidence });
          next.provenance.todos = upsertValueProvenance(next.provenance.todos, existing, evidence);
        }
      }
    }

    if (delta.features.kind === "question") {
      const normalizedQuestion = normalizeText(stripWorkingNoteResolutionPrefix(text) || text);
      if (resolvedQuestionKeys.has(normalizedQuestion)) {
        continue;
      }
      const existing = findBestSemanticMatch(next.workingNotes.openQuestions ?? [], text, 0.7);
      if (!existing) {
        next.workingNotes.openQuestions = [...(next.workingNotes.openQuestions ?? []), text].slice(-10);
        next.provenance.openQuestions = upsertValueProvenance(next.provenance.openQuestions, text, evidence);
        pushRecentChange(next, { field: "openQuestions", action: "add", value: text, evidence });
      } else if (!valueHasEvidence(next.provenance.openQuestions, existing, evidence)) {
        next.provenance.openQuestions = upsertValueProvenance(next.provenance.openQuestions, existing, evidence);
        pushRecentChange(next, { field: "openQuestions", action: "reaffirm", value: existing, evidence });
      }
    }

    if ((delta.features.kind === "status" || delta.features.kind === "note") && !mentionedGoal) {
      const normalizedVolatile = normalizeText(stripWorkingNoteResolutionPrefix(text) || text);
      if (resolvedRiskKeys.has(normalizedVolatile)) {
        continue;
      }
      const existing = findBestSemanticMatch(next.volatileContext ?? [], text, 0.7);
      if (!existing) {
        next.volatileContext = [...(next.volatileContext ?? []), text].slice(-10);
        next.provenance.volatileContext = upsertValueProvenance(next.provenance.volatileContext, text, evidence);
        pushRecentChange(next, { field: "volatileContext", action: "add", value: text, evidence });
      } else if (!valueHasEvidence(next.provenance.volatileContext, existing, evidence)) {
        next.provenance.volatileContext = upsertValueProvenance(next.provenance.volatileContext, existing, evidence);
        pushRecentChange(next, { field: "volatileContext", action: "reaffirm", value: existing, evidence });
      }
    }

    if (
      (delta.features.kind === "decision" || delta.features.kind === "status" || delta.features.kind === "note") &&
      /\b(resolved|fixed|mitigated|unblocked|cleared)\b/.test(lowered)
    ) {
      const resolutionCandidate = stripWorkingNoteResolutionPrefix(text) || text;
      const resolvedRisk = removeWorkingNoteValue({
        values: next.workingNotes.risks,
        provenance: next.provenance.risks,
        field: "risks",
        next,
        evidence,
        candidate: resolutionCandidate,
        threshold: 0.35
      });
      next.workingNotes.risks = resolvedRisk.values.slice(-10);
      next.provenance.risks = resolvedRisk.provenance;
      if (resolvedRisk.removedValue) {
        resolvedRiskKeys.add(normalizeText(stripWorkingNoteResolutionPrefix(resolvedRisk.removedValue) || resolvedRisk.removedValue));
        const trimmedVolatile = removeVolatileContextValue({
          values: next.volatileContext,
          provenance: next.provenance.volatileContext,
          candidate: resolvedRisk.removedValue,
          threshold: 0.35
        });
        next.volatileContext = trimmedVolatile.values.slice(-10);
        next.provenance.volatileContext = trimmedVolatile.provenance;
      }
    }

    if (/\b(risk|blocked|blocker)\b/.test(lowered)) {
      const normalizedRisk = normalizeText(stripWorkingNoteResolutionPrefix(text) || text);
      if (resolvedRiskKeys.has(normalizedRisk)) {
        continue;
      }
      const existing = findBestSemanticMatch(next.workingNotes.risks ?? [], text, 0.7);
      if (!existing) {
        next.workingNotes.risks = [...(next.workingNotes.risks ?? []), text].slice(-10);
        next.provenance.risks = upsertValueProvenance(next.provenance.risks, text, evidence);
        pushRecentChange(next, { field: "risks", action: "add", value: text, evidence });
      } else if (!valueHasEvidence(next.provenance.risks, existing, evidence)) {
        next.provenance.risks = upsertValueProvenance(next.provenance.risks, existing, evidence);
        pushRecentChange(next, { field: "risks", action: "reaffirm", value: existing, evidence });
      }
    }
  }

  next.stableFacts.decisions = [...new Set(next.stableFacts.decisions)];
  next.stableFacts.constraints = [...new Set(next.stableFacts.constraints ?? [])];
  next.todos = [...new Set(next.todos)];
  next.volatileContext = [...new Set(next.volatileContext ?? [])].slice(-10);
  const normalized = normalizeDigestState(next);
  next.evidenceRefs = normalized.evidenceRefs;
  next.confidence = normalized.confidence;
  next.provenance = normalized.provenance;
  next.transitionSummary = normalized.transitionSummary;
  next.recentChanges = normalized.recentChanges;

  return next as DigestState;
}

const classifierSchema = z.array(z.object({
  id: z.string(),
  kind: z.enum(["decision", "constraint", "todo", "note", "status", "question", "noise"]),
  importanceScore: z.number().min(0).max(1)
}));

function renderTemplate(template: string, data: Record<string, string>) {
  let output = template;
  for (const [key, value] of Object.entries(data)) {
    output = output.replaceAll(`{{${key}}}`, value);
  }
  return output;
}

function parseJson<T>(raw: string): T | null {
  const match = raw.match(/[\[{][\s\S]*[\]}]/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as T;
  } catch {
    return null;
  }
}

export async function classifyEventsWithLlm(input: {
  selectedEvents: SelectedEvent[];
  llm: { chat: (messages: { role: "system" | "user"; content: string }[]) => Promise<string> };
  systemPrompt: string;
  userPromptTemplate: string;
}) {
  const eventText = input.selectedEvents
    .map((item) => `${item.event.id}: ${item.event.content}`)
    .join("\n");

  const userPrompt = renderTemplate(input.userPromptTemplate, { events: eventText });
  const raw = await input.llm.chat([
    { role: "system", content: input.systemPrompt },
    { role: "user", content: userPrompt }
  ]);

  const parsed = parseJson<unknown>(raw);
  const validated = classifierSchema.safeParse(parsed);
  if (!validated.success) return;

  const byId = new Map(validated.data.map((item) => [item.id, item]));
  for (const item of input.selectedEvents) {
    const found = byId.get(item.event.id);
    if (!found) continue;
    item.features.kind = found.kind;
    item.features.importanceScore = found.importanceScore;
  }
}

function wordsCount(text: string) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function normalizeBullet(text: string) {
  return normalizeText(text.replace(/^-\s*/, ""));
}

function mentionsValue(text: string, value: string, tokenCount = 3) {
  return mentionsFact(text, value, tokenCount);
}

function ensureSummaryGoal(summary: string, goal?: string) {
  if (!goal || mentionsValue(summary, goal, 3)) return summary;
  const prefix = `Goal: ${goal}. `;
  const merged = `${prefix}${summary}`.trim();
  if (wordsCount(merged) <= 120) return merged;
  return summary;
}

function appendSummarySentence(parts: string[], sentence: string) {
  if (!sentence.trim()) return;
  const candidate = [...parts, sentence].join(" ").trim();
  if (wordsCount(candidate) <= 120) {
    parts.push(sentence);
  }
}

function buildProjectedSummary(state: DigestState, fallbackSummary: string) {
  const parts: string[] = [];

  if (state.stableFacts.goal) {
    appendSummarySentence(parts, `Goal: ${state.stableFacts.goal}.`);
  }
  const constraints = state.stableFacts.constraints ?? [];
  if (constraints.length) {
    for (let count = constraints.length; count >= 1; count -= 1) {
      const sentence = `Constraints: ${constraints.slice(0, count).join("; ")}.`;
      const before = parts.length;
      appendSummarySentence(parts, sentence);
      if (parts.length > before) break;
    }
  }
  const decisions = state.stableFacts.decisions ?? [];
  if (decisions.length) {
    const recentDecisions = decisions.slice(-8);
    for (let count = recentDecisions.length; count >= 1; count -= 1) {
      const sentence = `Decisions: ${recentDecisions.slice(-count).join("; ")}.`;
      const before = parts.length;
      appendSummarySentence(parts, sentence);
      if (parts.length > before) break;
    }
  }

  const openQuestion = state.workingNotes.openQuestions?.[0];
  if (openQuestion) {
    appendSummarySentence(parts, `Open question: ${openQuestion}.`);
  }
  const risk = state.workingNotes.risks?.[0];
  if (risk) {
    appendSummarySentence(parts, `Active risk: ${risk}.`);
  }
  const projected = parts.join(" ").trim();
  if (projected) return projected;

  let summary = fallbackSummary.trim().replace(/\s+/g, " ");
  while (wordsCount(summary) > 120 && summary.includes(". ")) {
    summary = summary.split(". ").slice(0, -1).join(". ").trim();
  }
  const summaryWithGoal = ensureSummaryGoal(fallbackSummary, state.stableFacts.goal);
  return summaryWithGoal.trim();
}

function projectRecentChange(change: DigestStateChange) {
  switch (change.field) {
    case "decisions":
      if (change.action === "remove") return null;
      return `Decision: ${change.value}`;
    case "constraints":
      if (change.action === "remove") return null;
      return `Constraint: ${change.value}`;
    case "openQuestions":
      return change.action === "remove" ? `Resolved question: ${change.value}` : `Open question: ${change.value}`;
    case "risks":
      return change.action === "remove" ? `Risk cleared: ${change.value}` : `Risk: ${change.value}`;
    case "goal":
      return `Goal: ${change.value}`;
    case "todos":
      if (change.action !== "remove" && isTransientCleanupTodo(change.value)) return null;
      return change.action === "remove" ? `Todo completed: ${change.value}` : `Todo: ${change.value}`;
    default:
      return null;
  }
}

function selectAlignedChanges(output: DigestOutput, state: DigestState) {
  const combined = [output.summary, ...output.changes, ...output.nextSteps].join("\n");
  const recentCandidates = (state.recentChanges ?? [])
    .slice(-6)
    .reverse()
    .map((change) => {
      const value = projectRecentChange(change);
      if (!value) return null;
      const priorityMap: Record<DigestStateChange["field"], number> = {
        goal: 6,
        decisions: 5,
        constraints: 4,
        openQuestions: 4,
        risks: 3,
        todos: 2,
        volatileContext: 1
      };
      return {
        value,
        priority: priorityMap[change.field],
        key: normalizeBullet(value)
      };
    })
    .filter((item): item is { value: string; priority: number; key: string } => Boolean(item))
    .filter((item) => !mentionsValue(combined, item.value.replace(/^[^:]+:\s*/, ""), 3));

  const stateCandidates = [
    ...(state.stableFacts.decisions ?? []).slice(-1).map((value) => ({ value: `Decision: ${value}`, priority: 4 })),
    ...(state.workingNotes.openQuestions ?? []).slice(-1).map((value) => ({ value: `Open question: ${value}`, priority: 3 })),
    ...(state.workingNotes.risks ?? []).slice(-1).map((value) => ({ value: `Risk: ${value}`, priority: 3 })),
    ...(state.stableFacts.constraints ?? []).slice(-1).map((value) => ({ value: `Constraint: ${value}`, priority: 2 }))
  ]
    .map((item) => ({ ...item, key: normalizeBullet(item.value) }))
    .filter((item) => !mentionsValue(combined, item.value.replace(/^[^:]+:\s*/, ""), 3));

  const projected = [...recentCandidates, ...stateCandidates];
  if (projected.length > 0) {
    return [...new Map(projected
      .sort((a, b) => b.priority - a.priority)
      .map((item) => [item.key, item.value])
    ).values()].slice(0, 3);
  }

  return [...new Map(output.changes.map((value) => ({ value, key: normalizeBullet(value) }))
    .map((item) => [item.key, item.value])
  ).values()].slice(0, 3);
}

function canonicalizeNextStep(step: string) {
  const trimmed = step.trim().replace(/\.$/, "");
  const withoutPrefix = trimmed.replace(/^todo\s*:\s*/i, "").trim();
  return withoutPrefix ? withoutPrefix[0].toUpperCase() + withoutPrefix.slice(1) : "";
}

function selectAlignedNextSteps(output: DigestOutput, state: DigestState) {
  const steps: string[] = [];
  for (const todo of state.todos ?? []) {
    const normalized = canonicalizeNextStep(todo);
    if (normalized) steps.push(normalized);
  }
  const activeRisk = state.workingNotes.risks?.[0];
  if (activeRisk) {
    steps.push(`Investigate and resolve ${activeRisk}`);
  }
  const fallback = output.nextSteps.map(canonicalizeNextStep).filter(Boolean);
  const merged = steps.length ? steps : fallback;
  return [...new Map(merged.map((value) => [normalizeText(value), value])).values()].slice(0, 3);
}

function alignDigestWithState(output: DigestOutput, state: DigestState): DigestOutput {
  return {
    summary: buildProjectedSummary(state, output.summary),
    changes: selectAlignedChanges(output, state),
    nextSteps: selectAlignedNextSteps(output, state)
  };
}

function mentionsFactWithNegation(text: string, fact: string, negationPattern: RegExp) {
  const normalized = text.toLowerCase();
  const keyTokens = tokenize(fact).slice(0, 4);
  if (!keyTokens.length) return false;
  const mentionsFact = keyTokens.every((token) => normalized.includes(token));
  return mentionsFact && negationPattern.test(normalized);
}

function mentionsFact(text: string, fact: string, tokenCount = 3) {
  const normalized = text.toLowerCase();
  const keyTokens = tokenize(fact).slice(0, tokenCount);
  if (!keyTokens.length) return false;
  return keyTokens.every((token) => normalized.includes(token));
}

export function consistencyCheck(input: {
  output: DigestOutput;
  previousDigest?: Digest | null;
  protectedState: DigestState;
}): DigestConsistencyResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const parsed = DigestOutputSchema.safeParse(input.output);
  if (!parsed.success) {
    errors.push("invalid_output_schema");
    return { ok: false, errors, warnings };
  }

  if (wordsCount(input.output.summary) > 120) {
    errors.push("summary_too_long");
  }

  if (input.output.changes.length > 3) {
    errors.push("too_many_changes");
  }

  if (input.output.nextSteps.length < 1 || input.output.nextSteps.length > 3) {
    errors.push("invalid_next_steps_count");
  }

  const stableGoal = input.protectedState.stableFacts.goal;
  const mentionedGoal = parseGoal(input.output.summary);
  if (stableGoal && mentionedGoal && normalizeText(stableGoal) !== normalizeText(mentionedGoal)) {
    errors.push("goal_contradiction");
  }

  const summaryLower = input.output.summary.toLowerCase();
  const combinedText = [
    input.output.summary,
    ...input.output.changes,
    ...input.output.nextSteps
  ].join("\n").toLowerCase();
  if (stableGoal && !mentionedGoal && !mentionsFact(combinedText, stableGoal, 3)) {
    warnings.push("goal_omission");
  }

  const stableConstraints = input.protectedState.stableFacts.constraints ?? [];
  if (
    stableConstraints.length > 0 &&
    stableConstraints.every((constraint) => !mentionsFact(combinedText, constraint, 2))
  ) {
    warnings.push("constraint_omission");
  }
  const stableDecisions = input.protectedState.stableFacts.decisions ?? [];
  if (
    stableDecisions.length > 0 &&
    stableDecisions.every((decision) => !mentionsFact(combinedText, decision, 2))
  ) {
    warnings.push("decision_omission");
  }
  const stableTodos = input.protectedState.todos ?? [];
  if (
    stableTodos.length > 0 &&
    stableTodos.every((todo) => !mentionsFact(combinedText, normalizeTodoFactText(todo), 2))
  ) {
    warnings.push("todo_omission");
  }
  for (const constraint of stableConstraints) {
    const keyTokens = tokenize(constraint).slice(0, 3);
    if (!keyTokens.length) continue;
    const mentionsConstraint = keyTokens.every((token) => summaryLower.includes(token));
    if (/\b(remove|drop|lift|no longer|ignore)\b/.test(summaryLower) && mentionsConstraint) {
      errors.push("constraint_contradiction");
      break;
    }
  }

  const decisionNegation = /\b(revert|reverse|undo|cancel|drop|abandon|deprioritize|no longer|instead)\b/;
  for (const decision of stableDecisions) {
    if (mentionsFactWithNegation(combinedText, decision, decisionNegation)) {
      errors.push("decision_contradiction");
      break;
    }
  }

  const todoNegation = /\b(remove|delete|drop|cancel|skip|ignore|defer|deprioritize)\b/;
  for (const todo of stableTodos) {
    if (mentionsFactWithNegation(combinedText, normalizeTodoFactText(todo), todoNegation)) {
      errors.push("todo_contradiction");
      break;
    }
  }

  if (input.previousDigest) {
    const prevChanges = new Set(input.previousDigest.changes.split("\n").map(normalizeBullet).filter(Boolean));
    const nextChanges = new Set(input.output.changes.map(normalizeBullet).filter(Boolean));
    const allRepeated = nextChanges.size > 0 && [...nextChanges].every((change) => prevChanges.has(change));
    if (allRepeated) {
      errors.push("changes_repeated_from_previous_digest");
    }
  }

  const actionable = /^(add|build|create|define|deliver|document|fix|measure|review|ship|test|update|write|implement|refactor)\b/i;
  const vague = /^(clarify|improve|consider|optimize|iterate)\b/i;
  for (const step of input.output.nextSteps) {
    const normalized = step.trim();
    if (vague.test(normalized) && tokenize(normalized).length < 4) {
      errors.push("vague_next_step");
      continue;
    }
    if (!actionable.test(normalized) && tokenize(normalized).length < 4) {
      warnings.push("weak_next_step");
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

function formatProtectedState(state: DigestState) {
  return JSON.stringify(state, null, 2);
}

function formatDeltaCandidates(candidates: DeltaCandidate[]) {
  return candidates
    .map((candidate) => `- [${candidate.features.kind}] ${candidate.event.content}`)
    .join("\n");
}

function formatDocuments(docs: MemoryEvent[]) {
  return docs.map((doc) => `- ${doc.key ?? doc.id}: ${doc.content}`).join("\n");
}

export async function generateDigestStage2(input: {
  scope: ProjectScope;
  lastDigest?: Digest | null;
  protectedState: DigestState;
  deltaCandidates: DeltaCandidate[];
  documents: MemoryEvent[];
  llm: { chat: (messages: { role: "system" | "user"; content: string }[]) => Promise<string> };
  systemPrompt: string;
  userPromptTemplate: string;
  maxRetries: number;
}): Promise<DigestOutput> {
  const lastDigestText = input.lastDigest
    ? `Summary: ${input.lastDigest.summary}\nChanges: ${input.lastDigest.changes}\nNext steps: ${input.lastDigest.nextSteps.join(", ")}`
    : "(none)";

  let fixInstruction = "";
  let lastErrors: string[] = [];

  for (let attempt = 0; attempt <= input.maxRetries; attempt += 1) {
    const userPrompt = renderTemplate(input.userPromptTemplate, {
      scopeName: input.scope.name,
      scopeGoal: input.scope.goal ?? "(none)",
      scopeStage: input.scope.stage,
      lastDigest: lastDigestText,
      protectedState: formatProtectedState(input.protectedState),
      deltaCandidates: formatDeltaCandidates(input.deltaCandidates) || "(none)",
      documents: formatDocuments(input.documents) || "(none)"
    });

    const raw = await input.llm.chat([
      { role: "system", content: input.systemPrompt },
      { role: "user", content: `${userPrompt}\n${fixInstruction}` }
    ]);

    const parsed = parseJson<DigestOutput>(raw);
    const validated = DigestOutputSchema.safeParse(parsed);
    if (!validated.success) {
      lastErrors = ["invalid_json_output"];
      fixInstruction = `Fix output. Previous errors: ${lastErrors.join(", ")}. Return strict JSON only.`;
      continue;
    }

    const normalized: DigestOutput = {
      goal: validated.data.goal?.trim() || undefined,
      summary: validated.data.summary.trim(),
      changes: validated.data.changes.map((c) => c.trim()).filter(Boolean).slice(0, 3),
      nextSteps: validated.data.nextSteps.map((n) => n.trim()).filter(Boolean).slice(0, 3)
    };

    const aligned = alignDigestWithState(normalized, input.protectedState);

    const check = consistencyCheck({
      output: aligned,
      previousDigest: input.lastDigest,
      protectedState: input.protectedState
    });

    if (check.ok) return aligned;

    if (
      input.lastDigest &&
      check.errors.length === 1 &&
      check.errors[0] === "changes_repeated_from_previous_digest"
    ) {
      return {
        summary: input.lastDigest.summary,
        changes: [],
        nextSteps: input.lastDigest.nextSteps?.length
          ? input.lastDigest.nextSteps.slice(0, 3)
          : ["Review recent events for changes."]
      };
    }

    lastErrors = check.errors;
    fixInstruction = `Fix output. Previous errors: ${check.errors.join(", ")}. Ensure summary<=120 words, changes<=3, nextSteps actionable.`;
  }

  throw new Error(`digest_consistency_failed:${lastErrors.join("|")}`);
}

export async function runDigestControlPipeline(input: {
  scope: ProjectScope;
  lastDigest?: Digest | null;
  prevState?: DigestState | null;
  recentEvents: MemoryEvent[];
  llm: { chat: (messages: { role: "system" | "user"; content: string }[]) => Promise<string> };
  prompts: {
    digestStage2SystemPrompt: string;
    digestStage2UserPrompt: string;
    digestClassifySystemPrompt?: string;
    digestClassifyUserPrompt?: string;
  };
  config: DigestControlConfig;
}): Promise<{
  digest: DigestOutput;
  state: DigestState;
  selection: SelectionResult;
  deltas: DeltaCandidate[];
  metrics: Record<string, number>;
  consistency: DigestConsistencyResult;
}> {
  const metrics: Record<string, number> = {};

  if (input.lastDigest) {
    const hasNewEvents = input.recentEvents.some((event) => event.createdAt.getTime() > input.lastDigest!.createdAt.getTime());
    if (!hasNewEvents) {
      const state = normalizeDigestState(input.prevState ?? deriveStateFromDigest(input.lastDigest));
      const digest: DigestOutput = {
        summary: input.lastDigest.summary,
        changes: [],
        nextSteps: input.lastDigest.nextSteps?.slice(0, 3) ?? []
      };
      const consistency = consistencyCheck({
        output: digest,
        previousDigest: input.lastDigest,
        protectedState: state
      });
      metrics.selectionMs = 0;
      metrics.deltaMs = 0;
      metrics.mergeMs = 0;
      metrics.generationMs = 0;
      return {
        digest,
        state,
        selection: {
          selectedEvents: [],
          documents: [],
          includeLastDigest: true,
          rationale: ["no_new_events_since_last_digest"]
        },
        deltas: [],
        metrics,
        consistency
      };
    }
  }

  const tSelect = Date.now();
  const selection = selectEventsForDigest({
    lastDigest: input.lastDigest,
    recentEvents: input.recentEvents,
    eventBudgetTotal: input.config.eventBudgetTotal,
    eventBudgetDocs: input.config.eventBudgetDocs,
    eventBudgetStream: input.config.eventBudgetStream
  });
  metrics.selectionMs = Date.now() - tSelect;

  if (input.config.useLlmClassifier && input.prompts.digestClassifySystemPrompt && input.prompts.digestClassifyUserPrompt) {
    const tClassify = Date.now();
    await classifyEventsWithLlm({
      selectedEvents: selection.selectedEvents,
      llm: input.llm,
      systemPrompt: input.prompts.digestClassifySystemPrompt,
      userPromptTemplate: input.prompts.digestClassifyUserPrompt
    });
    metrics.classificationMs = Date.now() - tClassify;
  }

  const tDelta = Date.now();
  const lastDigestText = input.lastDigest
    ? [input.lastDigest.summary, input.lastDigest.changes, input.lastDigest.nextSteps.join(" ")].join("\n")
    : undefined;
  const deltas = detectDeltas({
    lastDigestText,
    selectedEvents: selection.selectedEvents,
    noveltyThreshold: input.config.noveltyThreshold
  });
  metrics.deltaMs = Date.now() - tDelta;

  const tMerge = Date.now();
  const state = protectedStateMerge({
    prevState: input.prevState ?? deriveStateFromDigest(input.lastDigest),
    deltaCandidates: deltas,
    documents: selection.documents
  });
  metrics.mergeMs = Date.now() - tMerge;

  const tGenerate = Date.now();
  const digest = await generateDigestStage2({
    scope: input.scope,
    lastDigest: input.lastDigest,
    protectedState: state,
    deltaCandidates: deltas,
    documents: selection.documents,
    llm: input.llm,
    systemPrompt: input.prompts.digestStage2SystemPrompt,
    userPromptTemplate: input.prompts.digestStage2UserPrompt,
    maxRetries: input.config.maxRetries
  });
  metrics.generationMs = Date.now() - tGenerate;

  const resolvedGoal = digest.goal?.trim() || input.scope.goal?.trim() || undefined;
  if (resolvedGoal && !state.stableFacts.goal) {
    state.stableFacts.goal = resolvedGoal;
  }

  const consistency = consistencyCheck({
    output: digest,
    previousDigest: input.lastDigest,
    protectedState: state
  });

  return { digest, state, selection, deltas, metrics, consistency };
}
