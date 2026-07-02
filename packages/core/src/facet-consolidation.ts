import { z } from "zod";
import { sameFactCjkAware, type DigestState, type FactRegistryEntry } from "./digest-control";

export interface ConsolidatedFact { text: string; mergedFrom: number[] }

export const ConsolidationSchema = z.array(
  z.object({ text: z.string().min(1), mergedFrom: z.array(z.number().int().nonnegative()) })
);

function createDefaultNow(): () => string {
  return () => new Date().toISOString();
}

export function applyFacetConsolidation(
  state: DigestState,
  facet: string,
  items: string[],
  result: ConsolidatedFact[],
  makeId: () => string,
  makeNow: () => string = createDefaultNow()
): boolean {
  if (!Array.isArray(result) || result.length === 0) return false;
  // Validate every output maps to ≥1 in-range source index.
  for (const out of result) {
    const valid = out.mergedFrom.filter((i) => Number.isInteger(i) && i >= 0 && i < items.length);
    if (valid.length === 0) return false;
  }

  const registry = state.factRegistry ?? [];
  const findEntry = (source: string): FactRegistryEntry | undefined =>
    registry.find((e) => !e.supersededBy && e.type === "profile" && e.facet === facet
      && (e.content.trim() === source.trim() || sameFactCjkAware(e.content, source, 0.6)));

  // Build the replacement entries BEFORE mutating the registry.
  const newEntries: FactRegistryEntry[] = result.map((out) => {
    const sources = out.mergedFrom
      .filter((i) => i >= 0 && i < items.length)
      .map((i) => ({ text: items[i], entry: findEntry(items[i]) }));
    const withEntries = sources.filter((s) => s.entry).map((s) => s.entry!);
    // earliest addedAt (ISO strings sort lexicographically)
    const earliest = withEntries.length
      ? withEntries.reduce((a, b) => (a.addedAt <= b.addedAt ? a : b))
      : undefined;
    const confidence = withEntries.length ? Math.max(...withEntries.map((e) => e.confidence)) : 0.7;
    return {
      id: makeId(),
      content: out.text,
      type: "profile" as const,
      confidence,
      addedAt: earliest?.addedAt ?? makeNow(),
      evidenceId: earliest?.evidenceId ?? "consolidated",
      evidenceType: earliest?.evidenceType ?? ("event" as const),
      facet
    };
  });

  // Remove all current non-superseded entries for this facet, then append the rebuilt set.
  state.factRegistry = registry.filter((e) => !(!e.supersededBy && e.type === "profile" && e.facet === facet));
  state.factRegistry.push(...newEntries);

  const profileMap = (state.profile ?? (state.profile = {})) as Record<string, string[]>;
  profileMap[facet] = result.map((r) => r.text);
  return true;
}

/**
 * Removes internal bookkeeping that the digest LLM sometimes leaks into a
 * user-facing profile fact: parentheticals like "（提醒 ID：<uuid>）" /
 * "(reminder id: <uuid>)" and any bare UUID, then tidies leftover whitespace
 * and dangling separators. Clean text is returned unchanged.
 */
export function stripInternalIds(value: string): string {
  return value
    // full/half-width parenthetical containing an ID label + payload
    .replace(/[（(]\s*[^（()）]*?(?:提醒\s*ID|reminder\s*id)\s*[:：][^（()）]*[)）]/gi, "")
    // any bare UUID left behind
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/[\s·:：,\-]+$/g, "")
    .trim();
}
