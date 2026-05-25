import type { Queue } from "bullmq";

export interface IQueue {
  add(jobName: string, data: unknown): Promise<{ id: string }>;
  getJobCounts(): Promise<{ active: number; waiting: number; failed: number }>;
}

export class BullMqQueueAdapter implements IQueue {
  constructor(private readonly queue: Queue) {}

  async add(jobName: string, data: unknown): Promise<{ id: string }> {
    const job = await this.queue.add(jobName, data as object);
    return { id: String(job.id) };
  }

  async getJobCounts() {
    const counts = await this.queue.getJobCounts("active", "waiting", "failed");
    return { active: counts.active ?? 0, waiting: counts.waiting ?? 0, failed: counts.failed ?? 0 };
  }
}

export class InMemoryQueueAdapter implements IQueue {
  private handler: ((jobName: string, data: unknown) => Promise<void>) | null = null;

  register(handler: (jobName: string, data: unknown) => Promise<void>): void {
    this.handler = handler;
  }

  async add(jobName: string, data: unknown): Promise<{ id: string }> {
    if (this.handler) {
      const h = this.handler;
      setImmediate(() => {
        h(jobName, data).catch((err: unknown) => {
          console.error(`[InMemoryQueue] job ${jobName} failed:`, err);
        });
      });
    }
    return { id: `lite-${Date.now()}` };
  }

  async getJobCounts() {
    return { active: 0, waiting: 0, failed: 0 };
  }
}
