import { withDigestLock, DigestAlreadyRunningError, type LockRedis } from "./digest-lock";

export type RebuildData = {
  userId: string;
  scopeId: string;
  from?: string;
  to?: string;
  strategy?: "full" | "since_last_good";
  rebuildGroupId?: string;
};

// Rebuilds reuse the SAME digest-lock:<scopeId> key as digest_scope so the two
// can never run concurrently for one scope (both write digest + snapshot rows).
// Rebuilds can be slow, so use a longer TTL than the 300s digest_scope default.
export async function processRebuildDigestChainJob(
  lockRedis: LockRedis,
  data: RebuildData,
  runRebuild: (data: RebuildData) => Promise<void>,
  logger: { info: (...args: any[]) => void },
  ttlSeconds = 900
): Promise<{ ok: true; skipped?: boolean }> {
  try {
    await withDigestLock(lockRedis, data.scopeId, () => runRebuild(data), ttlSeconds);
    return { ok: true };
  } catch (err) {
    if (err instanceof DigestAlreadyRunningError) {
      logger.info({ scopeId: data.scopeId }, "Rebuild skipped — digest/rebuild already running for scope");
      return { ok: true, skipped: true };
    }
    throw err;
  }
}
