// Delta detection: which selected events carry state-relevant novelty.
// Split out of digest-control.ts (2026-08-28) — bodies moved verbatim.
import { jaccardSimilarity } from "./similarity";
import type { DeltaCandidate, SelectedEvent } from "./types";

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
