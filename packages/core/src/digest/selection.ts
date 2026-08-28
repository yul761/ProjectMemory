// Event selection for a digest run: kind extraction, dedup, char budget.
// Split out of digest-control.ts (2026-08-28) — bodies moved verbatim.
import type { Digest, MemoryEvent } from "../index";
import { decisionValuesAreComparable, jaccardSimilarity, sameFactCjkAware } from "./similarity";
import type { EventFeatures, MemoryEventKind, SelectedEvent, SelectionResult } from "./types";

function sameDedupeGroup(a: MemoryEvent, b: MemoryEvent) {
  return a.type === b.type && (a.key ?? "") === (b.key ?? "");
}

function compareEventDesc(a: MemoryEvent, b: MemoryEvent) {
  const timeDiff = b.createdAt.getTime() - a.createdAt.getTime();
  if (timeDiff !== 0) return timeDiff;
  return b.id.localeCompare(a.id);
}

export function compareEventAsc(a: MemoryEvent, b: MemoryEvent) {
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

  // The budget binds, so something loses. Caller-pinned events go first: without
  // this the only tiebreaker is recency, and a durable input (a resume uploaded
  // once) is always the oldest and therefore always the first to be dropped.
  // Stable partition — relative order within each group is untouched.
  const pinned = events.filter(({ event }) => event.pinned);
  const ordered = pinned.length > 0 ? [...pinned, ...events.filter(({ event }) => !event.pinned)] : events;

  const pinnedChars = pinned.reduce((sum, { event }) => sum + event.content.length, 0);
  if (pinnedChars > charBudget) {
    // Pinned content alone overflows. Something the caller explicitly marked as
    // must-keep is going to be lost, and that must not be inferred from a
    // missing id later.
    rationale.push(`pinned_budget_exceeded:${pinnedChars}->${charBudget}`);
  }

  const kept: SelectedEvent[] = [];
  let used = 0;
  let truncated = 0;
  for (const selected of ordered) {
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
