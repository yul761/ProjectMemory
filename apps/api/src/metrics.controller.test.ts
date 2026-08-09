import { describe, it, expect, vi } from "vitest";
import { MetricsService } from "./metrics.service";

describe("MetricsService.getDigestMetrics", () => {
  it("returns total, failed, successRate, lastRunAt, lastDurationMs, lastStatus", async () => {
    const mockPrisma = {
      digestJobLog: {
        count: vi.fn()
          .mockResolvedValueOnce(10)   // total
          .mockResolvedValueOnce(2),   // failed
        findFirst: vi.fn().mockResolvedValue({
          completedAt: new Date("2026-06-15T00:00:00Z"),
          durationMs: 3200,
          status: "success"
        })
      },
      // getDigestMetrics folds in getEmbeddingCoverage: 10 live events, 8 embedded.
      memoryEvent: {
        count: vi.fn().mockResolvedValueOnce(10).mockResolvedValueOnce(8)
      }
    } as any;

    const service = new MetricsService(mockPrisma);
    const result = await service.getDigestMetrics("scope-1");

    expect(result.total).toBe(10);
    expect(result.failed).toBe(2);
    expect(result.successRate).toBeCloseTo(0.8);
    expect(result.lastRunAt).toBe("2026-06-15T00:00:00.000Z");
    expect(result.lastDurationMs).toBe(3200);
    expect(result.lastStatus).toBe("success");
    // Asserted, not merely tolerated: this block was added to the return value
    // and the test kept passing over it, which is how the mock fell behind.
    expect(result.embeddings).toEqual({ events: 10, embedded: 8, missing: 2, coverage: 0.8 });
  });

  it("returns null successRate and nulls when no jobs logged", async () => {
    const mockPrisma = {
      digestJobLog: {
        count: vi.fn().mockResolvedValue(0),
        findFirst: vi.fn().mockResolvedValue(null)
      },
      memoryEvent: { count: vi.fn().mockResolvedValue(0) }
    } as any;

    const service = new MetricsService(mockPrisma);
    const result = await service.getDigestMetrics("scope-empty");

    expect(result.total).toBe(0);
    expect(result.successRate).toBeNull();
    expect(result.lastRunAt).toBeNull();
    expect(result.lastDurationMs).toBeNull();
    // No events is not 0% coverage — there is nothing to have covered.
    expect(result.embeddings).toEqual({ events: 0, embedded: 0, missing: 0, coverage: null });
  });
});
