import { protectedStateMerge, extractKind, importanceForKind, type DigestState, type MemoryEventKind } from "../digest-control";
import { RetrieveService } from "../index";
import type { MemoryEvent } from "../index";
import type { EvalScenario, EvalMetrics, EvalResult } from "./types";

function normalizeStr(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function containsFact(haystack: string[], needle: string): boolean {
  const normNeedle = normalizeStr(needle);
  const tokens = normNeedle.split(" ").filter((t) => t.length > 3);
  if (tokens.length === 0) return false;
  return haystack.some((item) => {
    const normItem = normalizeStr(item);
    return tokens.every((t) => normItem.includes(t));
  });
}

function runMiniDigest(events: MemoryEvent[], prevState: DigestState | null): DigestState {
  const docs = events.filter((e) => e.type === "document");
  const streamEvents = events.filter((e) => e.type === "stream");
  const deltaCandidates = streamEvents.map((event) => {
    const kind = extractKind(event.content) as MemoryEventKind;
    return {
      eventId: event.id,
      reason: "eval" as const,
      features: { kind, importanceScore: importanceForKind(kind, event.content), noveltyScore: 1 },
      event
    };
  });
  return protectedStateMerge({ prevState, deltaCandidates, documents: docs });
}

export function computeMetrics(state: DigestState, scenario: EvalScenario): Omit<EvalMetrics, "retrievalMRR" | "overallScore"> {
  const decisions = state.stableFacts.decisions ?? [];
  const constraints = state.stableFacts.constraints ?? [];
  const goal = state.stableFacts.goal ?? "";
  const expected = scenario.expectedState;

  const expectedDecisions = expected.decisions ?? [];
  const expectedConstraints = expected.constraints ?? [];
  const survivedDecisions = expectedDecisions.filter((d) => containsFact(decisions, d));
  const survivedConstraints = expectedConstraints.filter((c) => containsFact(constraints, c));
  const totalExpected = expectedDecisions.length + expectedConstraints.length;
  const totalSurvived = survivedDecisions.length + survivedConstraints.length;
  const factRetentionRate = totalExpected === 0 ? 1 : totalSurvived / totalExpected;

  const goalSurvived = expected.goal
    ? normalizeStr(expected.goal).split(" ").filter((t) => t.length > 3).every((t) => normalizeStr(goal).includes(t))
    : true;

  const decisionContinuityRate = expectedDecisions.length === 0 ? 1 : survivedDecisions.length / expectedDecisions.length;

  const absentDecisions = expected.absentDecisions ?? [];
  const wronglyPresent = absentDecisions.filter((d) => containsFact(decisions, d));
  const conflictResolutionAccuracy = absentDecisions.length === 0 ? 1 : 1 - wronglyPresent.length / absentDecisions.length;

  return {
    factRetentionRate: Number(factRetentionRate.toFixed(3)),
    goalStabilityRate: goalSurvived ? 1 : 0,
    decisionContinuityRate: Number(decisionContinuityRate.toFixed(3)),
    conflictResolutionAccuracy: Number(conflictResolutionAccuracy.toFixed(3))
  };
}

async function computeRetrievalMRR(scenario: EvalScenario): Promise<{ mrr: number; queryResults: Array<{ query: string; firstRelevantRank: number | null }> }> {
  if (!scenario.queries?.length) return { mrr: 1, queryResults: [] };

  const allEvents = scenario.events;
  const queryResults: Array<{ query: string; firstRelevantRank: number | null }> = [];

  for (const q of scenario.queries) {
    const relevantSet = new Set(q.relevantEventIds);
    const relevantIds = q.relevantEventIds;

    const mockEmbeddingModel = {
      embed: async (inputs: string[]) => {
        return inputs.map((input, idx) => {
          // idx 0 is the query vector
          if (idx === 0) return [1, 0, 0];
          const matchesRelevant = allEvents
            .filter((e) => relevantIds.includes(e.id))
            .some((e) => e.content === input);
          return matchesRelevant ? [1, 0, 0] : [0, 1, 0];
        });
      }
    };

    const mockDigestRepo = { findLatest: async () => null, listRecent: async () => ({ items: [], nextCursor: null }) } as any;
    const mockMemoryRepo = {
      listRecent: async () => ({ items: allEvents, nextCursor: null }),
      findByIds: async (ids: string[]) => allEvents.filter((e) => ids.includes(e.id))
    } as any;

    const service = new RetrieveService(mockDigestRepo, mockMemoryRepo, {
      embeddingModel: mockEmbeddingModel,
      useEmbeddingRerank: true,
      embeddingCandidateLimit: allEvents.length
    });

    const result = await service.retrieve("sc", allEvents.length, q.query);
    const rankedIds = result.events.map((e) => e.id);
    const firstRelevantIdx = rankedIds.findIndex((id) => relevantSet.has(id));
    queryResults.push({ query: q.query, firstRelevantRank: firstRelevantIdx === -1 ? null : firstRelevantIdx + 1 });
  }

  const mrr = queryResults.reduce((sum, qr) => sum + (qr.firstRelevantRank !== null ? 1 / qr.firstRelevantRank : 0), 0) / queryResults.length;
  return { mrr: Number(mrr.toFixed(3)), queryResults };
}

export async function runScenario(scenario: EvalScenario): Promise<EvalResult> {
  const state = runMiniDigest(scenario.events, null);
  const partialMetrics = computeMetrics(state, scenario);
  const { mrr, queryResults } = await computeRetrievalMRR(scenario);

  const metrics: EvalMetrics = {
    ...partialMetrics,
    retrievalMRR: mrr,
    overallScore: Number((
      partialMetrics.factRetentionRate * 0.25 +
      partialMetrics.goalStabilityRate * 0.15 +
      partialMetrics.decisionContinuityRate * 0.2 +
      partialMetrics.conflictResolutionAccuracy * 0.2 +
      mrr * 0.2
    ).toFixed(3))
  };

  const decisions = state.stableFacts.decisions ?? [];
  const expectedDecisions = scenario.expectedState.decisions ?? [];
  const absentDecisions = scenario.expectedState.absentDecisions ?? [];

  return {
    scenario: scenario.name,
    description: scenario.description,
    metrics,
    details: {
      expectedDecisions,
      survivedDecisions: expectedDecisions.filter((d) => containsFact(decisions, d)),
      missingDecisions: expectedDecisions.filter((d) => !containsFact(decisions, d)),
      absentDecisionsPresent: absentDecisions.filter((d) => containsFact(decisions, d)),
      goalExpected: scenario.expectedState.goal,
      goalActual: state.stableFacts.goal,
      goalSurvived: partialMetrics.goalStabilityRate === 1,
      queryResults
    }
  };
}

export async function runAllScenarios(scenarios: EvalScenario[]): Promise<EvalResult[]> {
  return Promise.all(scenarios.map(runScenario));
}
