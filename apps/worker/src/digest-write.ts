// Atomic digest + state-snapshot writer.
// Wraps the two prisma creates in an interactive $transaction so that a failed
// snapshot write rolls back the digest — no snapshotless latest-digest for
// data_gc to mishandle.

export type DigestWriteTx = {
  digest: { create: (args: { data: any }) => Promise<{ id: string }> };
  digestStateSnapshot: { create: (args: { data: any }) => Promise<unknown> };
};

export type DigestWritePrisma = {
  $transaction: <T>(fn: (tx: DigestWriteTx) => Promise<T>) => Promise<T>;
};

export interface CreateDigestWithSnapshotInput {
  scopeId: string;
  summary: string;
  changes: string;       // already-joined "- ..." string
  nextSteps: unknown;
  state: unknown;
  consistency: unknown;
  /** `{ rationale, drops }` — what the selection stage kept and what it discarded. */
  selectionLog?: unknown;
  rebuildGroupId?: string;
}

export async function createDigestWithSnapshot(
  prisma: DigestWritePrisma,
  input: CreateDigestWithSnapshotInput
): Promise<{ id: string }> {
  return prisma.$transaction(async (tx) => {
    const digest = await tx.digest.create({
      data: {
        scopeId: input.scopeId,
        summary: input.summary,
        changes: input.changes,
        nextSteps: input.nextSteps,
        ...(input.selectionLog !== undefined ? { selectionLog: input.selectionLog } : {}),
        ...(input.rebuildGroupId ? { rebuildGroupId: input.rebuildGroupId } : {})
      } as any
    });
    await tx.digestStateSnapshot.create({
      data: {
        scopeId: input.scopeId,
        digestId: digest.id,
        state: input.state,
        consistency: input.consistency
      } as any
    });
    return digest;
  });
}
