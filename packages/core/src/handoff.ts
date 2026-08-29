/**
 * Session handoff as first-class, supersession-tracked rows.
 *
 * A handoff is "where the last session stopped": a summary, the questions
 * still open, and the next steps — written by an agent about to end (or
 * compact) a session, read by whichever agent starts the next one, in the
 * same client or a different vendor's.
 *
 * Handoffs live in their own table (SessionHandoff), deliberately NOT in the
 * digest state snapshot. The first shipped version stored them as registry
 * facts inside the snapshot JSON, and review found three faults with that:
 * a handoff written while a digest ran vanished from the new snapshot's
 * lineage (the snapshot is read-modify-write with no concurrency control);
 * every digest copied the whole handoff history into the new snapshot row;
 * and each entry carried a fabricated evidence id. Rows in a dedicated table
 * are transactional, are written once, and are their own evidence.
 *
 * This module holds the storage-independent parts: formatting, the active-row
 * projection, the mapping that lets `buildFactProvenance` walk a handoff
 * chain, and the digest-time carry-over that closes the same lost-update race
 * for concurrently written notes.
 */
import type { DigestState, FactRegistryEntry } from "./digest-control";

/** Reserved facet name; kept for filtering out legacy in-registry entries. */
export const HANDOFF_FACET = "handoff";

export interface HandoffInput {
  summary: string;
  openQuestions?: string[];
  nextSteps?: string[];
}

/** The storage row shape both backends' SessionHandoff tables share. */
export interface HandoffRow {
  id: string;
  content: string;
  createdAt: Date | string;
  supersededBy?: string | null;
  retiredAt?: Date | string | null;
  retiredReason?: string | null;
}

export function formatHandoff(input: HandoffInput): string {
  const lines = [input.summary.trim()];
  const questions = (input.openQuestions ?? []).map((q) => q.trim()).filter(Boolean);
  if (questions.length) {
    lines.push("Open questions:");
    for (const q of questions) lines.push(`- ${q}`);
  }
  const steps = (input.nextSteps ?? []).map((s) => s.trim()).filter(Boolean);
  if (steps.length) {
    lines.push("Next steps:");
    for (const s of steps) lines.push(`- ${s}`);
  }
  return lines.join("\n");
}

export interface ActiveHandoff {
  id: string;
  content: string;
  addedAt: string;
  /** How many stop-points the scope has recorded, retired ones included. */
  versionCount: number;
}

const toIso = (value: Date | string): string => (value instanceof Date ? value.toISOString() : value);

export function activeHandoffFromRows(rows: HandoffRow[]): ActiveHandoff | null {
  const active = rows.filter((r) => !r.supersededBy && !r.retiredAt);
  if (!active.length) return null;
  const latest = active.reduce((a, b) => (toIso(a.createdAt) >= toIso(b.createdAt) ? a : b));
  return { id: latest.id, content: latest.content, addedAt: toIso(latest.createdAt), versionCount: rows.length };
}

/**
 * Maps handoff rows into registry-entry shape so `buildFactProvenance` can
 * walk a stop-point chain exactly the way it walks a fact chain. A row's
 * evidence is the row itself: the handoff statement is agent-authored, not
 * derived from an event, and a self-referential id resolves instead of
 * dangling.
 */
export function handoffRowsToRegistry(rows: HandoffRow[]): FactRegistryEntry[] {
  return rows.map((r) => ({
    id: r.id,
    content: r.content,
    type: "profile" as const,
    confidence: 0.95,
    addedAt: toIso(r.createdAt),
    evidenceId: r.id,
    evidenceType: "event" as const,
    facet: HANDOFF_FACET,
    ...(r.supersededBy ? { supersededBy: r.supersededBy } : {}),
    ...(r.retiredAt ? { retiredAt: toIso(r.retiredAt) } : {}),
    ...(r.retiredReason ? { retiredReason: r.retiredReason } : {})
  }));
}

/**
 * Closes the digest-side lost-update race for notes: the pipeline reads the
 * latest snapshot, runs for seconds-to-minutes, then CREATES a new snapshot
 * from its in-memory state — a note written to the old snapshot row in that
 * window would silently vanish from the latest lineage. Called at digest
 * write time with the freshly re-read latest state; appends note-facet
 * registry entries (and their active profile strings) the pipeline never saw.
 * Registry entries are append-only, so an id present in `latest` but absent
 * from `pipeline` can only be a concurrent write. Scoped to the notes facet,
 * the one deterministic-write path that races the digest by design.
 *
 * @returns how many entries were carried over.
 */
export function carryOverConcurrentNotes(pipeline: DigestState, latest: DigestState): number {
  const pipelineIds = new Set((pipeline.factRegistry ?? []).map((e) => e.id));
  const missedNotes = (latest.factRegistry ?? []).filter(
    (e) => e.facet === "notes" && !pipelineIds.has(e.id)
  );
  if (!missedNotes.length) return 0;

  if (!pipeline.factRegistry) pipeline.factRegistry = [];
  if (!pipeline.profile) pipeline.profile = {};
  const profileMap = pipeline.profile as Record<string, string[]>;
  if (!profileMap.notes) profileMap.notes = [];

  for (const entry of missedNotes) {
    pipeline.factRegistry.push(entry);
    if (!entry.supersededBy && !entry.retiredAt && !profileMap.notes.includes(entry.content)) {
      profileMap.notes.push(entry.content);
    }
  }
  return missedNotes.length;
}
