import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shouldDigest, acquireDigestLock, releaseDigestLock } from "../src/digest";
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
});
