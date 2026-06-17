import { Queue } from "bullmq";
import { apiEnv } from "./env";
import { BullMqQueueAdapter, InMemoryQueueAdapter, type IQueue } from "./queue-adapter";

const isLite = process.env["STATECORE_MODE"] === "lite";

export let digestQueue: IQueue;
export let workingMemoryQueue: IQueue;
export let reminderQueue: IQueue;
export let embedQueue: IQueue;
export let classifyQueue: IQueue;

if (isLite) {
  digestQueue = new InMemoryQueueAdapter();
  workingMemoryQueue = new InMemoryQueueAdapter();
  reminderQueue = new InMemoryQueueAdapter();
  embedQueue = new InMemoryQueueAdapter();
  classifyQueue = new InMemoryQueueAdapter();
} else {
  const connection = { url: apiEnv.redisUrl as string };
  digestQueue = new BullMqQueueAdapter(new Queue("digest", { connection }));
  workingMemoryQueue = new BullMqQueueAdapter(new Queue("working-memory", { connection }));
  reminderQueue = new BullMqQueueAdapter(new Queue("reminder", { connection }));
  embedQueue = new BullMqQueueAdapter(new Queue("embed", { connection }));
  classifyQueue = new BullMqQueueAdapter(new Queue("classify", { connection }));
}

export function registerLiteHandlers(handlers: {
  workingMemory: (jobName: string, data: unknown) => Promise<void>;
}): void {
  if (!isLite) return;
  (workingMemoryQueue as InMemoryQueueAdapter).register(handlers.workingMemory);
}
