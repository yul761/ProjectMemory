import { describe, it, expect, vi } from "vitest";
import { withDigestLock, DigestAlreadyRunningError } from "./digest-lock";

describe("withDigestLock", () => {
  it("runs the job when lock is acquired", async () => {
    const redis = {
      set: vi.fn().mockResolvedValue("OK"),
      del: vi.fn().mockResolvedValue(1)
    } as any;

    const result = await withDigestLock(redis, "scope-1", async () => "done");
    expect(result).toBe("done");
    expect(redis.set).toHaveBeenCalledWith(
      "digest-lock:scope-1",
      expect.any(String),
      "EX",
      300,
      "NX"
    );
    expect(redis.del).toHaveBeenCalledWith("digest-lock:scope-1");
  });

  it("throws DigestAlreadyRunningError when lock is taken", async () => {
    const redis = {
      set: vi.fn().mockResolvedValue(null),
      del: vi.fn()
    } as any;

    await expect(
      withDigestLock(redis, "scope-1", async () => "done")
    ).rejects.toThrow("DigestAlreadyRunning");
    expect(redis.del).not.toHaveBeenCalled();
  });

  it("releases lock even when job throws", async () => {
    const redis = {
      set: vi.fn().mockResolvedValue("OK"),
      del: vi.fn().mockResolvedValue(1)
    } as any;

    await expect(
      withDigestLock(redis, "scope-1", async () => { throw new Error("job failed"); })
    ).rejects.toThrow("job failed");
    expect(redis.del).toHaveBeenCalledWith("digest-lock:scope-1");
  });
});
