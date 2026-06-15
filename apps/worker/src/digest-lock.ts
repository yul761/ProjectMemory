import { randomUUID } from "crypto";

const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

export class DigestAlreadyRunningError extends Error {
  constructor(scopeId: string) {
    super(`DigestAlreadyRunning:${scopeId}`);
    this.name = "DigestAlreadyRunningError";
  }
}

export interface LockRedis {
  set(key: string, val: string, exMode: "EX", ttl: number, nxMode: "NX"): Promise<"OK" | null>;
  eval(script: string, numkeys: number, key: string, token: string): Promise<number>;
}

export async function withDigestLock<T>(
  redis: LockRedis,
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
    await redis.eval(RELEASE_SCRIPT, 1, key, token);
  }
}
