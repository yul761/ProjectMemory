import { describe, it, expect, vi } from "vitest";
import { InMemoryQueueAdapter, BullMqQueueAdapter } from "./queue-adapter";

describe("InMemoryQueueAdapter", () => {
  it("resolves without error when no handler registered", async () => {
    const adapter = new InMemoryQueueAdapter();
    const result = await adapter.add("test-job", { x: 1 });
    expect(result).toHaveProperty("id");
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
    expect(mockQueue.add).toHaveBeenCalledWith("test-job", { x: 1 }, expect.anything());
  });

  // BullMQ defaults to a single attempt, and for embed/classify a single
  // transient failure removes an event from semantic search permanently — the
  // job never runs again and nothing but a log line records it. The retry policy
  // is the fix, so it is worth asserting rather than passing through as an
  // unexamined third argument, which is what let this test drift.
  it("enqueues with retries and exponential backoff, not BullMQ's single attempt", async () => {
    const mockQueue = { add: vi.fn().mockResolvedValue({ id: "1" }) };
    const adapter = new BullMqQueueAdapter(mockQueue as unknown as import("bullmq").Queue);

    await adapter.add("embed", { eventId: "e1" });

    const options = mockQueue.add.mock.calls[0][2];
    expect(options.attempts).toBeGreaterThan(1);
    expect(options.backoff).toEqual({ type: "exponential", delay: 5_000 });
  });

  it("returns the job id as a string", async () => {
    // BullMQ hands back a numeric id; callers store it as text.
    const mockQueue = { add: vi.fn().mockResolvedValue({ id: 42 }) };
    const adapter = new BullMqQueueAdapter(mockQueue as unknown as import("bullmq").Queue);
    expect(await adapter.add("j", {})).toEqual({ id: "42" });
  });
});
