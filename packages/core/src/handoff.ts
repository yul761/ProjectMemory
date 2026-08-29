/**
 * Session handoff as a first-class, supersession-tracked fact.
 *
 * A handoff is "where the last session stopped": a summary, the questions
 * still open, and the next steps — written by an agent about to end (or
 * compact) a session, read by whichever agent starts the next one, in the
 * same client or a different vendor's. It is deliberately not a new storage
 * mechanism: a handoff is a registry fact under a reserved facet, so setting
 * a new one supersedes the previous through the exact chain every other fact
 * uses, and the history of stop-points stays walkable through provenance.
 *
 * The facet is intentionally absent from the facet packs: handoffs are not
 * profile knowledge, must not enter facet consolidation or display grouping,
 * and live only in the registry.
 */
import type { DigestState, FactRegistryEntry } from "./digest-control";

export const HANDOFF_FACET = "handoff";

export interface HandoffInput {
  summary: string;
  openQuestions?: string[];
  nextSteps?: string[];
}

export type SetHandoffResult = { changed: false } | { changed: true; id: string; supersededId?: string };

function formatHandoff(input: HandoffInput): string {
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

function activeHandoffs(state: DigestState): FactRegistryEntry[] {
  return (state.factRegistry ?? []).filter(
    (entry) => entry.facet === HANDOFF_FACET && !entry.supersededBy && !entry.retiredAt
  );
}

export function setHandoffFact(
  state: DigestState,
  input: HandoffInput,
  makeId: () => string,
  makeNow: () => string
): SetHandoffResult {
  if (!input.summary.trim()) return { changed: false };
  if (!state.factRegistry) state.factRegistry = [];

  const previous = activeHandoffs(state);
  const id = makeId();
  const entry: FactRegistryEntry = {
    id,
    content: formatHandoff(input),
    type: "profile",
    confidence: 0.95,
    addedAt: makeNow(),
    evidenceId: makeId(),
    evidenceType: "event",
    facet: HANDOFF_FACET
  };
  state.factRegistry.push(entry);
  for (const old of previous) old.supersededBy = id;

  return previous.length
    ? { changed: true, id, supersededId: previous[previous.length - 1].id }
    : { changed: true, id };
}

export interface ActiveHandoff {
  content: string;
  addedAt: string;
  /** How many handoffs the chain holds, the active one included. */
  versionCount: number;
}

export function getActiveHandoff(state: DigestState): ActiveHandoff | null {
  const all = (state.factRegistry ?? []).filter((entry) => entry.facet === HANDOFF_FACET);
  const active = activeHandoffs(state);
  if (!active.length) return null;
  const latest = active[active.length - 1];
  return { content: latest.content, addedAt: latest.addedAt, versionCount: all.length };
}
