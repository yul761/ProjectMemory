import { createHash } from "node:crypto";
import { getActiveFactRegistry, type DigestState } from "./digest-control";

export type DisplayGroup = "Schedule" | "People" | "Preferences" | "Projects";

export type DisplayFact = {
  factKey: string;
  text: string;
  group: DisplayGroup;
  createdAt: string | null;
  evidenceId?: string;
};

const FACET_TO_GROUP: Record<string, DisplayGroup> = {
  followUps: "Schedule",
  relationships: "People",
  style: "Preferences",
  goals: "Projects",
  ongoing: "Projects"
  // identity: intentionally omitted (never shown)
};

const GROUP_ORDER: DisplayGroup[] = ["Schedule", "People", "Preferences", "Projects"];

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
  return FACET_TO_GROUP[facet] ?? null;
}

export function flattenScopeFacts(state: DigestState): DisplayFact[] {
  const byKey = new Map<string, DisplayFact>();

  // 1) Profile-class factRegistry entries (richer: have evidenceId + addedAt).
  for (const entry of getActiveFactRegistry(state)) {
    if (entry.type !== "profile") continue;
    const group = entry.facet ? factToGroup(entry.facet) : null;
    if (!group) continue;
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
  return GROUP_ORDER.map((group) => ({
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
