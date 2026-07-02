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

function parseJsonArray(raw: string): unknown {
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{{${k}}}`, v);
  return out;
}

export async function consolidateFacetLlm(input: {
  facet: string;
  description: string;
  items: string[];
  siblings: Record<string, string[]>;
  llm: { chat: (m: { role: "system" | "user"; content: string }[]) => Promise<string> };
  systemPrompt: string;
  userPromptTemplate: string;
  maxRetries?: number;
}): Promise<ConsolidatedFact[] | null> {
  const itemsBlock = input.items.map((t, i) => `${i}. ${t}`).join("\n");
  const siblingsBlock = Object.entries(input.siblings)
    .filter(([, v]) => v.length)
    .map(([f, v]) => `${f}: ${v.join("; ")}`)
    .join("\n") || "(none)";
  const userPrompt = renderTemplate(input.userPromptTemplate, {
    facet: input.facet, facetDescription: input.description, items: itemsBlock, siblings: siblingsBlock
  });

  const maxRetries = input.maxRetries ?? 1;
  let fixInstruction = "";
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const raw = await input.llm.chat([
      { role: "system", content: input.systemPrompt },
      { role: "user", content: `${userPrompt}${fixInstruction}` }
    ]);
    const parsed = parseJsonArray(raw);
    const validated = ConsolidationSchema.safeParse(parsed);
    if (validated.success) return validated.data;
    fixInstruction = "\n\nYour previous reply was not a valid JSON array of {\"text\",\"mergedFrom\"} objects. Reply with ONLY that JSON array.";
  }
  return null;
}

type LlmLike = { chat: (m: { role: "system" | "user"; content: string }[]) => Promise<string> };
type ConsolidatePrompts = { systemPrompt: string; userPromptTemplate: string };

// Facet semantics live in core (alongside DISPLAY_FACETS in digest-control.ts). The prompt
// carries a {{facetDescription}} slot the caller fills from this map.
export const FACET_DESCRIPTIONS: Record<string, string> = {
  identity: "durable personal facts (工作经历, 教育, 技能, 联系方式, 居住地, 身高体重).",
  style: "tastes, communication preferences, and 行事作风 — working style, decision patterns, standards, values.",
  goals: "things the user wants to achieve.",
  relationships: "important people (and pets) in the user's life.",
  followUps: "commitments or things to remember/do, with any date/time.",
  ongoing: "projects or activities in progress.",
  notes: "durable, useful non-personal information worth keeping long-term (product/project details, decisions, processes, facts to remember)."
};

export const CONSOLIDATION_DISPLAY_FACETS = ["identity", "style", "goals", "relationships", "followUps", "ongoing", "notes"];

async function consolidateOne(state: DigestState, facet: string, llm: LlmLike, prompts: ConsolidatePrompts, makeId: () => string, makeNow?: () => string): Promise<boolean> {
  const profileMap = (state.profile ?? {}) as Record<string, string[]>;
  const items = profileMap[facet] ?? [];
  const siblings: Record<string, string[]> = {};
  for (const f of CONSOLIDATION_DISPLAY_FACETS) {
    if (f !== facet && (profileMap[f]?.length ?? 0) > 0) siblings[f] = profileMap[f];
  }
  const result = await consolidateFacetLlm({
    facet, description: FACET_DESCRIPTIONS[facet] ?? "", items, siblings, llm,
    systemPrompt: prompts.systemPrompt, userPromptTemplate: prompts.userPromptTemplate
  });
  if (!result) return false;
  return applyFacetConsolidation(state, facet, items, result, makeId, makeNow);
}

async function runConsolidation(state: DigestState, facets: string[], llm: LlmLike, prompts: ConsolidatePrompts, makeId: () => string, makeNow: (() => string) | undefined, minItems: number): Promise<string[]> {
  const profileMap = (state.profile ?? {}) as Record<string, string[]>;
  const changed: string[] = [];
  for (const facet of facets) {
    if (!CONSOLIDATION_DISPLAY_FACETS.includes(facet)) continue;
    if ((profileMap[facet]?.length ?? 0) < minItems) continue;
    try {
      if (await consolidateOne(state, facet, llm, prompts, makeId, makeNow)) changed.push(facet);
    } catch {
      // fail-open: leave this facet unchanged
    }
  }
  return changed;
}

export function consolidateChangedFacets(input: { state: DigestState; changedFacets: string[]; llm: LlmLike; prompts: ConsolidatePrompts; makeId: () => string; makeNow?: () => string; minItems?: number }): Promise<string[]> {
  return runConsolidation(input.state, input.changedFacets, input.llm, input.prompts, input.makeId, input.makeNow, input.minItems ?? 4);
}

export function consolidateAllProfileFacets(input: { state: DigestState; llm: LlmLike; prompts: ConsolidatePrompts; makeId: () => string; makeNow?: () => string; minItems?: number }): Promise<string[]> {
  return runConsolidation(input.state, CONSOLIDATION_DISPLAY_FACETS, input.llm, input.prompts, input.makeId, input.makeNow, input.minItems ?? 2);
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
