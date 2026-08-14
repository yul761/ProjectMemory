import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shouldDigest, acquireDigestLock, releaseDigestLock, maybeRunDigest } from "../src/digest";
import { openStore } from "../src/store";

describe("digest trigger", () => {
  it("fires only at/over threshold", () => {
    expect(shouldDigest(19, 20)).toBe(false);
    expect(shouldDigest(20, 20)).toBe(true);
  });

  it("second lock acquisition on the same scope fails until released", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sc-mcp-lock-"));
    const store = await openStore(dir);
    try {
      const scopeId = "scope-under-lock";
      expect(await acquireDigestLock(store.prisma, scopeId)).toBe(true);
      expect(await acquireDigestLock(store.prisma, scopeId)).toBe(false);
      await releaseDigestLock(store.prisma, scopeId);
      expect(await acquireDigestLock(store.prisma, scopeId)).toBe(true);
    } finally {
      await store.close();
    }
  });

  // Regression for a Critical review finding: maybeRunDigest's pending-count
  // reads (prisma.digest.findFirst, prisma.memoryEvent.count) ran before its
  // try/catch, and both embedded.ts call sites invoke it fire-and-forget
  // (`void maybeRunDigest(...)`) — a rejection there was an unhandled
  // promise rejection, which crashes the process on modern Node. A stubbed
  // prisma whose very first call (digest.findFirst) rejects reaches that
  // pre-lock path without a real LLM call ever happening.
  it("never rejects, even when a pre-lock prisma read fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const failingPrisma = {
        digest: { findFirst: () => Promise.reject(new Error("database is locked")) }
      } as any;

      await expect(
        maybeRunDigest({
          prisma: failingPrisma,
          userId: "local",
          scopeId: "scope-boom",
          env: { FEATURE_LLM: "true", MODEL_API_KEY: "test-key" } as any,
          reason: "threshold"
        })
      ).resolves.toBeUndefined();

      expect(errorSpy).toHaveBeenCalledWith("[statecore-mcp] digest run failed", expect.any(Error));
    } finally {
      errorSpy.mockRestore();
    }
  });
});
