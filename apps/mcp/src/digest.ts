import type { LitePrisma } from "./store";

/**
 * Digest trigger stub. Task 5 replaces this with the real threshold /
 * startup-catchup implementation; the embedded backend already calls it at the
 * points where digest maintenance belongs, so keyless callers get a real no-op
 * rather than a missing hook.
 */
export async function maybeRunDigest(_: {
  prisma: LitePrisma;
  userId: string;
  scopeId: string;
  env: NodeJS.ProcessEnv;
  reason: "startup" | "threshold";
}): Promise<void> {}
