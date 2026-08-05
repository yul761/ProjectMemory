import { z } from "zod";
import type { Digest, MemoryEvent, ProjectScope } from "./index";
import { pruneForgottenFacts } from "./memory-facts";
import { stripInternalIds, consolidateChangedFacets } from "./facet-consolidation";
import { recordDrop, type DropRecord } from "./drop-log";
import { isRegisteredFacet, getFacetCap, isWriteProtectedFacet } from "./facet-registry";

function createDefaultIdFactory(): () => string {
  return () => `fact-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function createDefaultNowFactory(): () => string {
  return () => new Date().toISOString();
}

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
  /**
   * Facet name → fact lines. The keys come from the active facet pack, not from
   * this type: the engine stores and protects facts without knowing what the
   * facets mean. Existing data (an object keyed by the historical seven facets)
   * satisfies this shape as-is, so no migration is required.
   */
  profile?: Record<string, string[]>;
}

export interface FactRegistryEntry {
  id: string;
  content: string;
  type: "decision" | "constraint" | "profile";
  confidence: number;
  addedAt: string;
  evidenceId: string;
  evidenceType: "event" | "document";
  supersededBy?: string;
  facet?: string;
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
  /** Size ceiling for selected event content; guards the model context limit. */
  charBudgetTotal?: number;
  noveltyThreshold: number;
  maxRetries: number;
  useLlmClassifier: boolean;
  debug: boolean;
}

export interface DigestOutput {
  summary: string;
  changes: string[];
  nextSteps: string[];
  profileFacts?: { facet: string; value: string }[];
  /**
   * Present when the digest could not be generated cleanly and a fallback was
   * carried forward. Memory stays continuous; callers can surface or alert on
   * the degradation instead of it passing as a normal digest.
   */
  degraded?: { reason: string; errors: string[] };
}

export interface DigestConsistencyResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  /**
   * Human-readable detail for each error, in the same order as `errors`.
   *
   * The bare codes tell a retrying model *that* it contradicted something but
   * not what, so the retry is a re-roll rather than a correction. These name the
   * protected fact and the offending text so the fix instruction can be specific.
   */
  conflicts?: string[];
}

export const DigestOutputSchema = z.object({
  summary: z.string(),
  changes: z.array(z.string()),
  nextSteps: z.array(z.string()),
  profileFacts: z.array(z.object({
    facet: z.string(),
    value: z.string()
  })).optional()
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
  const changes = digest.changes ?? "";
  const decisions = changes
    .split("\n")
    .map((line) => line.replace(/^-\s*/, "").trim())
    .filter((line) => line.length > 0 && /\b(decide|decision|we will|agreed)\b/i.test(line));
  const constraints = changes
    .split("\n")
    .map((line) => line.replace(/^-\s*/, "").trim())
    .filter((line) => line.length > 0 && /\b(constraint|blocked|limitation)\b/i.test(line));
  // Return null if we can derive no meaningful state — forces fresh start from DEFAULT_DIGEST_STATE
  // rather than returning an empty shell that silently discards prior decisions.
  const goal = parseGoal(digest.summary);
  if (!goal && decisions.length === 0 && constraints.length === 0) return null;
  return {
    stableFacts: {
      goal,
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

function collectAllProvenanceRefIds(provenance?: DigestState["provenance"]): Set<string> {
  const ids = new Set<string>();
  const listFields = ["constraints", "decisions", "todos", "volatileContext", "openQuestions", "risks"] as const;
  for (const field of listFields) {
    for (const entry of (provenance?.[field] as Array<{ refs?: Array<string | DigestEvidenceRef> }> ?? [])) {
      for (const ref of entry.refs ?? []) {
        ids.add(typeof ref === "string" ? ref : ref.id);
      }
    }
  }
  for (const ref of (provenance?.goal ?? []) as Array<string | DigestEvidenceRef>) {
    ids.add(typeof ref === "string" ? ref : ref.id);
  }
  return ids;
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
      constraints: [...new Set(base.stableFacts?.constraints ?? [])].slice(-100),
      decisions: [...new Set(base.stableFacts?.decisions ?? [])].slice(-100)
    },
    workingNotes: {
      openQuestions: [...new Set(base.workingNotes?.openQuestions ?? [])].slice(-10),
      risks: [...new Set(base.workingNotes?.risks ?? [])].slice(-10),
      context: base.workingNotes?.context
    },
    todos: [...new Set(base.todos ?? [])],
    volatileContext: [...new Set(base.volatileContext ?? [])].slice(-10),
    evidenceRefs: (() => {
      const provenanceRefIds = collectAllProvenanceRefIds(base.provenance);
      return [...new Map((base.evidenceRefs ?? []).map((ref) => {
        const normalized = normalizeEvidenceRef(ref);
        return [`${normalized.sourceType}:${normalized.id}:${normalized.key ?? ""}:${normalized.kind ?? ""}`, normalized];
      })).values()]
        // Only prune orphan event refs when provenance is present — if empty, this is a legacy
        // pre-provenance state and we cannot distinguish orphans from un-tracked refs.
        .filter((ref) => ref.sourceType === "document" || provenanceRefIds.size === 0 || provenanceRefIds.has(ref.id))
        .slice(-50);
    })(),
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
    factRegistry: ((base as DigestState).factRegistry ?? [])
      .filter((entry) => !entry.supersededBy)
      .slice(-100),
    profile: normalizeProfile((base as DigestState).profile)
  };
}

/**
 * Trims each facet to the active pack's cap.
 *
 * This used to enumerate the seven personal facets with their caps inline — a
 * sixth copy of the ontology — which also meant any facet outside that list was
 * dropped here even after passing every other gate. It now keeps whatever the
 * state carries and only enforces capacity.
 */
function normalizeProfile(profile?: Record<string, string[]>): Record<string, string[]> | undefined {
  if (!profile) return undefined;
  const out: Record<string, string[]> = {};
  for (const [facet, values] of Object.entries(profile)) {
    out[facet] = (values ?? []).slice(0, getFacetCap(facet));
  }
  return out;
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
  // CJK path: extract bigrams/unigrams from lowercased text BEFORE normalizeText strips CJK chars.
  // Mirrors RetrieveService.tokenize in packages/core/src/index.ts.
  const lower = value.toLowerCase();
  const cjkTokens: string[] = [];
  const runs = lower.match(/[一-鿿぀-ヿ가-힯]+/g) ?? [];
  for (const run of runs) {
    if (run.length === 1) {
      cjkTokens.push(run); // single-char run: keep as unigram
      continue;
    }
    for (let i = 0; i < run.length - 1; i += 1) {
      cjkTokens.push(run.slice(i, i + 2)); // overlapping step-1 bigram
    }
  }
  // ASCII path: normalizeText strips CJK to spaces, then we tokenize as before.
  const normalized = normalizeText(value);
  const asciiTokens = normalized
    .split(" ")
    .map((token) => token.replace(/:+$/g, ""))
    .filter((token) => token.length > 2)
    .map((token) => {
      if (token === "docs" || token === "doc") return "documentation";
      if (token === "blocker") return "blocked";
      return token;
    });
  // CJK tokens are appended after ASCII tokens and bypass the length > 2 filter
  // (2-char bigrams would otherwise be dropped).
  return [...asciiTokens, ...cjkTokens];
}

function jaccardSimilarity(a: string, b: string) {
  const tokensA = new Set(tokenize(a));
  const tokensB = new Set(tokenize(b));
  if (tokensA.size === 0 && tokensB.size === 0) return 0;
  const intersection = [...tokensA].filter((token) => tokensB.has(token)).length;
  const union = new Set([...tokensA, ...tokensB]).size;
  return union === 0 ? 0 : intersection / union;
}

/**
 * ASCII-only content tokens derived using the SAME path as tokenize()'s ASCII branch:
 * normalizeText → split → strip trailing colons → filter length > 2 → apply synonyms.
 * This guarantees the ascii-content set is a strict subset of jaccardSimilarity's token set,
 * so if jaccard(a, b) >= threshold for English, the shared tokens are also in both ascii sets
 * → sets intersect → asciiContentDiverges returns false → guard is a true no-op for English.
 * CJK chars are stripped to spaces by normalizeText and never enter the ascii set — the
 * PostgreSQL-vs-MySQL divergence guard for CJK is fully preserved.
 */
function asciiContentTokens(s: string): Set<string> {
  const normalized = normalizeText(s);
  return new Set(
    normalized
      .split(/\s+/)
      .map((token) => token.replace(/:+$/g, ""))
      .filter((token) => token.length > 2)
      .map((token) => {
        if (token === "docs" || token === "doc") return "documentation";
        if (token === "blocker") return "blocked";
        return token;
      })
  );
}

/**
 * Returns true iff BOTH strings have ≥ 1 ASCII content token AND their ASCII token sets
 * are completely disjoint. Pure-CJK facts (no ASCII tokens in either string) return false
 * so the guard is a no-op for fully Chinese content — bigrams remain the only signal.
 * Errs toward "distinct": a definite ASCII difference overrides bigram similarity.
 */
function asciiContentDiverges(a: string, b: string): boolean {
  const tokA = asciiContentTokens(a);
  const tokB = asciiContentTokens(b);
  if (tokA.size === 0 || tokB.size === 0) return false;
  return [...tokA].every((t) => !tokB.has(t));
}

/**
 * CJK-aware "same fact" predicate used at precision-critical sites (factRegistry, identity
 * protection). Passes RAW strings to jaccardSimilarity so CJK bigrams are used, then guards
 * against the over-merge case where shared bigrams mask divergent ASCII content
 * (e.g. 我决定用PostgreSQL vs 我决定用MySQL → bigram Jaccard ≈ 0.6 but ASCII sets disjoint).
 * For English-only facts this is a no-op: tokenize() normalises ASCII internally, and
 * asciiContentDiverges returns false when both sets share at least one token.
 */
export function sameFactCjkAware(a: string, b: string, threshold: number): boolean {
  return jaccardSimilarity(a, b) >= threshold && !asciiContentDiverges(a, b);
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

export function extractKind(content: string): MemoryEventKind {
  const text = content.toLowerCase();
  if (/^assistant reply\s*:/i.test(content.trim())) return "noise";
  if (/^(what|which)\b.*\b(open question|questions|risks|risk|decide|decision|remembered|state|context)\b/i.test(content.trim())) {
    return "noise";
  }
  if (/\b(decide|decision|we will|agreed|approved|we should use|should use|let'?s go with|going forward)\b/.test(text)) return "decision";
  if (/\b(constraint|limitation|cannot|must not|must\s+(?!not\b)\w+|no\s+\w+(?:\s+\w+)*\s+allowed|need to keep)/.test(text)) return "constraint";
  if (/\b(todo|next step|action item|follow up|follow-up|let'?s add|make sure to|need to (write|add|create|implement|test|document))\b/.test(text)) return "todo";
  if (/\b(question|\?)\b/.test(text)) return "question";
  if (/\b(progress|status|done|shipped|completed|finished)\b/.test(text)) return "status";
  if (text.length < 8 || /^(ok|thanks|noted|lol)$/.test(text.trim())) return "noise";
  return "note";
}

export function importanceForKind(kind: MemoryEventKind, content: string) {
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

/** ~4 chars/token, so this is roughly a 60k-token prompt budget for the events. */
export const DEFAULT_DIGEST_CHAR_BUDGET = 240_000;

/** Marker appended to an event whose content had to be cut to fit the budget. */
const TRUNCATION_MARKER = "\n…[truncated for digest budget]";

/**
 * Second budget pass, by size rather than count.
 *
 * The count budget alone cannot bound the prompt: 40 events is tiny when they
 * are chat turns and enormous when they are documents. Ingesting a folder of
 * markdown (the documented `ingest:docs` path) produced a 366k-token prompt
 * against a 272k-token model limit, and the digest job then failed outright —
 * leaving the scope with no state at all. Truncating is strictly better than
 * losing the whole digest, so oversized content is cut rather than dropped, and
 * at least one event always survives.
 */
function applyCharBudget(
  events: SelectedEvent[],
  charBudget: number,
  rationale: string[]
): SelectedEvent[] {
  if (charBudget <= 0) return events;
  const total = events.reduce((sum, { event }) => sum + event.content.length, 0);
  if (total <= charBudget) return events;

  const kept: SelectedEvent[] = [];
  let used = 0;
  let truncated = 0;
  for (const selected of events) {
    const remaining = charBudget - used;
    // Always keep the first event, even if it alone exceeds the budget.
    if (remaining <= 0 && kept.length > 0) break;
    const len = selected.event.content.length;
    if (len <= remaining) {
      kept.push(selected);
      used += len;
      continue;
    }
    const room = Math.max(0, remaining - TRUNCATION_MARKER.length);
    kept.push({
      ...selected,
      event: {
        ...selected.event,
        content: selected.event.content.slice(0, Math.max(1, room)) + TRUNCATION_MARKER
      }
    });
    truncated += 1;
    break;
  }

  rationale.push(`char_budget_applied:${total}->${charBudget}`);
  rationale.push(`char_budget_dropped:${events.length - kept.length}`);
  if (truncated) rationale.push(`char_budget_truncated:${truncated}`);
  return kept;
}

export function selectEventsForDigest(input: {
  lastDigest?: Digest | null;
  recentEvents: MemoryEvent[];
  eventBudgetTotal: number;
  eventBudgetDocs: number;
  eventBudgetStream: number;
  /** Total characters of event content allowed into the digest prompt. */
  charBudgetTotal?: number;
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
  const merged = applyCharBudget(
    [...docSelected, ...streamCandidates]
      .slice(0, input.eventBudgetTotal)
      .map(({ event, features }) => ({ event, features })),
    input.charBudgetTotal ?? DEFAULT_DIGEST_CHAR_BUDGET,
    rationale
  );

  const mergedDurableCount = merged.filter(({ event }) => durableStreamIds.has(event.id)).length;
  rationale.push(`selected_docs:${docSelected.length}`);
  rationale.push(`selected_stream_durable:${mergedDurableCount}`);
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
    // Only use the exact-match shortcut when the normalized form is non-empty.
    // Pure-CJK strings both normalize to "" via normalizeText (CJK is stripped to spaces),
    // so we must fall through to jaccardSimilarity — which uses CJK bigrams — rather than
    // treating any two pure-CJK strings as identical.
    const normalizedValue = normalizeText(value);
    const normalizedCandidate = normalizeText(candidate);
    const score =
      normalizedValue.length > 0 && normalizedValue === normalizedCandidate
        ? 1
        : jaccardSimilarity(value, candidate);
    if (!best || score > best.score) {
      best = { value, score };
    }
  }
  return best && sameFactCjkAware(best.value, candidate, threshold) ? best.value : null;
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


function extractReplacementTarget(value: string): string | null {
  const lowered = value.toLowerCase();
  const patterns = [
    /\binstead\s+of\s+(.+?)(?:\s+(?:for|with|in|on|at|by|when|to)\b|[,.]|$)/i,
    /\breplace[sd]?\s+(.+?)(?:\s+with\b|[,.]|$)/i,
    /\bswitch(?:ing)?\s+(?:from|away\s+from)\s+(.+?)(?:\s+to\b|[,.]|$)/i,
    /\bmigrat(?:e|ing)\s+(?:from|away\s+from)\s+(.+?)(?:\s+to\b|[,.]|$)/i,
    /\bno\s+longer\s+(?:use|using)\s+(.+?)(?:[,.]|$)/i
  ];
  for (const pattern of patterns) {
    const m = lowered.match(pattern);
    if (m?.[1]?.trim()) return m[1].trim();
  }
  return null;
}

function findConflictingDecisions(values: string[], candidate: string): string[] {
  const replacementTarget = extractReplacementTarget(candidate);
  if (!replacementTarget) return [];

  // Use >= 2 so CJK bigrams (length 2) survive. ASCII tokens from tokenize() are already
  // length >= 3 (the ASCII path filters > 2), so this does not widen English false-positive risk.
  const targetTokens = new Set(tokenize(replacementTarget).filter((t) => t.length >= 2));
  if (targetTokens.size === 0) return [];

  return values.filter((value) => {
    const valueTokens = tokenize(value).filter((t) => t.length >= 2);
    return valueTokens.some((token) => targetTokens.has(token));
  });
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
  let best: { value: string; normalizedValue: string; score: number } | null = null;
  for (const value of values ?? []) {
    const normalizedValue = stripWorkingNoteResolutionPrefix(value);
    const normA = normalizeText(normalizedValue);
    const normB = normalizeText(normalizedCandidate);
    // Guard against the pure-CJK empty-normalisation pitfall (see findBestSemanticMatch).
    const score =
      normA.length > 0 && normA === normB
        ? 1
        : jaccardSimilarity(normalizedValue, normalizedCandidate);
    if (!best || score > best.score) {
      best = { value, normalizedValue, score };
    }
  }
  return best && sameFactCjkAware(best.normalizedValue, normalizedCandidate, threshold) ? best.value : null;
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
  return (state.factRegistry ?? []).some(
    (entry) => !entry.supersededBy && sameFactCjkAware(entry.content, content, 0.6)
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
  evidence: DigestEvidenceRef,
  makeId: () => string,
  facet?: string,
  makeNow: () => string = createDefaultNowFactory()
): void {
  if (!state.factRegistry) state.factRegistry = [];
  if (isInFactRegistry(state, content)) return;
  const entry: FactRegistryEntry = {
    id: makeId(),
    content,
    type,
    confidence,
    addedAt: makeNow(),
    evidenceId: evidence.id,
    evidenceType: evidence.sourceType
  };
  if (facet !== undefined) entry.facet = facet;
  state.factRegistry.push(entry);
}

function supersedeFact(
  state: DigestState,
  content: string,
  newContent: string,
  evidence: DigestEvidenceRef,
  makeId: () => string,
  overrides?: { facet?: string; confidence?: number; type?: FactRegistryEntry["type"] },
  makeNow: () => string = createDefaultNowFactory()
): void {
  if (!state.factRegistry) return;
  const toSupersede = state.factRegistry.find(
    (entry) => !entry.supersededBy && sameFactCjkAware(entry.content, content, 0.6)
  );
  if (!toSupersede) return;
  const newId = makeId();
  toSupersede.supersededBy = newId;
  const newEntry: FactRegistryEntry = {
    id: newId,
    content: newContent,
    type: overrides?.type ?? toSupersede.type,
    confidence: overrides?.confidence ?? toSupersede.confidence,
    addedAt: makeNow(),
    evidenceId: evidence.id,
    evidenceType: evidence.sourceType
  };
  if (overrides?.facet !== undefined) newEntry.facet = overrides.facet;
  state.factRegistry.push(newEntry);
}

// Facet routing table for Stage 2 (extends Stage 1).
// writeProtected=true: entry is promoted to factRegistry with `facet` tag;
//   stream events cannot override protected entries; cap eviction skips protected.
// writeProtected=false (VOLATILE): append/dedup via CJK-aware Jaccard; evictable at cap;
//   no factRegistry entry.
const PROFILE_FACET_ROUTING: Record<string, { facet: string; cap: number; writeProtected: boolean }> = {
  personal_detail: { facet: "identity", cap: 15, writeProtected: true },
  goal: { facet: "goals", cap: 8, writeProtected: true },
  life_decision: { facet: "goals", cap: 8, writeProtected: true },
  experience: { facet: "ongoing", cap: 8, writeProtected: false },
  person_note: { facet: "relationships", cap: 10, writeProtected: false },
  commitment: { facet: "followUps", cap: 10, writeProtected: false },
  style_preference: { facet: "style", cap: 6, writeProtected: false }
};

function mergeProfileFacets(
  state: DigestState,
  events: MemoryEvent[],
  prevFactRegistryIds: Set<string>,
  makeId: () => string,
  makeNow: () => string = createDefaultNowFactory(),
  dropLog?: DropRecord[]
): void {
  // Lazy-init guard: only initialise profile if at least one event is routable
  if (!events.some((e) => e.classifiedType != null && e.classifiedType in PROFILE_FACET_ROUTING)) return;
  if (!state.profile) state.profile = {};

  function isProtectedInFacet(facetName: string, fact: string): boolean {
    return (state.factRegistry ?? []).some(
      (e) =>
        prevFactRegistryIds.has(e.id) &&
        !e.supersededBy &&
        e.facet === facetName &&
        sameFactCjkAware(e.content, fact, 0.6)
    );
  }

  for (const evt of events) {
    const route = evt.classifiedType != null ? PROFILE_FACET_ROUTING[evt.classifiedType] : undefined;
    if (!route) continue;
    const incomingValue = evt.content.trim();
    if (!incomingValue) continue;

    const { facet, cap, writeProtected } = route;
    if (!state.profile[facet]) (state.profile as Record<string, string[]>)[facet] = [];
    const facetFacts: string[] = (state.profile as Record<string, string[]>)[facet]!;

    // Dedup: CJK-aware Jaccard >= 0.6 within facet
    const existingIdx = facetFacts.findIndex(
      (fact) => sameFactCjkAware(fact, incomingValue, 0.6)
    );

    if (existingIdx !== -1) {
      const existing = facetFacts[existingIdx];
      if (writeProtected && isProtectedInFacet(facet, existing)) continue; // write-protected — stream cannot override
      facetFacts[existingIdx] = incomingValue; // replace unprotected near-duplicate
      continue;
    }

    // Cap enforcement
    if (facetFacts.length >= cap) {
      if (writeProtected) {
        // Evict first unprotected entry; if all protected, discard incoming
        const unprotectedIdx = facetFacts.findIndex((fact) => !isProtectedInFacet(facet, fact));
        if (unprotectedIdx === -1) {
          // The "no drift" guarantee is being paid for with the "no forgetting"
          // guarantee here: the incoming fact loses to the protected ones.
          if (dropLog) recordDrop(dropLog, "cap_rejected_incoming", { facet, value: incomingValue, cap });
          continue;
        }
        const [evictedProtectedPath] = facetFacts.splice(unprotectedIdx, 1);
        if (evictedProtectedPath && dropLog) {
          recordDrop(dropLog, "cap_evicted", { facet, value: evictedProtectedPath, cap });
        }
      } else {
        // Volatile: evict first (index 0 = weakest/oldest)
        const [evictedVolatile] = facetFacts.splice(0, 1);
        if (evictedVolatile && dropLog) {
          recordDrop(dropLog, "cap_evicted", { facet, value: evictedVolatile, cap });
        }
      }
    }

    facetFacts.push(incomingValue);

    // Write-protect via factRegistry (write-protected facets only)
    if (writeProtected) {
      const evidence: DigestEvidenceRef = { id: evt.id, sourceType: "event" };
      promoteToFactRegistry(state, incomingValue, "profile", 0.7, evidence, makeId, facet, makeNow);
    }
  }
}


export function applyProfileFactsFromDigest(
  state: DigestState,
  profileFacts: { facet: string; value: string }[],
  documents: MemoryEvent[],
  streamEvidence: DigestEvidenceRef | null,
  makeId: () => string,
  makeNow: () => string = createDefaultNowFactory(),
  dropLog?: DropRecord[]
): void {
  if (profileFacts.length === 0) return;
  if (!state.profile) state.profile = {};

  const latestDoc = documents.length > 0 ? documents[documents.length - 1] : null;
  const docEvidence: DigestEvidenceRef | null = latestDoc
    ? { id: latestDoc.id, sourceType: "document", key: latestDoc.key ?? undefined }
    : null;

  for (const pf of profileFacts) {
    const facet = pf.facet.trim();
    const value = stripInternalIds(pf.value.trim());
    if (!value) continue;
    if (!isRegisteredFacet(facet)) {
      if (dropLog) recordDrop(dropLog, "facet_not_registered", { facet, value });
      continue;
    }

    // identity is document-authority; conversational facets prefer the stream-event ref
    // (it carries the actual conversation turn); fall back to a doc ref if no stream ref.
    const evidence: DigestEvidenceRef | null =
      facet === "identity" ? docEvidence : (streamEvidence ?? docEvidence);
    const authority = evidence?.sourceType === "document" ? 0.85 : 0.6;
    const cap = getFacetCap(facet);

    const profileMap = state.profile as Record<string, string[]>;
    if (!profileMap[facet]) profileMap[facet] = [];
    const facetFacts = profileMap[facet];

    const existingIdx = facetFacts.findIndex((fact) => sameFactCjkAware(fact, value, 0.6));
    if (existingIdx !== -1) {
      const existing = facetFacts[existingIdx];
      const contentChanged = existing.trim() !== value.trim();
      // supersedeFact re-stamps the registry entry's addedAt to "now", so it must only run
      // when something real changes: the content was corrected, or the evidence authority
      // increased (e.g. a stream-sourced fact later confirmed by a document). A plain
      // re-extraction of the same fact each digest run must NOT re-stamp it — otherwise every
      // stable fact reads as "just now" in the Memory list. (Evidence id changes every run,
      // so compare authority, not id.)
      if (evidence) {
        const activeEntry = (state.factRegistry ?? []).find(
          (e) => !e.supersededBy && e.type === "profile" && sameFactCjkAware(e.content, existing, 0.6)
        );
        const authorityIncreased = activeEntry !== undefined && authority > activeEntry.confidence;
        if (contentChanged || authorityIncreased) {
          supersedeFact(state, existing, value, evidence, makeId, { facet, confidence: authority, type: "profile" }, makeNow);
        }
      }
      if (contentChanged) facetFacts[existingIdx] = value;
      continue;
    }

    if (facetFacts.length >= cap) {
      if (isWriteProtectedFacet(facet)) {
        // Protected facets are high-value; don't evict one to make room.
        if (dropLog) recordDrop(dropLog, "cap_rejected_incoming", { facet, value, cap });
        continue;
      }
      const [evicted] = facetFacts.splice(0, 1); // volatile facets: evict oldest (index 0)
      if (evicted && dropLog) recordDrop(dropLog, "cap_evicted", { facet, value: evicted, cap });
      if (evicted && state.factRegistry) {
        const ri = state.factRegistry.findIndex(
          (e) => e.type === "profile" && e.facet === facet && !e.supersededBy && sameFactCjkAware(e.content, evicted, 0.6)
        );
        if (ri !== -1) state.factRegistry.splice(ri, 1);
      }
    }

    facetFacts.push(value);
    if (evidence) {
      promoteToFactRegistry(state, value, "profile", authority, evidence, makeId, facet, makeNow);
    }
  }
}

/**
 * Deterministically appends a user-supplied note to `state.profile.notes`.
 *
 * - Returns `false` (no-op) when an exactly-identical (normalized) note already exists.
 *   Explicit notes use EXACT normalized match (trim + collapse whitespace + lowercase)
 *   rather than fuzzy Jaccard dedup. The fuzzy tokenizer strips short numeric tokens
 *   (< 3 digits), so "API v1 key…" and "API v2 key…" would otherwise collapse to the
 *   same token set and be silently merged — losing user data.
 * - Enforces the `notes` cap (30); evicts the oldest entry (index 0) plus its
 *   factRegistry record when the cap is reached.
 * - Promotes the note to the factRegistry as a `profile/notes` entry with
 *   confidence 0.9 so it surfaces via `flattenScopeFacts` with its timestamp.
 * - Returns `true` when the note was successfully added.
 */
export function addNoteFact(
  state: DigestState,
  text: string,
  makeId: () => string,
  makeNow: () => string = createDefaultNowFactory()
): boolean {
  const value = text.trim();
  if (!value) return false;

  // Normalize helper: trim, collapse internal whitespace, lowercase.
  const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

  // Idempotency: no-op if an exactly-identical (normalized) note already exists.
  // Explicit notes must use exact match — fuzzy dedup would silently merge notes
  // differing only by short numeric tokens (e.g. "API v1 key…" vs "API v2 key…").
  const existingNotes = state.profile?.notes ?? [];
  if (existingNotes.some((note) => norm(note) === norm(value))) return false;

  // Lazy-init profile and notes array.
  if (!state.profile) state.profile = {};
  const profileMap = state.profile as Record<string, string[]>;
  if (!profileMap.notes) profileMap.notes = [];
  const notes = profileMap.notes;

  // Cap enforcement: evict oldest entry (index 0) + its factRegistry record.
  const cap = getFacetCap("notes");
  if (notes.length >= cap) {
    const [evicted] = notes.splice(0, 1);
    if (evicted && state.factRegistry) {
      // Use exact match here — the evicted note was stored verbatim and its
      // registry entry was added with exact-match semantics.
      const ri = state.factRegistry.findIndex(
        (e) => e.type === "profile" && e.facet === "notes" && !e.supersededBy && norm(e.content) === norm(evicted)
      );
      if (ri !== -1) state.factRegistry.splice(ri, 1);
    }
  }

  notes.push(value);

  // Promote to factRegistry so flattenScopeFacts surfaces createdAt + evidenceId.
  // Notes use exact-match dedup for the registry guard: the shared promoteToFactRegistry
  // helper calls isInFactRegistry which uses fuzzy Jaccard, which would prevent distinct
  // notes like "note-1" from being registered if a fuzzy-similar "note-0" already exists.
  // Instead, push directly with a facet-scoped exact-match guard.
  if (!state.factRegistry) state.factRegistry = [];
  const alreadyRegistered = state.factRegistry.some(
    (e) => !e.supersededBy && e.facet === "notes" && norm(e.content) === norm(value)
  );
  if (!alreadyRegistered) {
    const evidenceId = makeId();
    state.factRegistry.push({
      id: makeId(),
      content: value,
      type: "profile" as const,
      confidence: 0.9,
      addedAt: makeNow(),
      evidenceId,
      evidenceType: "event" as const,
      facet: "notes"
    });
  }

  return true;
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
  const overwriteThreshold = isDocument ? 0.85 : 0.95;
  // Guard against the pure-CJK "" === "" pitfall: normalizeText strips CJK to spaces,
  // so two completely different Chinese goals both normalise to "". Only treat the
  // normalised-text shortcut as a match when the normalised form is non-empty.
  const normPrev = normalizeText(previousGoal);
  const normGoal = normalizeText(goal);
  const sameGoal =
    (normPrev.length > 0 && normPrev === normGoal) ||
    jaccardSimilarity(previousGoal, goal) >= overwriteThreshold;

  if (sameGoal) {
    if (!hasEvidenceRef(next.provenance?.goal, evidence)) {
      next.provenance!.goal = setGoalProvenance(next.provenance?.goal, evidence);
      pushRecentChange(next, { field: "goal", action: "reaffirm", value: previousGoal, evidence });
    }
    return;
  }

  // Stream events that diverge from the stable goal do not overwrite.
  // Only log reaffirm when the stream-extracted goal is semantically related to the existing goal
  // (>= 0.3 Jaccard), so unrelated conversation turns don't pollute recentChanges.
  if (!isDocument) {
    if (jaccardSimilarity(previousGoal, goal) >= 0.3) {
      pushRecentChange(next, { field: "goal", action: "reaffirm", value: previousGoal, evidence });
    }
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
        const spliceIdx = input.currentValues.findIndex((item) => normalizeText(item) === normalizeText(value));
        if (spliceIdx >= 0) {
          input.currentValues.splice(spliceIdx, 1);
        }
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
  idFactory?: () => string;
  nowFactory?: () => string;
  dropLog?: DropRecord[];
}): DigestState {
  const makeId = input.idFactory ?? createDefaultIdFactory();
  const makeNow = input.nowFactory ?? createDefaultNowFactory();
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
            (e) => prevFactRegistryIds.has(e.id) && !e.supersededBy && sameFactCjkAware(e.content, matched, 0.6)
          );
          if (!protectedByRegistry) {
            next.stableFacts.decisions = next.stableFacts.decisions.filter((item) => item !== matched);
            next.provenance.decisions = removeValueProvenance(next.provenance.decisions, matched);
            pushRecentChange(next, { field: "decisions", action: "remove", value: matched, evidence });
          }
        }
      } else {
        const conflicting = findConflictingDecisions(next.stableFacts.decisions, text);
        for (const conflict of conflicting) {
          const protectedByRegistry = (next.factRegistry ?? []).some(
            (e) => prevFactRegistryIds.has(e.id) && !e.supersededBy && sameFactCjkAware(e.content, conflict, 0.6)
          );
          if (!protectedByRegistry) {
            next.stableFacts.decisions = next.stableFacts.decisions.filter((item) => item !== conflict);
            next.provenance.decisions = removeValueProvenance(next.provenance.decisions, conflict);
            pushRecentChange(next, { field: "decisions", action: "remove", value: conflict, evidence });
          }
        }
        const existing = findBestDecisionMatch(next.stableFacts.decisions, text);
        if (!existing) {
          next.stableFacts.decisions.push(text);
          pushRecentChange(next, { field: "decisions", action: "add", value: text, evidence });
          next.provenance.decisions = upsertValueProvenance(next.provenance.decisions, text, evidence);
          if (delta.features.importanceScore >= 0.7) {
            promoteToFactRegistry(next, text, "decision", delta.features.importanceScore, evidence, makeId, undefined, makeNow);
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
        promoteToFactRegistry(next, normalizedConstraint, "constraint", delta.features.importanceScore, evidence, makeId, undefined, makeNow);
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

  // Profile facet routing: personal_detail stream events → profile.identity (Stage 1)
  const streamEventsForProfile = input.deltaCandidates.map((d) => d.event);
  mergeProfileFacets(next, streamEventsForProfile, prevFactRegistryIds, makeId, makeNow, input.dropLog);

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

function buildProjectedSummary(state: DigestState, narrative: string) {
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

  const statePrefix = parts.join(" ").trim();

  // Append narrative on a separate line so parseGoal does not bleed into it.
  // Honours 120-word cap: only include narrative if combined length fits.
  const trimmedNarrative = narrative.trim();
  if (trimmedNarrative && statePrefix) {
    const combined = `${statePrefix}\n${trimmedNarrative}`;
    if (wordsCount(combined) <= 120) {
      return combined;
    }
    return statePrefix;
  }

  if (statePrefix) return statePrefix;

  // Fallback: state is empty, return narrative alone
  return trimmedNarrative;
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
    nextSteps: selectAlignedNextSteps(output, state),
    profileFacts: output.profileFacts
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

/**
 * Name the protected fact and quote the line that appears to negate it, so a
 * retry can correct that specific claim instead of regenerating blindly.
 */
function describeConflict(kind: string, fact: string, output: DigestOutput): string {
  const lines = [output.summary, ...output.changes, ...output.nextSteps];
  const keyTokens = tokenize(fact).slice(0, 3);
  const offending = lines.find((line) => {
    const lower = line.toLowerCase();
    return keyTokens.length > 0 && keyTokens.every((token) => lower.includes(token));
  });
  const clip = (s: string) => (s.length > 200 ? s.slice(0, 200) + "…" : s);
  return offending
    ? `protected ${kind} "${clip(fact)}" appears negated by: "${clip(offending)}"`
    : `protected ${kind} "${clip(fact)}" appears negated by the new digest`;
}

export function consistencyCheck(input: {
  output: DigestOutput;
  previousDigest?: Digest | null;
  protectedState: DigestState;
}): DigestConsistencyResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const conflicts: string[] = [];
  const note = (code: string, detail: string) => {
    errors.push(code);
    conflicts.push(detail);
  };

  const parsed = DigestOutputSchema.safeParse(input.output);
  if (!parsed.success) {
    errors.push("invalid_output_schema");
    return { ok: false, errors, warnings, conflicts };
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
  // Compare goals by their first sentence only: an LLM summary often appends prose
  // after the goal ("goal: X. Progress is steady."), which must not read as a goal
  // change. parseGoal stays lossless for goal STORAGE; only this contradiction
  // comparison is lenient to trailing sentences.
  // normalizeText removes periods, so split on the RAW string first, then normalize.
  const firstSentence = (s: string) => normalizeText(s.split(/\.\s+/)[0] ?? s);
  if (stableGoal && mentionedGoal && firstSentence(stableGoal) !== firstSentence(mentionedGoal)) {
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
      note("constraint_contradiction", describeConflict("constraint", constraint, input.output));
      break;
    }
  }

  const decisionNegation = /\b(revert|reverse|undo|cancel|drop|abandon|deprioritize|no longer|instead)\b/;
  for (const decision of stableDecisions) {
    if (mentionsFactWithNegation(combinedText, decision, decisionNegation)) {
      note("decision_contradiction", describeConflict("decision", decision, input.output));
      break;
    }
  }

  const todoNegation = /\b(remove|delete|drop|cancel|skip|ignore|defer|deprioritize)\b/;
  for (const todo of stableTodos) {
    if (mentionsFactWithNegation(combinedText, normalizeTodoFactText(todo), todoNegation)) {
      note("todo_contradiction", describeConflict("todo", todo, input.output));
      break;
    }
  }

  // Profile write-protected facets: check identity and goals facts in factRegistry.
  // Generalised to iterate all write-protected facets so adding new ones (Stage 3+) requires
  // only a PROFILE_FACET_ROUTING entry — no additional consistency-check wiring.
  // CJK chars have no ASCII word boundaries, so list them without \b anchors.
  const profileNegation = /\b(not|no longer|incorrect|wrong|remove|delete|revoke|cancel|never)\b|放弃|移除|错误|不再/;
  const writeProtectedFacets = Object.values(PROFILE_FACET_ROUTING)
    .filter((r) => r.writeProtected)
    .map((r) => r.facet);
  const checkedFacets = new Set<string>();
  for (const facetName of writeProtectedFacets) {
    if (checkedFacets.has(facetName)) continue;
    checkedFacets.add(facetName);
    const protectedFacts = (input.protectedState.factRegistry ?? [])
      .filter((e) => !e.supersededBy && e.facet === facetName)
      .map((e) => e.content);
    for (const fact of protectedFacts) {
      if (mentionsFactWithNegation(combinedText, fact, profileNegation)) {
        errors.push(`profile_${facetName}_contradiction`);
        break;
      }
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
    // English-only heuristics cannot evaluate CJK text — skip both checks for steps
    // containing CJK characters to avoid false positives on legitimate Chinese next-steps.
    const hasCjk = /[一-鿿぀-ヿ가-힯]/.test(normalized);
    if (!hasCjk && vague.test(normalized) && tokenize(normalized).length < 4) {
      errors.push("vague_next_step");
      continue;
    }
    if (!hasCjk && !actionable.test(normalized) && tokenize(normalized).length < 4) {
      warnings.push("weak_next_step");
    }
  }

  return { ok: errors.length === 0, errors, warnings, conflicts };
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

/**
 * Per-section ceiling for the stage-2 prompt.
 *
 * Sized against the SMALLEST context we expect to run on (gpt-4o-mini, 128k
 * tokens) rather than the largest: a budget tuned to a 272k-token model silently
 * becomes an overflow the moment someone points StateCore at a smaller one, and
 * the failure mode is a dead digest rather than a degraded one.
 */
const STAGE2_SECTION_CHAR_BUDGET = 60_000;

/**
 * Backstop on the fully assembled prompt. Per-section limits cannot bound the
 * total on their own -- the sections are capped independently, and any part not
 * routed through one of them (last digest, forgotten facts, fix instructions)
 * is unbounded. This is the last point before the model sees the text.
 * ~4 chars/token, so 320k chars is roughly 80k tokens: comfortable inside 128k.
 */
const STAGE2_TOTAL_CHAR_BUDGET = 320_000;

/**
 * Bounding `selectEventsForDigest` is not enough: the protected state is a full
 * JSON dump that re-expands event content across facets, and the delta list
 * carries raw content too, so either can outgrow the events they came from.
 * This is the single point where the prompt is actually handed to the model, so
 * it is the only place a size guard cannot be bypassed by an upstream path.
 *
 * A digest built from a clipped section is still a digest; blowing the context
 * limit fails the whole job and leaves the scope with no state at all.
 *
 * Line-oriented sections are safe to cut at a character offset. The protected
 * state is NOT — it is serialized JSON, and slicing it mid-structure hands the
 * model malformed input, which in practice produces output that then trips the
 * consistency gate. State is bounded structurally instead, before serializing.
 */
function clipSection(text: string, label: string, budget = STAGE2_SECTION_CHAR_BUDGET) {
  if (text.length <= budget) return text;
  // The marker stays in the prompt itself rather than going to a log: importing
  // the logger here would make digest-control depend on ./index at runtime, and
  // that import is deliberately type-only to avoid a cycle.
  const cut = text.lastIndexOf("\n", budget);
  return text.slice(0, cut > budget / 2 ? cut : budget)
    + `\n…[${label} clipped: ${text.length} chars exceeded ${budget}]`;
}

/** Trim a string array until its combined length fits, keeping entries intact. */
function boundStrings(values: string[] | undefined, budget: number): string[] | undefined {
  if (!values?.length) return values;
  const kept: string[] = [];
  let used = 0;
  for (const value of values) {
    if (used + value.length > budget) break;
    kept.push(value);
    used += value.length;
  }
  // Never return an empty list where there was content: one entry beats none.
  if (!kept.length) kept.push(values[0].slice(0, Math.max(1, budget)));
  return kept;
}

/**
 * Bound the protected state by dropping whole entries, so what reaches the model
 * is always valid JSON. Provenance/confidence/evidence are derived bookkeeping
 * and are dropped first — the facts themselves are what the digest reasons over.
 */
export function boundProtectedState(state: DigestState, budget = STAGE2_SECTION_CHAR_BUDGET): DigestState {
  if (JSON.stringify(state).length <= budget) return state;

  const share = Math.floor(budget / 4);
  const bounded: DigestState = {
    ...state,
    stableFacts: {
      goal: state.stableFacts.goal,
      constraints: boundStrings(state.stableFacts.constraints, share),
      decisions: boundStrings(state.stableFacts.decisions, share) ?? []
    },
    workingNotes: {
      ...state.workingNotes,
      openQuestions: boundStrings(state.workingNotes.openQuestions, share),
      risks: boundStrings(state.workingNotes.risks, share)
    },
    todos: boundStrings(state.todos, share) ?? [],
    volatileContext: boundStrings(state.volatileContext, share)
  };
  delete bounded.provenance;
  delete bounded.confidence;
  delete bounded.evidenceRefs;
  if (bounded.factRegistry) {
    const registry: FactRegistryEntry[] = [];
    let used = 0;
    for (const entry of bounded.factRegistry) {
      const size = JSON.stringify(entry).length;
      if (used + size > share) break;
      registry.push(entry);
      used += size;
    }
    bounded.factRegistry = registry;
  }
  return bounded;
}

/**
 * Negative instruction fed to the digest LLM: the user has explicitly forgotten these facts,
 * so the model must not re-extract them even if the source events reword or re-bucket them.
 *
 * This is the SEMANTIC guard for forget. The deterministic hash-based pruneForgottenFacts is a
 * verbatim (group|text) match, so any re-extraction with slightly different wording — or the same
 * text under a different display group — dodges it and the fact resurfaces. The LLM can recognise
 * "means the same thing" where the hash cannot, so we ask it to omit forgotten content at the
 * source; the hash prune remains the backstop for exact carry-forwards.
 */
function formatForgottenFacts(contents?: readonly string[]): string {
  const cleaned = [...new Set((contents ?? []).map((c) => c.trim()).filter(Boolean))];
  if (cleaned.length === 0) return "";
  const lines = cleaned.map((c) => `- ${c}`).join("\n");
  return (
    `\n\nFORGOTTEN BY THE USER — the user has explicitly deleted the following facts. Do NOT record, ` +
    `restate, or re-derive any of them, and reject anything that means the same thing even if the ` +
    `wording differs or it falls under a different category. Omit them entirely from the summary, ` +
    `changes, and profileFacts:\n${lines}\n`
  );
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
  forgottenFacts?: readonly string[];
}): Promise<DigestOutput> {
  const lastDigestText = input.lastDigest
    ? `Summary: ${input.lastDigest.summary}\nChanges: ${input.lastDigest.changes}\nNext steps: ${input.lastDigest.nextSteps.join(", ")}`
    : "(none)";
  const forgottenBlock = formatForgottenFacts(input.forgottenFacts);

  let fixInstruction = "";
  let lastErrors: string[] = [];

  for (let attempt = 0; attempt <= input.maxRetries; attempt += 1) {
    const userPrompt = renderTemplate(input.userPromptTemplate, {
      scopeName: input.scope.name,
      scopeGoal: input.scope.goal ?? "(none)",
      scopeStage: input.scope.stage,
      lastDigest: lastDigestText,
      protectedState: formatProtectedState(boundProtectedState(input.protectedState)),
      deltaCandidates: clipSection(formatDeltaCandidates(input.deltaCandidates), "deltaCandidates") || "(none)",
      documents: clipSection(formatDocuments(input.documents), "documents") || "(none)"
    });

    const assembled = clipSection(
      `${userPrompt}${forgottenBlock}\n${fixInstruction}`,
      "stage2 prompt",
      STAGE2_TOTAL_CHAR_BUDGET
    );

    const raw = await input.llm.chat([
      { role: "system", content: input.systemPrompt },
      { role: "user", content: assembled }
    ]);

    const parsed = parseJson<DigestOutput>(raw);
    const validated = DigestOutputSchema.safeParse(parsed);
    if (!validated.success) {
      lastErrors = ["invalid_json_output"];
      fixInstruction = `Fix output. Previous errors: ${lastErrors.join(", ")}. Return strict JSON only.`;
      continue;
    }

    const normalized: DigestOutput = {
      summary: validated.data.summary.trim(),
      changes: validated.data.changes.map((c) => c.trim()).filter(Boolean).slice(0, 3),
      nextSteps: validated.data.nextSteps.map((n) => n.trim()).filter(Boolean).slice(0, 3),
      profileFacts: (validated.data.profileFacts ?? [])
        .map((pf) => ({ facet: pf.facet.trim(), value: pf.value.trim() }))
        .filter((pf) => Boolean(pf.facet) && Boolean(pf.value))
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
    // Name what conflicted. "Previous errors: todo_contradiction" tells the model
    // nothing it can act on, so the retry just re-rolls; quoting the protected
    // fact and the offending line makes it a targeted correction.
    const detail = (check.conflicts ?? []).filter(Boolean);
    fixInstruction = detail.length
      ? `Fix output. The new digest conflicts with state the user has already established:\n`
        + detail.map((d) => `- ${d}`).join("\n")
        + `\nKeep those facts intact unless the source events explicitly revoke them. `
        + `Ensure summary<=120 words, changes<=3, nextSteps actionable.`
      : `Fix output. Previous errors: ${check.errors.join(", ")}. Ensure summary<=120 words, changes<=3, nextSteps actionable.`;
  }

  // Retries exhausted. Throwing here loses the whole digest — including every
  // fact that did NOT conflict — and leaves the scope with no state at all, which
  // is the opposite of the continuity the consistency gate exists to protect.
  // Carry the previous digest forward instead, flagged so the degradation is
  // visible rather than silent. Only a scope with no prior digest has nothing to
  // fall back to, and that case still fails loudly.
  if (input.lastDigest) {
    return {
      summary: input.lastDigest.summary,
      changes: [],
      nextSteps: input.lastDigest.nextSteps?.length
        ? input.lastDigest.nextSteps.slice(0, 3)
        : ["Review recent events for changes."],
      degraded: { reason: "consistency_failed", errors: lastErrors }
    };
  }

  // First digest for the scope: fall back to the protected state that the merge
  // already produced, so ingestion still yields usable memory instead of nothing.
  const projected = buildProjectedSummary(input.protectedState, "");
  if (projected) {
    return {
      summary: projected,
      changes: [],
      nextSteps: ["Review recent events for changes."],
      degraded: { reason: "consistency_failed_no_prior_digest", errors: lastErrors }
    };
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
    consolidateFacetSystemPrompt?: string;
    consolidateFacetUserPrompt?: string;
  };
  config: DigestControlConfig;
  forgottenFactKeys?: ReadonlySet<string>;
  forgottenFactContents?: readonly string[];
}): Promise<{
  digest: DigestOutput;
  state: DigestState;
  selection: SelectionResult;
  deltas: DeltaCandidate[];
  metrics: Record<string, number>;
  consistency: DigestConsistencyResult;
  /** Every piece of information this run discarded, and why. */
  dropLog: DropRecord[];
}> {
  const metrics: Record<string, number> = {};
  const dropLog: DropRecord[] = [];

  if (input.lastDigest) {
    const hasNewEvents = input.recentEvents.some((event) => event.createdAt.getTime() > input.lastDigest!.createdAt.getTime());
    if (!hasNewEvents) {
      const state = normalizeDigestState(input.prevState ?? deriveStateFromDigest(input.lastDigest));
      if (input.forgottenFactKeys && input.forgottenFactKeys.size > 0) {
        pruneForgottenFacts(state, input.forgottenFactKeys);
      }
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
        consistency,
        dropLog
      };
    }
  }

  const tSelect = Date.now();
  const selection = selectEventsForDigest({
    lastDigest: input.lastDigest,
    recentEvents: input.recentEvents,
    eventBudgetTotal: input.config.eventBudgetTotal,
    eventBudgetDocs: input.config.eventBudgetDocs,
    eventBudgetStream: input.config.eventBudgetStream,
    charBudgetTotal: input.config.charBudgetTotal
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
    documents: selection.documents,
    dropLog
  });
  metrics.mergeMs = Date.now() - tMerge;

  if (input.forgottenFactKeys && input.forgottenFactKeys.size > 0) {
    pruneForgottenFacts(state, input.forgottenFactKeys);
  }

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
    maxRetries: input.config.maxRetries,
    forgottenFacts: input.forgottenFactContents
  });
  metrics.generationMs = Date.now() - tGenerate;

  // Apply profile facts extracted by LLM from documents into stable state
  if (digest.profileFacts && digest.profileFacts.length > 0) {
    const streamEvents = deltas.map((d) => d.event).filter(Boolean);
    const latestStream = streamEvents.length > 0 ? streamEvents[streamEvents.length - 1] : null;
    const streamEvidence: DigestEvidenceRef | null = latestStream
      ? { id: latestStream.id, sourceType: "event" }
      : null;
    applyProfileFactsFromDigest(state, digest.profileFacts, selection.documents, streamEvidence, createDefaultIdFactory(), createDefaultNowFactory(), dropLog);
  }

  // Prune forgotten facts BEFORE consolidation: consolidation rewrites/merges fact text,
  // and the content-hash prune can only match exact text — so a re-extracted forgotten
  // fact must be removed from the facet inputs before consolidation can reword it.
  // Consolidation never invents text (output derives only from inputs), so pruning inputs
  // here guarantees forgotten content cannot appear in the consolidated output.
  if (input.forgottenFactKeys && input.forgottenFactKeys.size > 0) {
    pruneForgottenFacts(state, input.forgottenFactKeys);
  }

  // Consolidate the facets this run just wrote to (dedupe paraphrase, tighten, drop
  // cross-facet dupes). Only when the caller supplied the consolidation prompts and the
  // run produced profile facts. Fail-open inside consolidateChangedFacets.
  if (
    input.prompts.consolidateFacetSystemPrompt &&
    input.prompts.consolidateFacetUserPrompt &&
    digest.profileFacts && digest.profileFacts.length > 0
  ) {
    const changedFacets = [...new Set(digest.profileFacts.map((pf) => pf.facet.trim()))];
    await consolidateChangedFacets({
      state,
      changedFacets,
      llm: input.llm,
      prompts: {
        systemPrompt: input.prompts.consolidateFacetSystemPrompt,
        userPromptTemplate: input.prompts.consolidateFacetUserPrompt
      },
      makeId: createDefaultIdFactory(),
      makeNow: createDefaultNowFactory(),
      dropLog
    });
  }

  const resolvedGoal = input.scope.goal?.trim() || undefined;
  if (resolvedGoal && !state.stableFacts.goal) {
    state.stableFacts.goal = resolvedGoal;
  }

  const consistency = consistencyCheck({
    output: digest,
    previousDigest: input.lastDigest,
    protectedState: state
  });

  // Defensive second prune: applyProfileFactsFromDigest (and any future post-merge mutation)
  // runs after the first prune and could in principle reintroduce a forgotten fact. Pruning
  // again here guarantees result.state is clean regardless of post-merge additions.
  if (input.forgottenFactKeys && input.forgottenFactKeys.size > 0) {
    pruneForgottenFacts(state, input.forgottenFactKeys);
  }

  return { digest, state, selection, deltas, metrics, consistency, dropLog };
}
