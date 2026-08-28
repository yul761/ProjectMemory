// digest-control — barrel for the digest pipeline, split into src/digest/ on
// 2026-08-28. Import surface is unchanged: everything this file exported as a
// single module is re-exported here by name. Internals that modules export for
// each other (similarity helpers, registry mutators, prompt utilities) are
// deliberately NOT re-exported.
//
// Module map:
//   digest/types.ts          shared types + DigestOutputSchema
//   digest/state.ts          DigestState defaults, normalization, confidence scoring
//   digest/similarity.ts     tokenization, Jaccard, CJK-aware matching
//   digest/parse.ts          digest-text parsers (goal, prefixed lines)
//   digest/selection.ts      event selection, dedup, char budget
//   digest/deltas.ts         delta detection
//   digest/fact-registry.ts  fact promotion / retirement / supersession, note path
//   digest/merge.ts          the deterministic merge (protectedStateMerge)
//   digest/llm.ts            stage-1 LLM classification
//   digest/consistency.ts    digest/state alignment + consistency gate
//   digest/stage2.ts         stage-2 prompt assembly and generation
//   digest/pipeline.ts       runDigestControlPipeline

export type {
  MemoryEventKind,
  EventFeatures,
  DigestState,
  FactRegistryEntry,
  DigestEvidenceRef,
  DigestStateValueProvenance,
  DigestStateValueConfidence,
  DigestStateChange,
  SelectedEvent,
  SelectionResult,
  DeltaCandidate,
  DigestControlConfig,
  DigestOutput,
  DigestConsistencyResult
} from "./digest/types";
export { DigestOutputSchema } from "./digest/types";

export { normalizeDigestState } from "./digest/state";
export { sameFactCjkAware } from "./digest/similarity";
export { extractKind, importanceForKind, DEFAULT_DIGEST_CHAR_BUDGET, selectEventsForDigest } from "./digest/selection";
export { detectDeltas } from "./digest/deltas";
export {
  getActiveFactRegistry,
  MAX_FACT_CHARS,
  isFactSized,
  retireFact,
  addNoteFact
} from "./digest/fact-registry";
export type { AddNoteResult } from "./digest/fact-registry";
export { applyProfileFactsFromDigest, protectedStateMerge } from "./digest/merge";
export { classifyEventsWithLlm } from "./digest/llm";
export { consistencyCheck } from "./digest/consistency";
export {
  STAGE2_SECTION_CHAR_BUDGET,
  STAGE2_MAX_CHUNKS,
  chunkDeltaCandidates,
  boundProtectedState,
  generateDigestStage2
} from "./digest/stage2";
export { runDigestControlPipeline } from "./digest/pipeline";
