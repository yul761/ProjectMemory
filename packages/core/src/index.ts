import pino from "pino";
import { createHash } from "crypto";
import { z } from "zod";

export const logger = pino({ level: process.env.LOG_LEVEL || "info" });

export type ProjectStage = "idea" | "build" | "test" | "launch";
export type MemoryType = "stream" | "document";
export type MemorySource = "telegram" | "cli" | "api" | "sdk";
export type ReminderStatus = "scheduled" | "sent" | "cancelled";

export interface ProjectScope {
  id: string;
  userId: string;
  name: string;
  goal?: string | null;
  stage: ProjectStage;
  createdAt: Date;
}

export interface UserState {
  userId: string;
  activeProjectId?: string | null;
}

export interface MemoryEvent {
  id: string;
  userId: string;
  scopeId: string;
  type: MemoryType;
  source: MemorySource;
  key?: string | null;
  content: string;
  contentHash?: string | null;
  createdAt: Date;
  updatedAt?: Date | null;
}

export interface Digest {
  id: string;
  scopeId: string;
  summary: string;
  changes: string;
  nextSteps: string[];
  rebuildGroupId?: string | null;
  createdAt: Date;
}

export interface Reminder {
  id: string;
  userId: string;
  scopeId?: string | null;
  dueAt: Date;
  text: string;
  status: ReminderStatus;
  createdAt: Date;
}

export interface ProjectRepo {
  create: (data: { userId: string; name: string; goal?: string | null; stage?: ProjectStage }) => Promise<ProjectScope>;
  listByUser: (userId: string) => Promise<ProjectScope[]>;
  findById: (scopeId: string, userId: string) => Promise<ProjectScope | null>;
}

export interface UserStateRepo {
  getByUserId: (userId: string) => Promise<UserState | null>;
  upsertActiveProject: (userId: string, scopeId: string | null) => Promise<UserState>;
}

export interface MemoryRepo {
  create: (data: {
    userId: string;
    scopeId: string;
    type: MemoryType;
    source: MemorySource;
    key?: string | null;
    content: string;
    contentHash?: string | null;
  }) => Promise<MemoryEvent>;
  upsertDocument: (data: {
    userId: string;
    scopeId: string;
    source: MemorySource;
    key: string;
    content: string;
    contentHash?: string | null;
  }) => Promise<MemoryEvent>;
  listRecent: (scopeId: string, limit: number, cursor?: string | null) => Promise<{ items: MemoryEvent[]; nextCursor: string | null }>;
  listByLookback: (scopeId: string, since: Date, limit: number) => Promise<MemoryEvent[]>;
}

export interface DigestRepo {
  create: (data: { scopeId: string; summary: string; changes: string; nextSteps: string[]; rebuildGroupId?: string | null }) => Promise<Digest>;
  listRecent: (scopeId: string, limit: number, cursor?: string | null) => Promise<{ items: Digest[]; nextCursor: string | null }>;
  findLatest: (scopeId: string) => Promise<Digest | null>;
}

export interface ReminderRepo {
  create: (data: { userId: string; scopeId?: string | null; dueAt: Date; text: string }) => Promise<Reminder>;
  listByUser: (userId: string, status?: ReminderStatus, limit?: number, cursor?: string | null) => Promise<{ items: Reminder[]; nextCursor: string | null }>;
  cancel: (reminderId: string, userId: string) => Promise<boolean>;
  listDue: (now: Date, limit: number) => Promise<Reminder[]>;
  markSent: (reminderId: string) => Promise<void>;
}

export class ProjectService {
  constructor(private projects: ProjectRepo, private userState: UserStateRepo) {}

  async createScope(userId: string, name: string, goal?: string | null, stage?: ProjectStage) {
    const scope = await this.projects.create({ userId, name, goal, stage });
    await this.userState.upsertActiveProject(userId, scope.id);
    return scope;
  }

  async listScopes(userId: string) {
    return this.projects.listByUser(userId);
  }

  async getScope(userId: string, scopeId: string) {
    return this.projects.findById(scopeId, userId);
  }

  async setActiveScope(userId: string, scopeId: string | null) {
    return this.userState.upsertActiveProject(userId, scopeId);
  }

  async getState(userId: string) {
    return this.userState.getByUserId(userId);
  }
}

export class MemoryService {
  constructor(private memories: MemoryRepo) {}

