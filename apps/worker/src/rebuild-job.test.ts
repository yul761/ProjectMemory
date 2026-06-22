import { describe, it, expect, vi } from "vitest";
import { processRebuildDigestChainJob, type RebuildData } from "./rebuild-job";
import type { LockRedis } from "./digest-lock";

function mockRedis(setResult: "OK" | null) {
  const setFn = vi.fn().mockResolvedValue(setResult);
  const evalFn = vi.fn().mockResolvedValue(1);
  return { mock: { set: setFn as any, eval: evalFn as any } as LockRedis, setFn, evalFn };
}
const logger = { info: vi.fn() };
const data: RebuildData = { userId: "u1", scopeId: "scope-1", strategy: "full" };

describe("processRebuildDigestChainJob", () => {
  it("runs the rebuild under the scope's digest-lock with a 900s TTL", async () => {
    const { mock, setFn } = mockRedis("OK");
    const runRebuild = vi.fn().mockResolvedValue(undefined);
    const result = await processRebuildDigestChainJob(mock, data, runRebuild, logger);
    expect(result).toEqual({ ok: true });
    expect(runRebuild).toHaveBeenCalledWith(data);
    expect(setFn).toHaveBeenCalledWith("digest-lock:scope-1", expect.any(String), "EX", 900, "NX");
  });

  it("skips (does not run rebuild) when the scope lock is already held", async () => {
    const { mock } = mockRedis(null);
    const runRebuild = vi.fn().mockResolvedValue(undefined);
    const result = await processRebuildDigestChainJob(mock, data, runRebuild, logger);
    expect(result).toEqual({ ok: true, skipped: true });
    expect(runRebuild).not.toHaveBeenCalled();
  });
});
