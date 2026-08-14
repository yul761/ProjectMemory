import type { DigestState, FactRegistryEntry } from "./digest-control";

/**
 * Walks a fact's supersession chain, oldest version first.
 *
 * The registry already carried everything needed to answer "why do you believe
 * this, and what did you believe before" — evidenceId on each entry, supersededBy
 * linking versions — but nothing could ask it. Having an audit trail in the data
 * structure is not the same as being auditable.
 *
 * Works from any version in the chain, not just the newest: callers hold whichever
 * id the retrieve response gave them.
 */
export function buildFactProvenance(
  state: DigestState,
  factId: string
): { fact: FactRegistryEntry; chain: FactRegistryEntry[] } | null {
  const registry = state.factRegistry ?? [];
  const fact = registry.find((entry) => entry.id === factId);
  if (!fact) return null;

  // Walk backwards to the oldest ancestor, then forward along supersededBy.
  const predecessorOf = new Map(
    registry.filter((entry) => entry.supersededBy).map((entry) => [entry.supersededBy as string, entry])
  );
  const seenBackwards = new Set<string>([fact.id]);
  let root = fact;
  for (;;) {
    const previous = predecessorOf.get(root.id);
    if (!previous || seenBackwards.has(previous.id)) break;
    seenBackwards.add(previous.id);
    root = previous;
  }

  const byId = new Map(registry.map((entry) => [entry.id, entry]));
  const chain: FactRegistryEntry[] = [];
  const seenForwards = new Set<string>();
  let cursor: FactRegistryEntry | undefined = root;
  while (cursor && !seenForwards.has(cursor.id)) {
    seenForwards.add(cursor.id);
    chain.push(cursor);
    cursor = cursor.supersededBy ? byId.get(cursor.supersededBy) : undefined;
  }

  return { fact, chain };
}

/**
 * Coerces a stored selectionLog into a predictable shape.
 *
 * `null` means the digest predates the column — distinct from a run that
 * discarded nothing. Stored JSON is not trusted: it was written by an older
 * version of this code and is shaped by whatever that version recorded.
 */
export function normalizeSelectionLog(raw: unknown): { rationale: string[]; drops: unknown[] } {
  if (!raw || typeof raw !== "object") return { rationale: [], drops: [] };
  const log = raw as { rationale?: unknown; drops?: unknown };
  return {
    rationale: Array.isArray(log.rationale)
      ? log.rationale.filter((item): item is string => typeof item === "string")
      : [],
    drops: Array.isArray(log.drops) ? log.drops : []
  };
}
