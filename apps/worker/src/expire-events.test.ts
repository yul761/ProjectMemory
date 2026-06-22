import { describe, it, expect, vi } from "vitest";
import { runExpireEventsJob } from "./expire-events";

describe("runExpireEventsJob", () => {
  it("deletes events whose expiresAt is in the past and returns the count", async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 3 });
    const prisma = { memoryEvent: { deleteMany } };
    const result = await runExpireEventsJob(prisma);
    expect(result).toEqual({ count: 3 });
    expect(deleteMany).toHaveBeenCalledTimes(1);
    const arg = deleteMany.mock.calls[0][0];
    expect(arg.where.expiresAt.lt).toBeInstanceOf(Date);
  });
});
