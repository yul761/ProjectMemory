// The fact registry: promotion, retirement, supersession, and the deterministic
// note write path. Split out of digest-control.ts (2026-08-28) — bodies moved verbatim.
import { getDefaultFacetPack, getFacetCap, type FacetPack } from "../facet-registry";
import { isNoteRevision, sameFactCjkAware } from "./similarity";
import { createDefaultNowFactory } from "./state";
import type { DigestEvidenceRef, DigestState, FactRegistryEntry } from "./types";

export function isInFactRegistry(state: DigestState, content: string): boolean {
  return (state.factRegistry ?? []).some(
    (entry) => !entry.supersededBy && sameFactCjkAware(entry.content, content, 0.6)
  );
}

export function getActiveFactRegistry(state: DigestState): FactRegistryEntry[] {
  return (state.factRegistry ?? []).filter((entry) => !entry.supersededBy && !entry.retiredAt);
}

/**
 * The longest a single fact may be.
 *
 * Three paths used to promote `event.content` verbatim — profile facets,
 * decisions, constraints. With a chat message that reads fine, because a message
 * is about the size of a statement. With a session or a document it is not: the
 * fact layer becomes a second copy of the corpus, and since every consumer of it
 * works against a context budget, those copies crowd out the facts that
 * extraction actually produced. Measured on LongMemEval at session granularity:
 * 87% of registry entries over 1000 tokens, median 2691, against extracted facts
 * of 11-27 tokens — a ratio near 100:1.
 *
 * 500 characters is a generous sentence and a small fraction of any document, so
 * the bound separates the two cases without needing to know which one it is in.
 */
export const MAX_FACT_CHARS = 500;

/**
 * Whether a value is a statement rather than a document.
 *
 * This sits on what gets written, not on the event it came from: a long
 * conversation that yields a short fact is the normal case and must still pass.
 */
export function isFactSized(content: string): boolean {
  return content.trim().length <= MAX_FACT_CHARS;
}

/**
 * Retire a fact instead of deleting it.
 *
 * Capacity eviction used to `splice()` the registry record out entirely, which
 * destroyed the very audit chain that supersession exists to provide: the fact
 * had been believed, and then there was no record it ever had been. A retired
 * fact stays on the record with a timestamp and a reason; it simply stops being
 * active.
 */
export function retireFact(
  state: DigestState,
  content: string,
  reason: string,
  makeNow: () => string = createDefaultNowFactory(),
  /**
   * `exact` must be used wherever the fact was stored verbatim with exact-match
   * dedup — notably notes. The fuzzy matcher strips short numeric tokens, so
   * "API v1 key…" and "API v2 key…" look identical to it and the wrong entry
   * would be retired.
   */
  options?: { exact?: boolean }
): void {
  if (!state.factRegistry) return;
  const normalizeExact = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  const matches = options?.exact
    ? (entryContent: string) => normalizeExact(entryContent) === normalizeExact(content)
    : (entryContent: string) => sameFactCjkAware(entryContent, content, 0.6);

  const target = state.factRegistry.find(
    (entry) => !entry.supersededBy && !entry.retiredAt && matches(entry.content)
  );
  if (!target) return;
  target.retiredAt = makeNow();
  target.retiredReason = reason;
}