  async ingestEvent(input: {
    userId: string;
    scopeId: string;
    type: MemoryType;
    source: MemorySource;
    key?: string | null;
    content: string;
  }) {
    if (input.type === "document" && input.key) {
      const contentHash = createHash("sha256").update(input.content).digest("hex");
      return this.memories.upsertDocument({
        userId: input.userId,
        scopeId: input.scopeId,
        source: input.source,
        key: input.key,
        content: input.content,
        contentHash
      });
    }
    return this.memories.create({
      userId: input.userId,
      scopeId: input.scopeId,
      type: input.type,
      source: input.source,
      key: input.key,
      content: input.content
    });
  }

  async listEvents(scopeId: string, limit: number, cursor?: string | null) {
    return this.memories.listRecent(scopeId, limit, cursor);
  }

  async listRecent(scopeId: string, since: Date, limit: number) {
    return this.memories.listByLookback(scopeId, since, limit);
  }
}

export class DigestService {
  constructor(private digests: DigestRepo) {}

  async createDigest(scopeId: string, summary: string, changes: string, nextSteps: string[], rebuildGroupId?: string | null) {
    return this.digests.create({ scopeId, summary, changes, nextSteps, rebuildGroupId });
  }

  async listDigests(scopeId: string, limit: number, cursor?: string | null) {
    return this.digests.listRecent(scopeId, limit, cursor);
  }

  async getLatestDigest(scopeId: string) {
    return this.digests.findLatest(scopeId);
  }
}

export class RetrieveService {
  constructor(private digests: DigestRepo, private memories: MemoryRepo) {}

  private queryAliases: Record<string, string[]> = {
    decision: ["decide", "decision", "agreed", "we will", "chose"],
    constraint: ["constraint", "blocked", "blocker", "limitation", "must", "cannot"],
    todo: ["todo", "next step", "action item", "follow up", "pending"],
    status: ["status", "progress", "done", "shipped", "completed"]
  };

  private tokenize(text: string) {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\\s]/g, " ")
      .split(/\\s+/)
      .filter((token) => token.length > 2);
  }

  private scoreByQuery(query: string, content: string) {
    const queryTokens = new Set(this.tokenize(query));
    for (const [concept, aliases] of Object.entries(this.queryAliases)) {
      if (!aliases.some((alias) => query.toLowerCase().includes(alias))) continue;
      queryTokens.add(concept);
      for (const alias of aliases) {
        for (const token of this.tokenize(alias)) queryTokens.add(token);
      }
    }
    if (!queryTokens.size) return 0;
    const contentTokens = this.tokenize(content);
    const overlap = contentTokens.filter((token) => queryTokens.has(token)).length;
    const phraseBoost = [...queryTokens].some((token) => content.toLowerCase().includes(token)) ? 0.15 : 0;
    return Math.min(1, overlap / queryTokens.size + phraseBoost);
  }

  async retrieve(scopeId: string, limit: number, query?: string) {
    const digest = await this.digests.findLatest(scopeId);
    const candidateSize = Math.min(Math.max(limit * 4, 40), 200);
    const events = await this.memories.listRecent(scopeId, candidateSize);
    if (!query || !query.trim()) {
      return { digest, events: events.items.slice(0, limit) };
    }

    const newestTs = events.items[0]?.createdAt.getTime() ?? Date.now();
    const oldestTs = events.items[events.items.length - 1]?.createdAt.getTime() ?? newestTs;
    const timeRange = Math.max(1, newestTs - oldestTs);

    const ranked = events.items
      .map((event) => ({
        event,
        score: this.scoreByQuery(query, event.content),
        recency: (event.createdAt.getTime() - oldestTs) / timeRange
      }))
      .sort((a, b) => {
        const combinedA = a.score * 0.8 + a.recency * 0.2;
        const combinedB = b.score * 0.8 + b.recency * 0.2;
        if (combinedB !== combinedA) return combinedB - combinedA;
        return b.event.createdAt.getTime() - a.event.createdAt.getTime();
      })
      .map((item) => item.event)
      .slice(0, limit);

    return { digest, events: ranked };
  }
}

export class AnswerService {
  constructor(private retrieveService: RetrieveService, private llm: LlmClient) {}

