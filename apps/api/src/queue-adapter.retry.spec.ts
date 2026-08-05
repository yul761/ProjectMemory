import { describe, it, expect, vi } from "vitest";
import { BullMqQueueAdapter } from "./queue-adapter";

describe("BullMqQueueAdapter retry policy", () => {
  it("retries with backoff, so one transient failure does not lose the job forever", async () => {
    // embed_event is the case that matters: without retries a single rate limit
    // or timeout leaves that event permanently absent from semantic search, with
    // nothing but a log line to say so.
    const add = vi.fn(async () => ({ id: 7 }));
    const adapter = new BullMqQueueAdapter({ add } as never);

    await adapter.add("embed_event", { eventId: "e1" });

    expect(add).toHaveBeenCalledWith(
      "embed_event",
      { eventId: "e1" },
      expect.objectContaining({
        attempts: 3,
        backoff: { type: "exponential", delay: 5_000 }
      })
    );
  });

  it("returns the job id as a string", async () => {
    const adapter = new BullMqQueueAdapter({ add: async () => ({ id: 42 }) } as never);
    expect(await adapter.add("x", {})).toEqual({ id: "42" });
  });
});
