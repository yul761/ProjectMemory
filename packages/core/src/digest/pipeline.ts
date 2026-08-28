// The digest-control pipeline: selection → classification → deltas → stage 2 →
// consistency gate → deterministic merge. Split out of digest-control.ts
// (2026-08-28) — bodies moved verbatim.
import type { Digest, MemoryEvent, ProjectScope } from "../index";
import { pruneForgottenFacts } from "../memory-facts";
import { consolidateChangedFacets } from "../facet-consolidation";
import type { DropRecord } from "../drop-log";
import { getDefaultFacetPack, type FacetPack } from "../facet-registry";
import { consistencyCheck } from "./consistency";
import { detectDeltas } from "./deltas";
import { classifyEventsWithLlm } from "./llm";
import { applyProfileFactsFromDigest, protectedStateMerge } from "./merge";
import { selectEventsForDigest } from "./selection";
import { generateDigestStage2 } from "./stage2";
import { createDefaultIdFactory, createDefaultNowFactory, deriveStateFromDigest, normalizeDigestState } from "./state";
import type {
  DeltaCandidate,
  DigestConsistencyResult,
  DigestControlConfig,
  DigestEvidenceRef,
  DigestOutput,
  DigestState,
  SelectionResult
} from "./types";

export async function runDigestControlPipeline(input: {
  scope: ProjectScope;
  lastDigest?: Digest | null;
  prevState?: DigestState | null;
  recentEvents: MemoryEvent[];
  llm: { chat: (messages: { role: "system" | "user"; content: string }[]) => Promise<string> };
  prompts: {
    digestStage2SystemPrompt: string;
    digestStage2UserPrompt: string;
    digestClassifySystemPrompt?: string;
    digestClassifyUserPrompt?: string;
    consolidateFacetSystemPrompt?: string;
    consolidateFacetUserPrompt?: string;
  };
  config: DigestControlConfig;
  forgottenFactKeys?: ReadonlySet<string>;
  forgottenFactContents?: readonly string[];
  /** The tenant's facet ontology. Defaults to the deployment pack. */
  pack?: FacetPack;
}): Promise<{
  digest: DigestOutput;
  state: DigestState;
  selection: SelectionResult;
  deltas: DeltaCandidate[];
  metrics: Record<string, number>;
  consistency: DigestConsistencyResult;
  /** Every piece of information this run discarded, and why. */
  dropLog: DropRecord[];
}> {
  const metrics: Record<string, number> = {};
  const dropLog: DropRecord[] = [];
  const pack = input.pack ?? getDefaultFacetPack();

  if (input.lastDigest) {
    // A document upsert rewrites content and stamps updatedAt but keeps the
    // original createdAt. Checking createdAt alone meant re-uploading a corrected
    // document never re-ran the digest: the state went on serving facts extracted
    // from the superseded version, and for a write-protected facet like identity
    // no later conversation could correct it either.
    const lastDigestAt = input.lastDigest.createdAt.getTime();
    const hasNewEvents = input.recentEvents.some((event) => {
      const changedAt = Math.max(event.createdAt.getTime(), event.updatedAt?.getTime() ?? 0);
      return changedAt > lastDigestAt;
    });
    if (!hasNewEvents) {
      const state = normalizeDigestState(input.prevState ?? deriveStateFromDigest(input.lastDigest));
      if (input.forgottenFactKeys && input.forgottenFactKeys.size > 0) {
        pruneForgottenFacts(state, input.forgottenFactKeys);
      }
      const digest: DigestOutput = {
        summary: input.lastDigest.summary,
        changes: [],
        nextSteps: input.lastDigest.nextSteps?.slice(0, 3) ?? []
      };
      const consistency = consistencyCheck({
        output: digest,
        previousDigest: input.lastDigest,
        protectedState: state
      });
      metrics.selectionMs = 0;
      metrics.deltaMs = 0;
      metrics.mergeMs = 0;
      metrics.generationMs = 0;
      return {
        digest,
        state,
        selection: {
          selectedEvents: [],
          documents: [],
          includeLastDigest: true,
          rationale: ["no_new_events_since_last_digest"]
        },
        deltas: [],
        metrics,
        consistency,
        dropLog
      };
    }
  }

  const tSelect = Date.now();
  const selection = selectEventsForDigest({
    lastDigest: input.lastDigest,
    recentEvents: input.recentEvents,
    eventBudgetTotal: input.config.eventBudgetTotal,
    eventBudgetDocs: input.config.eventBudgetDocs,
    eventBudgetStream: input.config.eventBudgetStream,
    charBudgetTotal: input.config.charBudgetTotal
  });
  metrics.selectionMs = Date.now() - tSelect;

  if (input.config.useLlmClassifier && input.prompts.digestClassifySystemPrompt && input.prompts.digestClassifyUserPrompt) {
    const tClassify = Date.now();
    await classifyEventsWithLlm({
      selectedEvents: selection.selectedEvents,
      llm: input.llm,
      systemPrompt: input.prompts.digestClassifySystemPrompt,
      userPromptTemplate: input.prompts.digestClassifyUserPrompt
    });
    metrics.classificationMs = Date.now() - tClassify;
  }

  const tDelta = Date.now();
  const lastDigestText = input.lastDigest
    ? [input.lastDigest.summary, input.lastDigest.changes, input.lastDigest.nextSteps.join(" ")].join("\n")
    : undefined;
  const deltas = detectDeltas({
    lastDigestText,
    selectedEvents: selection.selectedEvents,
    noveltyThreshold: input.config.noveltyThreshold
  });
  metrics.deltaMs = Date.now() - tDelta;

  const tMerge = Date.now();
  const state = protectedStateMerge({
    prevState: input.prevState ?? deriveStateFromDigest(input.lastDigest),
    deltaCandidates: deltas,
    documents: selection.documents,
    dropLog,
    pack
  });
  metrics.mergeMs = Date.now() - tMerge;

  if (input.forgottenFactKeys && input.forgottenFactKeys.size > 0) {
    pruneForgottenFacts(state, input.forgottenFactKeys);
  }

  const tGenerate = Date.now();
  const digest = await generateDigestStage2({
    scope: input.scope,
    lastDigest: input.lastDigest,
    protectedState: state,
    deltaCandidates: deltas,
    documents: selection.documents,
    llm: input.llm,
    systemPrompt: input.prompts.digestStage2SystemPrompt,
    userPromptTemplate: input.prompts.digestStage2UserPrompt,
    maxRetries: input.config.maxRetries,
    forgottenFacts: input.forgottenFactContents
  });
  metrics.generationMs = Date.now() - tGenerate;

  // Apply profile facts extracted by LLM from documents into stable state
  if (digest.profileFacts && digest.profileFacts.length > 0) {
    const streamEvents = deltas.map((d) => d.event).filter(Boolean);
    const latestStream = streamEvents.length > 0 ? streamEvents[streamEvents.length - 1] : null;
    const streamEvidence: DigestEvidenceRef | null = latestStream
      ? { id: latestStream.id, sourceType: "event" }
      : null;
    applyProfileFactsFromDigest(state, digest.profileFacts, selection.documents, streamEvidence, createDefaultIdFactory(), createDefaultNowFactory(), dropLog, pack);
  }

  // Prune forgotten facts BEFORE consolidation: consolidation rewrites/merges fact text,
  // and the content-hash prune can only match exact text — so a re-extracted forgotten
  // fact must be removed from the facet inputs before consolidation can reword it.
  // Consolidation never invents text (output derives only from inputs), so pruning inputs
  // here guarantees forgotten content cannot appear in the consolidated output.
  if (input.forgottenFactKeys && input.forgottenFactKeys.size > 0) {
    pruneForgottenFacts(state, input.forgottenFactKeys);
  }

  // Consolidate the facets this run just wrote to (dedupe paraphrase, tighten, drop
  // cross-facet dupes). Only when the caller supplied the consolidation prompts and the
  // run produced profile facts. Fail-open inside consolidateChangedFacets.
  if (
    input.prompts.consolidateFacetSystemPrompt &&
    input.prompts.consolidateFacetUserPrompt &&
    digest.profileFacts && digest.profileFacts.length > 0
  ) {
    const changedFacets = [...new Set(digest.profileFacts.map((pf) => pf.facet.trim()))];
    await consolidateChangedFacets({
      state,
      changedFacets,
      llm: input.llm,
      prompts: {
        systemPrompt: input.prompts.consolidateFacetSystemPrompt,
        userPromptTemplate: input.prompts.consolidateFacetUserPrompt
      },
      makeId: createDefaultIdFactory(),
      makeNow: createDefaultNowFactory(),
      dropLog,
      pack
    });
  }

  const resolvedGoal = input.scope.goal?.trim() || undefined;
  if (resolvedGoal && !state.stableFacts.goal) {
    state.stableFacts.goal = resolvedGoal;
  }

  const consistency = consistencyCheck({
    output: digest,
    previousDigest: input.lastDigest,
    protectedState: state,
    pack
  });

  // Defensive second prune: applyProfileFactsFromDigest (and any future post-merge mutation)
  // runs after the first prune and could in principle reintroduce a forgotten fact. Pruning
  // again here guarantees result.state is clean regardless of post-merge additions.
  if (input.forgottenFactKeys && input.forgottenFactKeys.size > 0) {
    pruneForgottenFacts(state, input.forgottenFactKeys);
  }

  return { digest, state, selection, deltas, metrics, consistency, dropLog };
}
