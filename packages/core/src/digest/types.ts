// Shared types and the DigestOutput schema for the digest-control pipeline.
// Split out of digest-control.ts (2026-08-28) — bodies moved verbatim.
import { z } from "zod";
import type { MemoryEvent } from "../index";

export type MemoryEventKind = "decision" | "constraint" | "todo" | "note" | "status" | "question" | "noise";

export interface EventFeatures {
  kind: MemoryEventKind;
  importanceScore: number;
  noveltyScore: number;
  docKey?: string;
  references?: string[];
}

export interface DigestState {
  stableFacts: {
    goal?: string;
    constraints?: string[];
    decisions: string[];
  };
  workingNotes: {
    openQuestions?: string[];
    risks?: string[];
    context?: string;
  };
  todos: string[];
  volatileContext?: string[];
  evidenceRefs?: DigestEvidenceRef[];
  confidence?: {
    goal?: number;
    constraints?: DigestStateValueConfidence[];
    decisions?: DigestStateValueConfidence[];
    todos?: DigestStateValueConfidence[];
    volatileContext?: DigestStateValueConfidence[];
    openQuestions?: DigestStateValueConfidence[];
    risks?: DigestStateValueConfidence[];
  };
  provenance?: {
    goal?: DigestEvidenceRef[];
    constraints?: DigestStateValueProvenance[];
    decisions?: DigestStateValueProvenance[];
    todos?: DigestStateValueProvenance[];
    volatileContext?: DigestStateValueProvenance[];
    openQuestions?: DigestStateValueProvenance[];
    risks?: DigestStateValueProvenance[];
  };
  transitionSummary?: Record<string, number>;
  recentChanges?: DigestStateChange[];
  factRegistry?: FactRegistryEntry[];
  /**
   * Facet name → fact lines. The keys come from the active facet pack, not from
   * this type: the engine stores and protects facts without knowing what the
   * facets mean. Existing data (an object keyed by the historical seven facets)
   * satisfies this shape as-is, so no migration is required.
   */
  profile?: Record<string, string[]>;
}

export interface FactRegistryEntry {
  id: string;
  content: string;
  type: "decision" | "constraint" | "profile";
  confidence: number;
  addedAt: string;
  evidenceId: string;
  evidenceType: "event" | "document";
  supersededBy?: string;
  facet?: string;
  /**
   * Concrete nouns from the evidence that the distilled fact text may have
   * dropped (tool names, file paths, product names). Retrieval scores a fact
   * on content plus entities, so a query in the evidence's vocabulary still
   * finds the fact after distillation rephrased it. Extracted by stage 2 at
   * digest time; costs nothing at query time.
   */
  entities?: string[];
  /**
   * Set when the fact left the active set without being replaced by a newer
   * version — capacity eviction, or an explicit forget. Distinct from
   * `supersededBy`, which points at the fact that took its place.
   */
  retiredAt?: string;
  retiredReason?: string;
}

export interface DigestEvidenceRef {
  id: string;
  sourceType: "document" | "event";
  key?: string;
  kind?: MemoryEventKind;
}

export interface DigestStateValueProvenance {
  value: string;
  refs: DigestEvidenceRef[];
}

export interface DigestStateValueConfidence {
  value: string;
  score: number;
}

export interface DigestStateChange {
  field: "goal" | "constraints" | "decisions" | "todos" | "volatileContext" | "openQuestions" | "risks";
  action: "set" | "add" | "remove" | "reaffirm";
  value: string;
  evidence: DigestEvidenceRef;
}

export interface SelectedEvent {
  event: MemoryEvent;
  features: EventFeatures;
}

export interface SelectionResult {
  selectedEvents: SelectedEvent[];
  documents: MemoryEvent[];
  includeLastDigest: boolean;
  rationale: string[];
}

export interface DeltaCandidate {
  eventId: string;
  reason: string;
  features: EventFeatures;
  event: MemoryEvent;
}

export interface DigestControlConfig {
  eventBudgetTotal: number;
  eventBudgetDocs: number;
  eventBudgetStream: number;
  /** Size ceiling for selected event content; guards the model context limit. */
  charBudgetTotal?: number;
  noveltyThreshold: number;
  maxRetries: number;
  useLlmClassifier: boolean;
  debug: boolean;
}

export interface DigestOutput {
  summary: string;
  changes: string[];
  nextSteps: string[];
  profileFacts?: { facet: string; value: string }[];
  /**
   * Present when the digest could not be generated cleanly and a fallback was
   * carried forward. Memory stays continuous; callers can surface or alert on
   * the degradation instead of it passing as a normal digest.
   */
  degraded?: { reason: string; errors: string[] };
}

export interface DigestConsistencyResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  /**
   * Human-readable detail for each error, in the same order as `errors`.
   *
   * The bare codes tell a retrying model *that* it contradicted something but
   * not what, so the retry is a re-roll rather than a correction. These name the
   * protected fact and the offending text so the fix instruction can be specific.
   */
  conflicts?: string[];
}

export const DigestOutputSchema = z.object({
  summary: z.string(),
  changes: z.array(z.string()),
  nextSteps: z.array(z.string()),
  profileFacts: z.array(z.object({
    facet: z.string(),
    value: z.string(),
    entities: z.array(z.string().max(64)).max(10).optional()
  })).optional()
});
