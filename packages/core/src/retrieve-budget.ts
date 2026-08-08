/**
 * Packs a retrieval into a caller-declared character budget.
 *
 * The n=200 budget-aligned LongMemEval run showed why this belongs in the
 * engine rather than in every caller: `POST /v1/memory/retrieve` took an item
 * count and no budget, so the "four whole sessions or twenty small units"
 * tradeoff — the one worth ten points at a 4k budget — was a decision only
 * StateCore could make and had no way to hear about. Callers filled the gap by
 * cutting on their own: the benchmark harness reimplemented it in eighty lines,
 * and assistant-backend simply took the first forty facts.
 *
 * Three rules carry the design:
 *
 * 1. Whole items only. Half a fact is not a shortened fact, it is a false one.
 * 2. An item that does not fit is skipped, and the fill continues. Stopping at
 *    the first oversized item makes the result a function of item size rather
 *    than of relevance.
 * 3. Everything refused is recorded. A response that quietly holds less than
 *    the caller asked for is the defect class this engine exists to remove.
 */

/** Facts may take at most this share of the budget, so raw evidence always fits. */
export const FACT_BUDGET_SHARE = 0.4;

/** Itemised drops are bounded; the counts never are. */
export const MAX_DROP_DETAIL_ITEMS = 100;

export type BudgetDropReason = "budget_exhausted" | "fact_share_cap" | "digest_too_large";

export interface BudgetDrop {
  kind: "digest" | "fact" | "event";
  id: string | null;
  chars: number;
  reason: BudgetDropReason;
  score?: number;
}

export interface BudgetReport {
  maxChars: number;
  usedChars: number;
  digestChars: number;
  factChars: number;
  eventChars: number;
  factShareCap: number;
  droppedCounts: { digest: number; fact: number; event: number };
  dropped: BudgetDrop[];
  itemsOmitted: number;
}

export interface BudgetFact {
  id: string;
  content: string;
  confidence: number;
  addedAt: string;
}

export interface BudgetEvent {
  id: string;
  content: string;
}

export interface PackInput<F extends BudgetFact, E extends BudgetEvent> {
  digest: string | null;
  facts: F[];
  events: E[];
  maxChars: number;
  /** Relevance score for one text. Absent when the caller supplied no query. */
  scoreFact?: (content: string) => number;
}

export interface PackResult<F, E> {
  digest: string | null;
  facts: F[];
  events: E[];
  budget: BudgetReport;
}

/**
 * Orders facts for budget competition.
 *
 * With a query, relevance leads. Without one there is no relevance signal, so
 * it falls back to confidence and then recency rather than inventing a ranking
 * that would look authoritative and mean nothing.
 */
export function rankFacts<F extends BudgetFact>(
  facts: F[],
  scoreFact?: (content: string) => number
): F[] {
  const scored = facts.map((fact) => ({
    fact,
    score: scoreFact ? scoreFact(fact.content) : 0
  }));
  scored.sort((a, b) => {
    if (scoreFact && b.score !== a.score) return b.score - a.score;
    if (b.fact.confidence !== a.fact.confidence) return b.fact.confidence - a.fact.confidence;
    return b.fact.addedAt.localeCompare(a.fact.addedAt);
  });
  return scored.map((entry) => entry.fact);
}

export function packWithinBudget<F extends BudgetFact, E extends BudgetEvent>(
  input: PackInput<F, E>
): PackResult<F, E> {
  const { digest, facts, events, maxChars, scoreFact } = input;

  const droppedCounts = { digest: 0, fact: 0, event: 0 };
  const dropped: BudgetDrop[] = [];
  let itemsOmitted = 0;

  // The detail list is bounded, the counts are not. Every drop increments the
  // count; only the first MAX_DROP_DETAIL_ITEMS get an entry, and the remainder
  // is stated rather than lost.
  const record = (drop: BudgetDrop) => {
    droppedCounts[drop.kind] += 1;
    if (dropped.length < MAX_DROP_DETAIL_ITEMS) dropped.push(drop);
    else itemsOmitted += 1;
  };

  let remaining = maxChars;

  // 1. Digest, atomic.
  let keptDigest: string | null = null;
  let digestChars = 0;
  if (digest) {
    if (digest.length <= remaining) {
      keptDigest = digest;
      digestChars = digest.length;
      remaining -= digestChars;
    } else {
      record({ kind: "digest", id: null, chars: digest.length, reason: "digest_too_large" });
    }
  }

  // 2. Facts, capped at a share of the WHOLE budget so the cap is a promise the
  //    caller can verify, then bounded again by what the digest left behind.
  const factShareCap = Math.floor(maxChars * FACT_BUDGET_SHARE);
  let factAllowance = Math.min(factShareCap, remaining);

  // Which constraint actually binds is decided once, here, and holds for every
  // rejection in the loop below. Deriving it per item from the cap alone would
  // misreport the common case where a large digest — not the share — is what
  // starved the facts, and the two reasons carry different advice: hitting the
  // cap means the share could be raised, running out means the budget must be.
  const factReason: BudgetDropReason =
    factShareCap <= remaining ? "fact_share_cap" : "budget_exhausted";

  const ranked = rankFacts(facts, scoreFact);
  const keptFacts: F[] = [];
  let factChars = 0;
  for (const fact of ranked) {
    const cost = fact.content.length;
    if (cost <= factAllowance) {
      keptFacts.push(fact);
      factAllowance -= cost;
      factChars += cost;
      continue;
    }
    record({
      kind: "fact",
      id: fact.id,
      chars: cost,
      reason: factReason,
      ...(scoreFact ? { score: scoreFact(fact.content) } : {})
    });
  }
  remaining -= factChars;

  // 3. Events take whatever is left, in the order retrieve() ranked them.
  const keptEvents: E[] = [];
  let eventChars = 0;
  for (const event of events) {
    const cost = event.content.length;
    if (cost <= remaining) {
      keptEvents.push(event);
      remaining -= cost;
      eventChars += cost;
      continue;
    }
    record({ kind: "event", id: event.id, chars: cost, reason: "budget_exhausted" });
  }

  return {
    digest: keptDigest,
    facts: keptFacts,
    events: keptEvents,
    budget: {
      maxChars,
      usedChars: digestChars + factChars + eventChars,
      digestChars,
      factChars,
      eventChars,
      factShareCap,
      droppedCounts,
      dropped,
      itemsOmitted
    }
  };
}
