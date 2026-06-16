import type { MemoryEvent } from "../index";

export interface ExpectedState {
  goal?: string;
  decisions?: string[];
  constraints?: string[];
  absentDecisions?: string[];
}

export interface QueryScenario {
  query: string;
  relevantEventIds: string[];
}

export interface EvalScenario {
  name: string;
  description: string;
  events: MemoryEvent[];
  expectedState: ExpectedState;
  queries?: QueryScenario[];
}

export interface EvalMetrics {
  factRetentionRate: number;
  goalStabilityRate: number;
  decisionContinuityRate: number;
  conflictResolutionAccuracy: number;
  retrievalMRR: number;
  overallScore: number;
}

export interface EvalResult {
  scenario: string;
  description: string;
  metrics: EvalMetrics;
  details: {
    expectedDecisions: string[];
    survivedDecisions: string[];
    missingDecisions: string[];
    absentDecisionsPresent: string[];
    goalExpected: string | undefined;
    goalActual: string | undefined;
    goalSurvived: boolean;
    queryResults: Array<{ query: string; firstRelevantRank: number | null }>;
  };
}
