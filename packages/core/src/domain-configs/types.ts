import type { FacetPack } from "../facet-registry";

export interface EntityTypeConfig {
  name: string;
  description: string;
  retention: "permanent" | "long-term" | "medium" | "short" | "discard";
  driftProtected: boolean;
  conflictDetectable: boolean;
  autoExpireAfterDays?: number;
}

export interface DomainConfig {
  name: string;
  /**
   * The state vocabulary that pairs with this domain's classifier vocabulary.
   *
   * These two were separate mechanisms at different granularities, and only
   * `personal` happened to line up: the other domains classified events into
   * types that no facet routed from, so stage 1 produced labels that landed
   * nowhere. A domain now carries both halves.
   */
  facetPack?: FacetPack;
  description: string;
  entityTypes: EntityTypeConfig[];
  classificationSystemPrompt: string;
  digestFocusHint: string;
  dailyReminderPrompt?: string;
  conflictPatterns?: string[];
  defaultPersonaPrompt?: string;
}
