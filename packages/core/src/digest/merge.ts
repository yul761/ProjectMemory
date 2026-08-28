// The deterministic merge: profile facets, goal updates, document-backed lists,
// and protectedStateMerge itself. Split out of digest-control.ts (2026-08-28) —
// bodies moved verbatim.
import type { MemoryEvent } from "../index";
import { stripInternalIds } from "../facet-consolidation";
import { recordDrop, type DropRecord } from "../drop-log";
import {
  getDefaultFacetPack,
  getFacetCap,
  isDocumentAuthorityFacet,
  isRegisteredFacet,
  isWriteProtectedFacet,
  resolveFacetRoute,
  writeProtectedFacets,
  type FacetPack
} from "../facet-registry";
import { decisionValuesAreComparable, jaccardSimilarity, normalizeText, sameFactCjkAware, tokenize } from "./similarity";
import {
  extractNaturalGoal,
  isTransientCleanupTodo,
  normalizeConstraintFactText,
  normalizeTodoFactText,
  parseGoal,
  parseLinesWithPrefix,
  stripStructuredLabel
} from "./parse";
import { compareEventAsc } from "./selection";
import {
  DEFAULT_DIGEST_STATE,
  createDefaultIdFactory,
  createDefaultNowFactory,
  normalizeDigestState,
  normalizeEvidenceRef,
  normalizeValueProvenanceList
} from "./state";
import {
  MAX_FACT_CHARS,
  isFactSized,
  isInFactRegistry,
  promoteToFactRegistry,
  retireFact,
  supersedeFact
} from "./fact-registry";
import type {
  DeltaCandidate,
  DigestEvidenceRef,
  DigestState,
  DigestStateChange,
  DigestStateValueProvenance,
  FactRegistryEntry
} from "./types";

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


