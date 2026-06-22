export type ExpirePrisma = {
  memoryEvent: {
    deleteMany: (args: { where: { expiresAt: { lt: Date } } }) => Promise<{ count: number }>;
  };
};

// Purge MemoryEvent rows past their expiresAt. Idempotent — safe to run from a
// single cluster-wide repeatable job.
export async function runExpireEventsJob(prisma: ExpirePrisma): Promise<{ count: number }> {
  return prisma.memoryEvent.deleteMany({ where: { expiresAt: { lt: new Date() } } });
}
