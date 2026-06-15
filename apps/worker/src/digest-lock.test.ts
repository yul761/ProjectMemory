import { describe, it, expect, vi } from "vitest";
import { withDigestLock, DigestAlreadyRunningError, type LockRedis } from "./digest-lock";

function mockRedis(setResult: "OK" | null): { mock: LockRedis; setFn: ReturnType<typeof vi.fn>; evalFn: ReturnType<typeof vi.fn> } {
  const setFn = vi.fn().mockResolvedValue(setResult);
  const evalFn = vi.fn().mockResolvedValue(1);
  return {
    mock: { set: setFn as any, eval: evalFn as any } as LockRedis,
    setFn,
    evalFn
  };
}

describe("withDigestLock", () => {
  it("runs the job when lock is acquired", async () => {
    const { mock, setFn, evalFn } = mockRedis("OK");

    const result = await withDigestLock(mock, "scope-1", async () => "done");
    expect(result).toBe("done");
    expect(setFn).toHaveBeenCalledWith("digest-lock:scope-1", expect.any(String), "EX", 300, "NX");
    expect(evalFn).toHaveBeenCalledWith(expect.any(String), 1, "digest-lock:scope-1", expect.any(String));
  });

  it("throws DigestAlreadyRunningError when lock is taken", async () => {
    const { mock, evalFn } = mockRedis(null);

    await expect(
      withDigestLock(mock, "scope-1", async () => "done")
    ).rejects.toThrow("DigestAlreadyRunning");
    expect(evalFn).not.toHaveBeenCalled();
  });

  it("releases lock via Lua CAS even when job throws", async () => {
    const { mock, evalFn } = mockRedis("OK");

    await expect(
      withDigestLock(mock, "scope-1", async () => { throw new Error("job failed"); })
    ).rejects.toThrow("job failed");
    expect(evalFn).toHaveBeenCalledWith(expect.any(String), 1, "digest-lock:scope-1", expect.any(String));
  });
});