function mergeProfileFacets(
  state: DigestState,
  events: MemoryEvent[],
  prevFactRegistryIds: Set<string>,
  makeId: () => string,
  makeNow: () => string = createDefaultNowFactory(),
  dropLog?: DropRecord[],
  pack: FacetPack = getDefaultFacetPack()
): void {
  // Lazy-init guard: only initialise profile if at least one event is routable
  if (!events.some((e) => resolveFacetRoute(pack, e.classifiedType) !== undefined)) return;
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
    const route = resolveFacetRoute(pack, evt.classifiedType);
    if (!route) continue;
    const incomingValue = evt.content.trim();
    if (!incomingValue) continue;

    const { facet, cap, writeProtected } = route;

    // Routing classifies an event into a facet; it does not turn it into a fact.
    // A session-sized event has to reach the profile through extraction, or the
    // facet fills up with transcripts. See MAX_FACT_CHARS.
    if (!isFactSized(incomingValue)) {
      if (dropLog) {
        recordDrop(dropLog, "fact_too_long", {
          facet,
          value: incomingValue,
          length: incomingValue.length,
          limit: MAX_FACT_CHARS
        });
      }
      continue;
    }
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
  dropLog?: DropRecord[],
  pack: FacetPack = getDefaultFacetPack()
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
    if (!isRegisteredFacet(pack, facet)) {
      if (dropLog) recordDrop(dropLog, "facet_not_registered", { facet, value });
      continue;
    }

    // Extraction is supposed to return statements. When it returns a passage
    // instead — quoting a whole turn back, most often — the same crowding-out
    // applies as on the routing path, so the bound holds here too.
    if (!isFactSized(value)) {
      if (dropLog) {
        recordDrop(dropLog, "fact_too_long", {
          facet,
          value,
          length: value.length,
          limit: MAX_FACT_CHARS
        });
      }
      continue;
    }

    // Document-authority facets take the document ref; conversational facets prefer
    // the stream-event ref (it carries the actual turn) and fall back to a doc ref.
    const evidence: DigestEvidenceRef | null =
      isDocumentAuthorityFacet(pack, facet) ? docEvidence : (streamEvidence ?? docEvidence);
    const authority = evidence?.sourceType === "document" ? 0.85 : 0.6;
    const cap = getFacetCap(pack, facet);

    // A document-authority facet with no document in this run has nothing to
    // attach the fact to. Writing it anyway put a fact into the profile with no
    // registry entry behind it: unciteable, untraceable, and unable to be
    // superseded later because supersession works off the registry. Reject it
    // and say so.
    if (isDocumentAuthorityFacet(pack, facet) && !evidence) {
      if (dropLog) recordDrop(dropLog, "no_document_evidence", { facet, value });
      continue;
    }

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
      const activeEntry = (state.factRegistry ?? []).find(
        (e) =>
          !e.supersededBy && !e.retiredAt && e.type === "profile" && sameFactCjkAware(e.content, existing, 0.6)
      );

      // Write protection, on the path that actually runs every digest.
      //
      // It used to live only in mergeProfileFacets (the stage-1, classifier-driven
      // path). Stage 2 — where the digest LLM emits profileFacts directly — had no
      // check at all, so a 0.6-authority sentence pulled out of chat would quietly
      // supersede a 0.85-authority fact taken from an uploaded document. That is
      // exactly the drift the protected facets exist to prevent, on exactly the
      // path that carries the resume.
      if (isWriteProtectedFacet(pack, facet) && activeEntry && authority < activeEntry.confidence) {
        if (dropLog) {
          recordDrop(dropLog, "protected_lower_authority", {
            facet,
            value,
            existing,
            incomingAuthority: authority,
            existingAuthority: activeEntry.confidence
          });
        }
        continue;
      }

      if (evidence) {
        const authorityIncreased = activeEntry !== undefined && authority > activeEntry.confidence;
        if (contentChanged || authorityIncreased) {
          supersedeFact(state, existing, value, evidence, makeId, { facet, confidence: authority, type: "profile" }, makeNow);
        }
      }
      if (contentChanged) facetFacts[existingIdx] = value;
      continue;
    }

    if (facetFacts.length >= cap) {
      if (isWriteProtectedFacet(pack, facet)) {
        // Protected facets are high-value; don't evict one to make room.
        if (dropLog) recordDrop(dropLog, "cap_rejected_incoming", { facet, value, cap });
        continue;
      }
      const [evicted] = facetFacts.splice(0, 1); // volatile facets: evict oldest (index 0)
      if (evicted && dropLog) recordDrop(dropLog, "cap_evicted", { facet, value: evicted, cap });
      // Retire, don't delete: the fact stops being active but the record of
      // having believed it survives.
      if (evicted) retireFact(state, evicted, "cap_evicted", makeNow);
    }

    facetFacts.push(value);
    if (evidence) {
      promoteToFactRegistry(state, value, "profile", authority, evidence, makeId, facet, makeNow);
    }
  }
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
  pack?: FacetPack;
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
      } else if (!isFactSized(text)) {
        // Skip the whole branch, not just the write. `findConflictingDecisions`
        // below would be matching real decisions against a transcript, and a
        // spurious match there deletes one.
        if (input.dropLog) {
          recordDrop(input.dropLog, "fact_too_long", {
            field: "decisions",
            value: text,
            length: text.length,
            limit: MAX_FACT_CHARS
          });
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
      const existing = isFactSized(normalizedConstraint)
        ? findBestSemanticMatch(next.stableFacts.constraints, normalizedConstraint)
        : undefined;
      if (!isFactSized(normalizedConstraint)) {
        if (input.dropLog) {
          recordDrop(input.dropLog, "fact_too_long", {
            field: "constraints",
            value: normalizedConstraint,
            length: normalizedConstraint.length,
            limit: MAX_FACT_CHARS
          });
        }
      } else if (!existing) {
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
  mergeProfileFacets(next, streamEventsForProfile, prevFactRegistryIds, makeId, makeNow, input.dropLog, input.pack ?? getDefaultFacetPack());

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
