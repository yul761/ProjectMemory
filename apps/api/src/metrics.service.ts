import { Injectable, Optional } from "@nestjs/common";
import { prisma as defaultPrisma } from "@statecore/db";

@Injectable()
export class MetricsService {
  constructor(@Optional() private readonly db: typeof defaultPrisma = defaultPrisma) {}

  /**
   * Events with no embedding are invisible to semantic search — permanently, and
   * without any error to look at, since the embed job runs asynchronously after
   * ingest. Retries make that rare; this makes it findable when it still happens.
   */
  async getEmbeddingCoverage(scopeId: string) {
    const [events, embedded] = await Promise.all([
      this.db.memoryEvent.count({ where: { scopeId, suppressedAt: null } }),
      this.db.memoryEvent.count({
        where: { scopeId, suppressedAt: null, embedding: { isNot: null } }
      })
    ]);
    return {
      events,
      embedded,
      missing: events - embedded,
      coverage: events === 0 ? null : embedded / events
    };
  }

  async getDigestMetrics(scopeId: string) {
    const [total, failed, last] = await Promise.all([
      this.db.digestJobLog.count({ where: { scopeId } }),
      this.db.digestJobLog.count({ where: { scopeId, status: "failed" } }),
      this.db.digestJobLog.findFirst({
        where: { scopeId },
        orderBy: { completedAt: "desc" }
      })
    ]);

    return {
      total,
      failed,
      successRate: total === 0 ? null : (total - failed) / total,
      lastRunAt: last?.completedAt.toISOString() ?? null,
      lastDurationMs: last?.durationMs ?? null,
      lastStatus: last?.status ?? null,
      embeddings: await this.getEmbeddingCoverage(scopeId)
    };
  }
}