export function promoteToFactRegistry(
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
  // Backstop. Every caller checks already; this makes it impossible for a new
  // one to put a document in the registry by forgetting to.
  if (!isFactSized(content)) return;
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

export function supersedeFact(
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


/** Result of `addNoteFact`: whether the state changed, and — when the note
 * superseded an active revision — the content of the note it replaced. */
export interface AddNoteResult {
  changed: boolean;
  superseded?: string;
}

/**
 * Deterministically writes a user-supplied note to `state.profile.notes`.
 *
 * - No-op (`changed: false`) when an exactly-identical (normalized) note already exists.
 *   Dedup uses EXACT normalized match (trim + collapse whitespace + lowercase),
 *   never fuzzy Jaccard: the fuzzy tokenizer strips short numeric tokens
 *   (< 3 digits), so "API v1 key…" and "API v2 key…" would otherwise collapse to the
 *   same token set and be silently merged — losing user data.
 * - Supersession: when the note reads as a REVISION of an active note
 *   (`isNoteRevision`: short-token-preserving Jaccard ≥ 0.7 with the ASCII-divergence
 *   guard), it replaces that note in the active set and the registry chains
 *   old → new via `supersededBy`. This is the deterministic write-path
 *   counterpart of the digest path's `supersedeFact`, and it is safe where fuzzy
 *   dedup was not: the superseded note stays on the record, marked, never deleted.
 * - Enforces the `notes` cap (30); evicts the oldest entry (index 0) and retires
 *   its factRegistry record when the cap is reached.
 * - Promotes the note to the factRegistry as a `profile/notes` entry with
 *   confidence 0.9 so it surfaces via `flattenScopeFacts` with its timestamp.
 */
export function addNoteFact(
  state: DigestState,
  text: string,
  makeId: () => string,
  makeNow: () => string = createDefaultNowFactory(),
  pack: FacetPack = getDefaultFacetPack()
): AddNoteResult {
  const value = text.trim();
  if (!value) return { changed: false };

  // Normalize helper: trim, collapse internal whitespace, lowercase.
  const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

  // Idempotency: no-op if an exactly-identical (normalized) note already exists.
  // Explicit notes must use exact match — fuzzy dedup would silently merge notes
  // differing only by short numeric tokens (e.g. "API v1 key…" vs "API v2 key…").
  const existingNotes = state.profile?.notes ?? [];
  if (existingNotes.some((note) => norm(note) === norm(value))) return { changed: false };

  // Lazy-init profile and notes array.
  if (!state.profile) state.profile = {};
  const profileMap = state.profile as Record<string, string[]>;
  if (!profileMap.notes) profileMap.notes = [];
  const notes = profileMap.notes;
  if (!state.factRegistry) state.factRegistry = [];

  const registerNote = (supersedes?: FactRegistryEntry): string => {
    const id = makeId();
    const entry: FactRegistryEntry = {
      id,
      content: value,
      type: "profile" as const,
      confidence: 0.9,
      addedAt: makeNow(),
      evidenceId: makeId(),
      evidenceType: "event" as const,
      facet: "notes"
    };
    state.factRegistry!.push(entry);
    if (supersedes) supersedes.supersededBy = id;
    return id;
  };

  // Supersession: a new note that reads as a revision of an active note replaces
  // it in place instead of accumulating beside it. Matching runs over
  // `profile.notes` (the active set by construction), so retired and superseded
  // versions can never be matched again.
  const revisionIdx = notes.findIndex((note) => isNoteRevision(note, value));
  if (revisionIdx !== -1) {
    const superseded = notes[revisionIdx];
    notes[revisionIdx] = value;
    const oldEntry = state.factRegistry.find(
      (e) => !e.supersededBy && !e.retiredAt && e.facet === "notes" && norm(e.content) === norm(superseded)
    );
    registerNote(oldEntry);
    return { changed: true, superseded };
  }

  // Cap enforcement: evict the oldest entry (index 0) and retire its registry
  // record. Retiring rather than deleting keeps the audit chain intact — the
  // note stops being active, but the record that it was once held remains.
  const cap = getFacetCap(pack, "notes");
  if (notes.length >= cap) {
    const [evicted] = notes.splice(0, 1);
    if (evicted) retireFact(state, evicted, "cap_evicted", makeNow, { exact: true });
  }

  notes.push(value);

  // Promote to factRegistry so flattenScopeFacts surfaces createdAt + evidenceId.
  // Notes use exact-match dedup for the registry guard: the shared promoteToFactRegistry
  // helper calls isInFactRegistry which uses fuzzy Jaccard, which would prevent distinct
  // notes like "note-1" from being registered if a fuzzy-similar "note-0" already exists.
  // Instead, push directly with a facet-scoped exact-match guard.
  const alreadyRegistered = state.factRegistry.some(
    (e) => !e.supersededBy && e.facet === "notes" && norm(e.content) === norm(value)
  );
  if (!alreadyRegistered) registerNote();

  return { changed: true };
}
