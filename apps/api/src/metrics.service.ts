import { Injectable } from "@nestjs/common";
import { prisma as defaultPrisma } from "@statecore/db";

@Injectable()
export class MetricsService {
  constructor(private readonly db: typeof defaultPrisma = defaultPrisma) {}

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
      lastStatus: last?.status ?? null
    };
  }
}
