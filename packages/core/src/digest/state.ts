// DigestState defaults, normalization, and evidence/confidence scoring.
// Split out of digest-control.ts (2026-08-28) — bodies moved verbatim.
import type { Digest } from "../index";
import { parseGoal } from "./parse";
import { normalizeText } from "./similarity";
import type { DigestState, FactRegistryEntry, DigestEvidenceRef, DigestStateChange } from "./types";

export function createDefaultIdFactory(): () => string {
  return () => `fact-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export function createDefaultNowFactory(): () => string {
  return () => new Date().toISOString();
}


export const DEFAULT_DIGEST_STATE: DigestState = {
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

export function deriveStateFromDigest(digest?: Digest | null): DigestState | null {
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

export function normalizeEvidenceRef(ref: string | DigestEvidenceRef): DigestEvidenceRef {
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
    factRegistry: normalizeFactRegistry((base as DigestState).factRegistry),
    profile: normalizeProfile((base as DigestState).profile)
  };
}

/**
 * How many inactive (superseded or retired) entries the registry keeps.
 *
 * Active entries are never dropped here — normalisation is a load path, and the
 * caps that bound them are enforced where facts are written. Only history is
 * bounded, because it grows with every correction and the whole state is stored
 * as one JSON document.
 */
const FACT_REGISTRY_HISTORY_LIMIT = 500;

/**
 * Keeps every active fact and a bounded, most-recent slice of the history.
 *
 * This used to be `.filter(e => !e.supersededBy).slice(-100)`, which deleted the
 * entire supersession history every time a previous state was loaded. The effect
 * was that a fact's chain existed only until the next digest ran: the provenance
 * API could answer "what did you believe before" for a few minutes and then
 * never again. A cap of 100 also silently discarded active facts once a scope
 * accumulated enough of them.
 */
function normalizeFactRegistry(registry?: FactRegistryEntry[]): FactRegistryEntry[] {
  const entries = registry ?? [];
  const active = entries.filter((entry) => !entry.supersededBy && !entry.retiredAt);
  const history = entries.filter((entry) => entry.supersededBy || entry.retiredAt);
  const keptHistory =
    history.length > FACT_REGISTRY_HISTORY_LIMIT
      ? history.slice(-FACT_REGISTRY_HISTORY_LIMIT)
      : history;
  // Preserve the original relative order so a chain reads oldest-first.
  const kept = new Set([...active, ...keptHistory]);
  return entries.filter((entry) => kept.has(entry));
}

/**
 * Copies the profile through without judgement.
 *
 * This used to enumerate the seven personal facets with their caps inline (a
 * sixth copy of the ontology), then briefly trimmed each facet to the active
 * pack's cap. Both were wrong for the same reason: normalisation is a *read*
 * path, and silently returning less than the state holds is precisely the
 * failure mode this engine is supposed to not have. Capacity is enforced where
 * facts are written — applyProfileFactsFromDigest and addNoteFact — and that is
 * the only place it belongs.
 */
function normalizeProfile(profile?: Record<string, string[]>): Record<string, string[]> | undefined {
  if (!profile) return undefined;
  const out: Record<string, string[]> = {};
  for (const [facet, values] of Object.entries(profile)) {
    out[facet] = [...(values ?? [])];
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

export function normalizeValueProvenanceList(entries?: Array<{ value?: string; refs?: Array<string | DigestEvidenceRef> }> | null) {
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
