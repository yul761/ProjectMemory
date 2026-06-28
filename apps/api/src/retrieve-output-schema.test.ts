import { describe, it, expect } from "vitest";
import { RetrieveOutput } from "@statecore/contracts";

// Regression: a sparse/empty scope ranks 0 candidates, so the engine emits
// retrieval.embeddingCandidateLimit = Math.min(24, ranked.length) = 0. The
// output contract previously required min(1), which made parseOutput throw and
// turned every retrieve on a near-empty scope into a 500 (breaking recall).
describe("RetrieveOutput — embeddingCandidateLimit zero regression", () => {
  const base = {
    digest: null,
    events: [],
    factRegistry: [],
    retrieval: {
      mode: "hybrid" as const,
      embeddingRequested: true,
      embeddingConfigured: true,
      reranked: false,
      candidateCount: 0,
      returnedCount: 0,
      matches: []
    }
  };

  it("accepts embeddingCandidateLimit = 0 (no ranked candidates)", () => {
    expect(() =>
      RetrieveOutput.parse({ ...base, retrieval: { ...base.retrieval, embeddingCandidateLimit: 0 } })
    ).not.toThrow();
  });

  it("still accepts a positive embeddingCandidateLimit", () => {
    expect(() =>
      RetrieveOutput.parse({ ...base, retrieval: { ...base.retrieval, embeddingCandidateLimit: 24 } })
    ).not.toThrow();
  });

  it("rejects a negative embeddingCandidateLimit", () => {
    expect(() =>
      RetrieveOutput.parse({ ...base, retrieval: { ...base.retrieval, embeddingCandidateLimit: -1 } })
    ).toThrow();
  });
});
