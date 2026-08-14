import type { LitePrisma } from "./store";

/**
 * How long a `DigestLock` row is honored before it is treated as abandoned
 * and reclaimed. Guards against a process that acquired the lock and crashed
 * (or was killed) before releasing it, which would otherwise strand the scope
 * with no digest catch-up forever.
 */
const LOCK_EXPIRY_MINUTES = 30;

/**
 * Serializes digest runs for one scope across every process sharing the same
 * SQLite file (the embedded backend has no queue to do this for it). The
 * `DigestLock` table has no `schema.lite.prisma` model — it is MCP-private, so
 * every operation here goes through raw SQL rather than a generated Prisma
 * delegate.
 *
 * Reclaims any lock older than `LOCK_EXPIRY_MINUTES` before attempting to
 * acquire, then relies on `INSERT OR IGNORE` for atomicity: the insert
 * either creates the row (lock acquired) or no-ops on the primary-key
 * conflict (another holder still has it).
 *
 * @param prisma - Lite client for the scope's SQLite file.
 * @param scopeId - Scope to lock.
 * @returns `true` if this call acquired the lock, `false` if another holder has it.
 */
export async function acquireDigestLock(prisma: LitePrisma, scopeId: string): Promise<boolean> {
  await prisma.$executeRawUnsafe(
    `DELETE FROM "DigestLock" WHERE "acquiredAt" < datetime('now', '-${LOCK_EXPIRY_MINUTES} minutes')`
  );
  const inserted = await prisma.$executeRawUnsafe(
    `INSERT OR IGNORE INTO "DigestLock" ("scopeId", "acquiredAt") VALUES (?, datetime('now'))`,
    scopeId
  );
  return inserted > 0;
}

/**
 * Releases a `DigestLock` row previously acquired by {@link acquireDigestLock}.
 * A release on a scope with no held lock (already expired, or never
 * acquired) is a no-op — the caller's `finally` block always runs this
 * unconditionally.
 *
 * @param prisma - Lite client for the scope's SQLite file.
 * @param scopeId - Scope to unlock.
 */
export async function releaseDigestLock(prisma: LitePrisma, scopeId: string): Promise<void> {
  await prisma.$executeRawUnsafe(`DELETE FROM "DigestLock" WHERE "scopeId" = ?`, scopeId);
}
