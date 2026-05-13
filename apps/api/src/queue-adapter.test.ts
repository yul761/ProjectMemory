import { describe, it, expect, vi } from "vitest";
import { InMemoryQueueAdapter, BullMqQueueAdapter } from "./queue-adapter";

describe("InMemoryQueueAdapter", () => {
  it("resolves without error when no handler registered", async () => {
    const adapter = new InMemoryQueueAdapter();
    await expect(adapter.add("test-job", { x: 1 })).resolves.toBeUndefined();
  });

  it("calls registered handler with job name and data via setImmediate", async () => {
    const adapter = new InMemoryQueueAdapter();
    const handler = vi.fn().mockResolvedValue(undefined);
    adapter.register(handler);

    await adapter.add("my-job", { foo: "bar" });
    // handler not called yet (setImmediate defers it)
    expect(handler).not.toHaveBeenCalled();

    // flush setImmediate
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(handler).toHaveBeenCalledWith("my-job", { foo: "bar" });
  });

  it("swallows handler errors without throwing", async () => {
    const adapter = new InMemoryQueueAdapter();
    adapter.register(async () => { throw new Error("boom"); });

    await adapter.add("bad-job", {});
    await new Promise<void>((resolve) => setImmediate(resolve));
    // no throw — error is caught internally
  });
});

describe("BullMqQueueAdapter", () => {
  it("delegates add() to the underlying BullMQ queue", async () => {
    const mockQueue = { add: vi.fn().mockResolvedValue({ id: "1" }) };
    const adapter = new BullMqQueueAdapter(mockQueue as unknown as import("bullmq").Queue);
    await adapter.add("test-job", { x: 1 });
    expect(mockQueue.add).toHaveBeenCalledWith("test-job", { x: 1 });
  });
});
