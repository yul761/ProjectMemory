import { Injectable, Optional } from "@nestjs/common";
import { flattenScopeFacts, groupFactsForDisplay, addNoteFact, type DisplayFact } from "@statecore/core";
import type { DigestState } from "@statecore/core";
import { prisma as defaultPrisma } from "@statecore/db";
import { randomUUID } from "node:crypto";

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
      await this.prisma.memoryEvent.updateMany({
        where: { id: match.evidenceId },
        data: { suppressedAt: new Date() }
      });
    }
    return { ok: true };
  }

  async addNote(userId: string, scopeId: string, text: string): Promise<{ ok: true }> {
    const snap = await this.prisma.digestStateSnapshot.findFirst({
      where: { scopeId },
      orderBy: { createdAt: "desc" }
    });

    if (snap) {
      const state = snap.state as unknown as DigestState;
      if (addNoteFact(state, text, () => randomUUID(), () => new Date().toISOString())) {
        await this.prisma.digestStateSnapshot.update({
          where: { id: snap.id },
          data: { state: state as any }
        });
      }
    } else {
      const state: DigestState = {
        stableFacts: { decisions: [] },
        workingNotes: {},
        todos: [],
        factRegistry: [],
        profile: {}
      };
      addNoteFact(state, text, () => randomUUID(), () => new Date().toISOString());
      await this.prisma.$transaction(async (tx: any) => {
        const digest = await tx.digest.create({
          data: { scopeId, summary: "Notes", changes: "", nextSteps: [] }
        });
        await tx.digestStateSnapshot.create({
          data: { scopeId, digestId: digest.id, state: state as any, consistency: null }
        });
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
