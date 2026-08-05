import { describe, it, expect } from "vitest";
import { MetricsService } from "./metrics.service";

function db(events: number, embedded: number) {
  return {
    memoryEvent: {
      count: async (args: { where: { embedding?: unknown } }) =>
        args.where.embedding ? embedded : events
    },
    digestJobLog: { count: async () => 0, findFirst: async () => null }
  } as never;
}

describe("embedding coverage", () => {
  it("reports how many events semantic search cannot see", async () => {
    const svc = new MetricsService(db(100, 93));
    expect(await svc.getEmbeddingCoverage("s1")).toEqual({
      events: 100,
      embedded: 93,
      missing: 7,
      coverage: 0.93
    });
  });

  it("returns null coverage rather than a misleading 0% for an empty scope", async () => {
    const svc = new MetricsService(db(0, 0));
    const r = await svc.getEmbeddingCoverage("s1");
    expect(r.coverage).toBeNull();
    expect(r.missing).toBe(0);
  });

  it("is included in the digest metrics payload", async () => {
    const svc = new MetricsService(db(10, 10));
    const m = await svc.getDigestMetrics("s1");
    expect(m.embeddings).toMatchObject({ events: 10, missing: 0, coverage: 1 });
  });
});
