// Cluster-safe data-lifecycle GC. Pure functions over minimal structural prisma
// types so they unit-test with stubs. Never deletes the latest digest per scope
// (the live state) or scheduled reminders.

function cutoffDate(retentionDays: number): Date {
  return new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
}

export type GcDigestPrisma = {
  digest: {
    findMany: (args: { where: { createdAt: { lt: Date } }; select: { id: true; scopeId: true } }) => Promise<{ id: string; scopeId: string }[]>;
    findFirst: (args: { where: { scopeId: string }; orderBy: Array<{ createdAt: "desc" } | { id: "desc" }>; select: { id: true } }) => Promise<{ id: string } | null>;
    deleteMany: (args: { where: { id: { in: string[] } } }) => Promise<{ count: number }>;
  };
  digestStateSnapshot: {
    deleteMany: (args: { where: { digestId: { in: string[] } } }) => Promise<{ count: number }>;
  };
};

// Keep the latest digest per scope (always); delete older digests + their paired
// snapshots. Snapshots are deleted BEFORE digests because DigestStateSnapshot has
// no ON DELETE CASCADE to Digest (FK would otherwise block the delete).
export async function runGcDigestsJob(
  prisma: GcDigestPrisma,
  retentionDays: number
): Promise<{ deletedDigests: number; deletedSnapshots: number }> {
  const cutoff = cutoffDate(retentionDays);
  const oldDigests = await prisma.digest.findMany({
    where: { createdAt: { lt: cutoff } },
    select: { id: true, scopeId: true }
  });
  const scopeIds = [...new Set(oldDigests.map((d) => d.scopeId))];
  let deletedDigests = 0;
  let deletedSnapshots = 0;
  for (const scopeId of scopeIds) {
    const latest = await prisma.digest.findFirst({
      where: { scopeId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true }
    });
    const doomedIds = oldDigests
      .filter((d) => d.scopeId === scopeId && d.id !== latest?.id)
      .map((d) => d.id);
    if (doomedIds.length === 0) continue;
    const snaps = await prisma.digestStateSnapshot.deleteMany({ where: { digestId: { in: doomedIds } } });
    const digs = await prisma.digest.deleteMany({ where: { id: { in: doomedIds } } });
    deletedSnapshots += snaps.count;
    deletedDigests += digs.count;
  }
  return { deletedDigests, deletedSnapshots };
}

export type GcJobLogPrisma = {
  digestJobLog: {
    deleteMany: (args: { where: { completedAt: { lt: Date } } }) => Promise<{ count: number }>;
  };
};

export async function runGcJobLogsJob(prisma: GcJobLogPrisma, retentionDays: number): Promise<{ count: number }> {
  return prisma.digestJobLog.deleteMany({ where: { completedAt: { lt: cutoffDate(retentionDays) } } });
}

export type GcReminderPrisma = {
  reminder: {
    // Use the literal union (a subtype of Prisma's ReminderStatus[]) to satisfy
    // Prisma's EnumReminderStatusFilter without importing generated Prisma types.
    deleteMany: (args: { where: { status: { in: Array<"sent" | "cancelled"> }; createdAt: { lt: Date } } }) => Promise<{ count: number }>;
  };
};

export async function runGcRemindersJob(prisma: GcReminderPrisma, retentionDays: number): Promise<{ count: number }> {
  return prisma.reminder.deleteMany({
    where: { status: { in: ["sent", "cancelled"] }, createdAt: { lt: cutoffDate(retentionDays) } }
  });
}