  async answer(scopeId: string, question: string, prompts: { system: string; user: string }) {
    const result = await this.retrieveService.retrieve(scopeId, 25, question);
    const digestText = result.digest ? result.digest.summary : null;
    const eventsText = result.events.map((event) => `- ${event.createdAt.toISOString()}: ${event.content}`).join("\n");
    return generateAnswer({
      question,
      digestText,
      eventsText,
      systemPrompt: prompts.system,
      userPromptTemplate: prompts.user,
      llm: this.llm
    });
  }
}

export class ReminderService {
  constructor(private reminders: ReminderRepo) {}

  async createReminder(userId: string, scopeId: string | null, dueAt: Date, text: string) {
    return this.reminders.create({ userId, scopeId, dueAt, text });
  }

  async listReminders(userId: string, status?: ReminderStatus, limit?: number, cursor?: string | null) {
    return this.reminders.listByUser(userId, status, limit, cursor);
  }

  async cancelReminder(reminderId: string, userId: string) {
    return this.reminders.cancel(reminderId, userId);
  }

  async listDue(now: Date, limit: number) {
    return this.reminders.listDue(now, limit);
  }

  async markSent(reminderId: string) {
    return this.reminders.markSent(reminderId);
  }
}

export interface LlmClientOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs?: number;
}

export class LlmClient {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private timeoutMs: number;

  constructor(options: LlmClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? 20000;
  }

  async chat(messages: { role: "system" | "user"; content: string }[]) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`
          },
          body: JSON.stringify({
            model: this.model,
            messages
          }),
          signal: controller.signal
        });

        if (!response.ok) {
          const text = await response.text();
          throw new Error(`LLM error ${response.status}: ${text}`);
        }

        const data: any = await response.json();
        const content = data?.choices?.[0]?.message?.content;
        if (!content) {
          throw new Error("LLM response missing content");
        }
        return String(content);
      } catch (err) {
        lastError = err;
        await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError ?? new Error("LLM call failed");
  }
}

export interface DigestResult {
  summary: string;
  changes: string[];
  nextSteps: string[];
}

function renderTemplate(template: string, data: Record<string, string>) {
  let output = template;
  for (const [key, value] of Object.entries(data)) {
    output = output.replaceAll(`{{${key}}}`, value);
  }
  return output;
}

function parseJson<T>(text: string): T | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as T;
  } catch {
    return null;
  }
}

export async function generateDigest(input: {
  scope: ProjectScope;
  lastDigest?: Digest | null;
  recentEvents: MemoryEvent[];
  systemPrompt: string;
  userPromptTemplate: string;
  llm: LlmClient;
}): Promise<DigestResult> {
  const recentEventsText = input.recentEvents
    .map((event) => `- ${event.createdAt.toISOString()}: ${event.content}`)
    .join("\n");

  const lastDigestText = input.lastDigest
    ? `Summary: ${input.lastDigest.summary}\nChanges: ${input.lastDigest.changes}\nNext steps: ${input.lastDigest.nextSteps.join(", ")}`
    : "(none)";

  const userPrompt = renderTemplate(input.userPromptTemplate, {
    scopeName: input.scope.name,
    scopeGoal: input.scope.goal ?? "(none)",
    scopeStage: input.scope.stage,
    lastDigest: lastDigestText,
    recentEvents: recentEventsText || "(no events)"
  });

  const response = await input.llm.chat([
    { role: "system", content: input.systemPrompt },
    { role: "user", content: userPrompt }
  ]);

  const parsed = parseJson<DigestResult>(response);
  const schema = z.object({
    summary: z.string(),
    changes: z.array(z.string()),
    nextSteps: z.array(z.string())
  });

  const validated = schema.safeParse(parsed);
  if (validated.success) {
    return {
      summary: validated.data.summary.trim(),
      changes: validated.data.changes.map((c) => c.trim()).filter(Boolean),
      nextSteps: validated.data.nextSteps.map((n) => n.trim()).filter(Boolean)
    };
  }

  return {
    summary: response.trim().slice(0, 1000),
    changes: [],
    nextSteps: []
  };
}

export async function generateAnswer(input: {
  question: string;
  digestText: string | null;
  eventsText: string;
  systemPrompt: string;
  userPromptTemplate: string;
  llm: LlmClient;
}) {
  const userPrompt = renderTemplate(input.userPromptTemplate, {
    question: input.question,
    digest: input.digestText ?? "(none)",
    events: input.eventsText || "(no events)"
  });

  return input.llm.chat([
    { role: "system", content: input.systemPrompt },
    { role: "user", content: userPrompt }
  ]);
}

export * from "./digest-control";
