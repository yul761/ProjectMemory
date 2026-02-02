import {
  AnswerInput,
  AnswerOutput,
  DigestEnqueueOutput,
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
}

export class ProjectMemoryClient {
  private baseUrl: string;
  private userId?: string;
  private telegramUserId?: string;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.userId = options.userId;
    this.telegramUserId = options.telegramUserId;
  }

  private headers() {
    return {
      "Content-Type": "application/json",
      ...(this.userId ? { "x-user-id": this.userId } : {}),
      ...(this.telegramUserId ? { "x-telegram-user-id": this.telegramUserId } : {})
    };
  }

  private async request<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { ...this.headers(), ...(init?.headers || {}) }
    });
    const data = await response.json();
    return schema.parse(data);
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
