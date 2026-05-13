import type { Queue } from "bullmq";

export interface IQueue {
  add(jobName: string, data: unknown): Promise<void>;
}

export class BullMqQueueAdapter implements IQueue {
  constructor(private readonly queue: Queue) {}

  async add(jobName: string, data: unknown): Promise<void> {
    await this.queue.add(jobName, data as object);
  }
}

export class InMemoryQueueAdapter implements IQueue {
  private handler: ((jobName: string, data: unknown) => Promise<void>) | null = null;

  register(handler: (jobName: string, data: unknown) => Promise<void>): void {
    this.handler = handler;
  }

  async add(jobName: string, data: unknown): Promise<void> {
    if (!this.handler) return;
    const h = this.handler;
    setImmediate(() => {
      h(jobName, data).catch((err: unknown) => {
        console.error(`[InMemoryQueue] job ${jobName} failed:`, err);
      });
    });
  }
}
