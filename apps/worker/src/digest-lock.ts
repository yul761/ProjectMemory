import { randomUUID } from "crypto";

export class DigestAlreadyRunningError extends Error {
  constructor(scopeId: string) {
    super(`DigestAlreadyRunning:${scopeId}`);
    this.name = "DigestAlreadyRunningError";
  }
}

export async function withDigestLock<T>(
  redis: { set: (key: string, val: string, ex: string, ttl: number, nx: string) => Promise<string | null>; del: (key: string) => Promise<number> },
  scopeId: string,
  fn: () => Promise<T>,
  ttlSeconds = 300
): Promise<T> {
  const key = `digest-lock:${scopeId}`;
  const token = randomUUID();
  const acquired = await redis.set(key, token, "EX", ttlSeconds, "NX");
  if (!acquired) {
    throw new DigestAlreadyRunningError(scopeId);
  }
  try {
    return await fn();
  } finally {
    await redis.del(key);
  }
}
