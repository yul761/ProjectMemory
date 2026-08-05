/**
 * Single source of truth for profile facets.
 *
 * Before this file the same 7-facet ontology was duplicated in five places
 * (DISPLAY_FACETS, PROFILE_FACET_CAPS, PROFILE_FACET_ROUTING, FACET_TO_GROUP,
 * CONSOLIDATION_DISPLAY_FACETS) plus the stage-2 prompt. The copies could drift
 * apart, and — more importantly — they hard-wired a personal-life ontology into
 * an engine meant to be domain-neutral. A fact that did not fit one of the seven
 * categories was silently discarded, so StateCore could not store what it had
 * not been told to look for.
 *
 * The core now stores, protects, supersedes and retrieves. What the facets
 * *mean* is supplied by a pack.
 */
export interface FacetDefinition {
  name: string;
  /** Maximum concurrent active facts in this facet. */
  cap: number;
  /** Protected facets are never overridden by stream events, nor evicted to make room. */
  writeProtected: boolean;
  /** null = never surfaced through the display API (identity stays private). */
  displayGroup: string | null;
  /** Shown to the extraction LLM; also used as the consolidation hint. */
  description: string;
}

export interface FacetPack {
  name: string;
  facets: FacetDefinition[];
}

/** Fallback cap for a facet the active pack does not define. */
const DEFAULT_CAP = 8;

/**
 * The historical StateCore ontology, preserved value-for-value so existing
 * DigestState.profile data keeps working with no migration.
 *
 * Declaration order is load-bearing: it determines the display group order
 * (see `groupOrder` in memory-facts.ts). This list is ordered to reproduce the
 * previous hardcoded order — Schedule, People, Style, Projects, Notes.
 */
export const PERSONAL_PROFILE_PACK: FacetPack = {
  name: "personal",
  facets: [
    {
      name: "followUps",
      cap: 10,
      writeProtected: false,
      displayGroup: "Schedule",
      description:
        'commitments or things to remember/do (e.g. "周四 2 点看牙医", "给供应商打电话问 Q3").'
    },
    {
      name: "relationships",
      cap: 10,
      writeProtected: false,
      displayGroup: "People",
      description:
        'important people in the user\'s life (e.g. "妈妈住在上海", "同事 Alex 负责后端").'
    },
    {
      name: "style",
      cap: 6,
      writeProtected: false,
      displayGroup: "Style",
      description:
        'the user\'s tastes, communication preferences, AND their 行事作风 — how they like things handled: their working style, decision patterns, standards, and what they value (e.g. "喜欢 teal 色", "偏好简洁的回答、先给结论再给细节", "重要决定前喜欢先看数据", "不喜欢被反复追问，给空间", "做事追求效率、讨厌拖延"). Capture durable working traits, not one-off moods.'
    },
    {
      name: "goals",
      cap: 8,
      writeProtected: true,
      displayGroup: "Projects",
      description: 'things the user wants to achieve (e.g. "想减肥", "7 月上线 Remi").'
    },
    {
      name: "ongoing",
      cap: 8,
      writeProtected: false,
      displayGroup: "Projects",
      description: 'projects or activities in progress (e.g. "在做盲盒生意", "在学西班牙语").'
    },
    {
      name: "notes",
      cap: 30,
      writeProtected: false,
      displayGroup: "Notes",
      description:
        'durable, useful information that is NOT a personal-profile fact — knowledge worth keeping long-term such as project/product details, decisions, processes, or facts the user states or asks you to remember (e.g. "API keys rotate every 90 days", "公司差旅每天上限 $75", "客户 X 合同 9 月续签"). Be selective: capture only things with lasting value; do NOT store small talk, transient logistics, greetings, or one-off chit-chat.'
    },
    {
      name: "identity",
      cap: 15,
      writeProtected: true,
      displayGroup: null,
      description:
        "durable personal facts from documents (resume/bio): 工作经历, 教育, 技能, 联系方式."
    }
  ]
};

let activePack: FacetPack = clonePack(PERSONAL_PROFILE_PACK);
let byName = indexPack(activePack);

function indexPack(pack: FacetPack): Map<string, FacetDefinition> {
  return new Map(pack.facets.map((facet) => [facet.name, facet]));
}

/**
 * Packs are cloned on install. `overrideFacetCaps` mutates definitions in place,
 * and without this the exported PERSONAL_PROFILE_PACK constant would carry one
 * deployment's overrides forever — reinstalling it would not reset anything.
 */
function clonePack(pack: FacetPack): FacetPack {
  return { name: pack.name, facets: pack.facets.map((facet) => ({ ...facet })) };
}

export function setFacetPack(pack: FacetPack): void {
  activePack = clonePack(pack);
  byName = indexPack(activePack);
}

export function getFacetPack(): FacetPack {
  return activePack;
}

export function listFacets(): string[] {
  return activePack.facets.map((facet) => facet.name);
}

export function isRegisteredFacet(facet: string): boolean {
  return byName.has(facet);
}

export function getFacetCap(facet: string): number {
  return byName.get(facet)?.cap ?? DEFAULT_CAP;
}

export function isWriteProtectedFacet(facet: string): boolean {
  return byName.get(facet)?.writeProtected ?? false;
}

export function getFacetDisplayGroup(facet: string): string | null {
  return byName.get(facet)?.displayGroup ?? null;
}

export function getFacetDescription(facet: string): string {
  return byName.get(facet)?.description ?? "";
}

/**
 * Per-facet cap overrides, applied on top of the active pack.
 *
 * Deployments hit different scales — a resume can carry far more than 15
 * identity facts — so the cap is an operational knob, not an ontology decision.
 */
export function overrideFacetCaps(caps: Record<string, number>): void {
  for (const [name, cap] of Object.entries(caps)) {
    const definition = byName.get(name);
    if (definition && Number.isFinite(cap) && cap > 0) definition.cap = cap;
  }
}

/** Renders the active pack's facets as the `Allowed facets:` block of the stage-2 prompt. */
export function buildFacetPromptSection(): string {
  return activePack.facets.map((facet) => `  - "${facet.name}": ${facet.description}`).join("\n");
}
