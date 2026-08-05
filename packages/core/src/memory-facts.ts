import { createHash } from "node:crypto";
import { getActiveFactRegistry, type DigestState } from "./digest-control";
import { recordDrop, type DropRecord } from "./drop-log";
import { getFacetDisplayGroup, listFacets } from "./facet-registry";

/**
 * Open by design: the display groups come from the active facet pack, so a
 * deployment with a non-personal ontology gets its own groups rather than being
 * forced into Schedule/People/Style/Projects/Notes.
 */
export type DisplayGroup = string;

export type DisplayFact = {
  factKey: string;
  text: string;
  group: DisplayGroup;
  createdAt: string | null;
  evidenceId?: string;
};

/**
 * Display order follows the pack's declaration order, de-duplicated. Facets
 * whose displayGroup is null (identity) contribute no group and stay hidden.
 */
function groupOrder(): DisplayGroup[] {
  const seen: DisplayGroup[] = [];
  for (const facet of listFacets()) {
    const group = getFacetDisplayGroup(facet);
    if (group && !seen.includes(group)) seen.push(group);
  }
  return seen;
}

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

export function computeFactKey(group: string, content: string): string {
  return createHash("sha256")
    .update(`${normalize(group)}|${normalize(content)}`)
    .digest("hex")
    .slice(0, 16);
}

export function factToGroup(facet: string): DisplayGroup | null {
  return getFacetDisplayGroup(facet);
}

export function flattenScopeFacts(state: DigestState, dropLog?: DropRecord[]): DisplayFact[] {
  const byKey = new Map<string, DisplayFact>();

  // 1) Profile-class factRegistry entries (richer: have evidenceId + addedAt).
  for (const entry of getActiveFactRegistry(state)) {
    if (entry.type !== "profile") continue;
    const group = entry.facet ? factToGroup(entry.facet) : null;
    if (!group) {
      if (dropLog) recordDrop(dropLog, "no_display_group", { facet: entry.facet, value: entry.content });
      continue;
    }
    const factKey = computeFactKey(group, entry.content);
    if (!byKey.has(factKey)) {
      byKey.set(factKey, {
        factKey,
        text: entry.content,
        group,
        createdAt: entry.addedAt ?? null,
        evidenceId: entry.evidenceId
      });
    }
  }

  // 2) Bare profile facet strings (no id, no timestamp).
  const profile = state.profile ?? {};
  for (const [facet, values] of Object.entries(profile)) {
    const group = factToGroup(facet);
    if (!group || !Array.isArray(values)) continue;
    for (const text of values) {
      const factKey = computeFactKey(group, text);
      if (!byKey.has(factKey)) {
        byKey.set(factKey, { factKey, text, group, createdAt: null });
      }
    }
  }

  return [...byKey.values()];
}

export function groupFactsForDisplay(
  facts: DisplayFact[]
): Array<{ group: DisplayGroup; items: Array<{ factKey: string; text: string; createdAt: string | null }> }> {
  return groupOrder().map((group) => ({
    group,
    items: facts
      .filter((f) => f.group === group)
      .map((f) => ({ factKey: f.factKey, text: f.text, createdAt: f.createdAt }))
  })).filter((g) => g.items.length > 0);
}

export function pruneForgottenFacts(state: DigestState, forgottenFactKeys: ReadonlySet<string>): void {
  if (forgottenFactKeys.size === 0) return;

  // Bare profile-facet strings.
  const profile = state.profile;
  if (profile) {
    for (const [facet, values] of Object.entries(profile)) {
      const group = factToGroup(facet);
      if (!group || !Array.isArray(values)) continue;
      (profile as Record<string, string[]>)[facet] = values.filter(
        (v) => !forgottenFactKeys.has(computeFactKey(group, v))
      );
    }
  }

  // Profile-type factRegistry entries (those with a facet mapping to a display group).
  if (Array.isArray(state.factRegistry)) {
    state.factRegistry = state.factRegistry.filter((entry) => {
      const group = entry.facet ? factToGroup(entry.facet) : null;
      if (!group) return true; // not a displayable profile fact → keep
      return !forgottenFactKeys.has(computeFactKey(group, entry.content));
    });
  }
}
