import { Injectable, Optional } from "@nestjs/common";
import { flattenScopeFacts, groupFactsForDisplay, type DisplayFact } from "@statecore/core";
import type { DigestState } from "@statecore/core";
import { prisma as defaultPrisma } from "@statecore/db";

@Injectable()
export class MemoryFactsService {
  constructor(@Optional() private readonly prisma: typeof defaultPrisma = defaultPrisma) {}

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
