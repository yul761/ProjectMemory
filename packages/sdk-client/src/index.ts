import {
  AnswerInput,
  AnswerOutput,
  DigestEnqueueOutput,
  DigestRebuildInput,
  DigestListOutput,
  DigestRequestInput,
  MemoryEventInput,
  MemoryEventListOutput,
  MemoryEventOutput,
  ReminderCancelOutput,
  ReminderCreateInput,
  ReminderListOutput,
  ReminderOutput,
  RetrieveInput,
  RetrieveOutput,
  ScopeCreateInput,
  ScopeListOutput,
  ScopeOutput,
  StateOutput
} from "@project-memory/contracts";
import type { z } from "zod";

export interface ClientOptions {
  baseUrl: string;
  userId?: string;
  telegramUserId?: string;
  retry?: {
    retries?: number;
    minDelayMs?: number;
    maxDelayMs?: number;
  };
}

export class ApiError extends Error {
  status: number;
  data: unknown;

  constructor(message: string, status: number, data?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
  }
}

export class ProjectMemoryClient {
  private baseUrl: string;
  private userId?: string;
  private telegramUserId?: string;
  private retry: { retries: number; minDelayMs: number; maxDelayMs: number };

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.userId = options.userId;
    this.telegramUserId = options.telegramUserId;
    this.retry = {
      retries: options.retry?.retries ?? 2,
      minDelayMs: options.retry?.minDelayMs ?? 200,
      maxDelayMs: options.retry?.maxDelayMs ?? 1000
    };
  }

  private headers() {
    return {
      "Content-Type": "application/json",
      ...(this.userId ? { "x-user-id": this.userId } : {}),
      ...(this.telegramUserId ? { "x-telegram-user-id": this.telegramUserId } : {})
    };
  }

  private async request<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retry.retries; attempt += 1) {
      try {
        const response = await fetch(`${this.baseUrl}${path}`, {
          ...init,
          headers: { ...this.headers(), ...(init?.headers || {}) }
        });
        const data = await this.readJsonSafe(response);
        if (!response.ok) {
          if (this.shouldRetry(response.status) && attempt < this.retry.retries) {
            await this.sleep(this.backoff(attempt));
            continue;
          }
          throw new ApiError(`Request failed with status ${response.status}`, response.status, data);
        }
        return schema.parse(data);
      } catch (err) {
        lastError = err;
        if (attempt < this.retry.retries && this.isRetryableError(err)) {
          await this.sleep(this.backoff(attempt));
          continue;
        }
        throw err;
      }
    }
    throw lastError ?? new Error("Request failed");
  }

  private async readJsonSafe(response: Response) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  private shouldRetry(status: number) {
    return status === 429 || status === 502 || status === 503 || status === 504;
  }

  private isRetryableError(err: unknown) {
    if (err instanceof ApiError) return this.shouldRetry(err.status);
    return err instanceof TypeError;
  }

  private backoff(attempt: number) {
    const base = this.retry.minDelayMs * Math.pow(2, attempt);
    return Math.min(base, this.retry.maxDelayMs);
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  listScopes() {
    return this.request("/scopes", ScopeListOutput);
  }

  createScope(input: z.input<typeof ScopeCreateInput>) {
    return this.request("/scopes", ScopeOutput, {
      method: "POST",
      body: JSON.stringify(ScopeCreateInput.parse(input))
    });
  }

  setActiveScope(scopeId: string) {
    return this.request(`/scopes/${scopeId}/active`, StateOutput, { method: "POST" });
  }

  getState() {
    return this.request("/state", StateOutput);
  }

  ingestEvent(input: z.input<typeof MemoryEventInput>) {
    return this.request("/memory/events", MemoryEventOutput, {
      method: "POST",
      body: JSON.stringify(MemoryEventInput.parse(input))
    });
  }

  listEvents(scopeId: string, limit?: number, cursor?: string) {
    const params = new URLSearchParams({ scopeId, ...(limit ? { limit: String(limit) } : {}), ...(cursor ? { cursor } : {}) });
    return this.request(`/memory/events?${params.toString()}`, MemoryEventListOutput);
  }

  enqueueDigest(input: z.input<typeof DigestRequestInput>) {
    return this.request("/memory/digest", DigestEnqueueOutput, {
      method: "POST",
      body: JSON.stringify(DigestRequestInput.parse(input))
    });
  }

  rebuildDigest(input: z.input<typeof DigestRebuildInput>) {
    return this.request("/memory/digest/rebuild", DigestEnqueueOutput, {
      method: "POST",
      body: JSON.stringify(DigestRebuildInput.parse(input))
    });
  }

  listDigests(scopeId: string, limit?: number, cursor?: string) {
    const params = new URLSearchParams({ scopeId, ...(limit ? { limit: String(limit) } : {}), ...(cursor ? { cursor } : {}) });
    return this.request(`/memory/digests?${params.toString()}`, DigestListOutput);
  }

  retrieve(input: z.input<typeof RetrieveInput>) {
    return this.request("/memory/retrieve", RetrieveOutput, {
      method: "POST",
      body: JSON.stringify(RetrieveInput.parse(input))
    });
  }

  answer(input: z.input<typeof AnswerInput>) {
    return this.request("/memory/answer", AnswerOutput, {
      method: "POST",
      body: JSON.stringify(AnswerInput.parse(input))
    });
  }

  createReminder(input: z.input<typeof ReminderCreateInput>) {
    return this.request("/reminders", ReminderOutput, {
      method: "POST",
      body: JSON.stringify(ReminderCreateInput.parse(input))
    });
  }

  listReminders(status?: string, limit?: number, cursor?: string) {
    const params = new URLSearchParams({ ...(status ? { status } : {}), ...(limit ? { limit: String(limit) } : {}), ...(cursor ? { cursor } : {}) });
    return this.request(`/reminders?${params.toString()}`, ReminderListOutput);
  }

  cancelReminder(id: string) {
    return this.request(`/reminders/${id}/cancel`, ReminderCancelOutput, { method: "POST" });
  }
}
