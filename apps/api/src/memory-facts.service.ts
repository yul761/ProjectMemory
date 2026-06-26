import { Injectable, Optional } from "@nestjs/common";
import { flattenScopeFacts, groupFactsForDisplay, type DisplayFact } from "@statecore/core";
import type { DigestState } from "@statecore/core";
import { prisma as defaultPrisma } from "@statecore/db";

@Injectable()
export class MemoryFactsService {
  constructor(@Optional() private readonly prisma: typeof defaultPrisma = defaultPrisma) {}

  async forgetFact(userId: string, scopeId: string, factKey: string): Promise<{ ok: true }> {
    const snapshot = await this.prisma.digestStateSnapshot.findFirst({
      where: { scopeId },
      orderBy: { createdAt: "desc" }
    });
    const facts = snapshot ? flattenScopeFacts(snapshot.state as unknown as DigestState) : [];
    const match = facts.find((f) => f.factKey === factKey);
    const contentSnapshot = match?.text ?? "";

    await this.prisma.forgottenFact.upsert({
      where: { scopeId_factKey: { scopeId, factKey } },
      create: { userId, scopeId, factKey, contentSnapshot },
      update: {}
    });

    if (match?.evidenceId) {
      await this.prisma.memoryEvent.update({
        where: { id: match.evidenceId },
        data: { suppressedAt: new Date() }
      });
    }
    return { ok: true };
  }

  async getFacts(scopeId: string) {
    const [snapshot, forgotten] = await Promise.all([
      this.prisma.digestStateSnapshot.findFirst({ where: { scopeId }, orderBy: { createdAt: "desc" } }),
      this.prisma.forgottenFact.findMany({ where: { scopeId } })
    ]);
    if (!snapshot) return [];
    const forgottenKeys = new Set(forgotten.map((f) => f.factKey));
    const facts: DisplayFact[] = flattenScopeFacts(snapshot.state as unknown as DigestState).filter(
      (f) => !forgottenKeys.has(f.factKey)
    );
    return groupFactsForDisplay(facts);
  }
}
