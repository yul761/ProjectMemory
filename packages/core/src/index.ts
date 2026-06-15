import pino from "pino";
import { createHash } from "crypto";
import { z } from "zod";
export {
  LlmClient,
  EmbeddingClient,
  type LlmClientOptions,
  createChatModelClient,
  createEmbeddingModelClient,
  createModelProvider,
  type ChatModel,
  type StructuredOutputModel,
  type EmbeddingModel,
  type LlmChatOptions,
  type ModelProviderConfig,
  type ModelProviderFactory
} from "./model-provider";
export type { DigestConsistencyResult } from "./digest-control";
export {
  buildGroundingEvidence,
  buildGroundingStateDetails,
  computeLayerDiagnostics,
  summarizeGroundingStateSnapshot,
  type GroundingEvidence,
  type LayerAlignment,
  type ResolvedRecall,
  type RuntimeStateSnapshot
} from "./assistant-runtime";
export {
  compileFastLayerContext,
  type FastLayerContext,
  type RecentTurnView,
  type RetrievalSnippetView
} from "./fast-layer-context.compiler";
export {
  compileStateLayerView,
  compileWorkingMemoryView,
  formatStateLayerView,
  formatWorkingMemoryView,
  type StateLayerView,
  type WorkingMemoryView
} from "./working-memory.compiler";
export {
  extractWorkingMemoryState,
  mergeWorkingMemoryState,
  selectWorkingMemoryEvents,
  type WorkingMemoryEventLike,
  type PartialWorkingMemoryState,
  type WorkingMemoryState
} from "./working-memory.extractor";
export {
  WorkingMemoryService,
  type WorkingMemoryRepo,
  type WorkingMemorySnapshot
} from "./working-memory.service";
import type { ChatModel, EmbeddingModel } from "./model-provider";

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

export interface RetrieveMatch {
  id: string;
  sourceType: MemoryType;
  key?: string | null;
  heuristicScore: number;
  recencyScore: number;
  embeddingScore?: number;
  finalScore: number;
  rankingReason: string;
}

export interface RetrieveMetadata {
  mode: "heuristic" | "hybrid";
  embeddingRequested: boolean;
  embeddingConfigured: boolean;
  reranked: boolean;
  candidateCount: number;
  returnedCount: number;
  embeddingCandidateLimit?: number;
  matches: RetrieveMatch[];
}

export interface RetrieveResult {
  digest: Digest | null;
  events: MemoryEvent[];
  retrieval: RetrieveMetadata;
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
  constructor(
    private digests: DigestRepo,
    private memories: MemoryRepo,
    private options?: {
      embeddingModel?: EmbeddingModel | null;
      useEmbeddingRerank?: boolean;
      embeddingCandidateLimit?: number;
    }
  ) {}

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
    return this.explainQueryScore(query, content).score;
  }

  private explainQueryScore(query: string, content: string) {
    const queryTokens = new Set(this.tokenize(query));
    const matchedConcepts = new Set<string>();
    for (const [concept, aliases] of Object.entries(this.queryAliases)) {
      if (!aliases.some((alias) => query.toLowerCase().includes(alias))) continue;
      queryTokens.add(concept);
      matchedConcepts.add(concept);
      for (const alias of aliases) {
        for (const token of this.tokenize(alias)) queryTokens.add(token);
      }
    }
    if (!queryTokens.size) {
      return {
        score: 0,
        matchedTerms: [],
        matchedConcepts: [...matchedConcepts],
        phraseBoostApplied: false
      };
    }
    const contentTokens = this.tokenize(content);
    const matchedTerms = [...new Set(contentTokens.filter((token) => queryTokens.has(token)))];
    const overlap = matchedTerms.length;
    const phraseBoostApplied = [...queryTokens].some((token) => content.toLowerCase().includes(token));
    const phraseBoost = phraseBoostApplied ? 0.15 : 0;
    return {
      score: Math.min(1, overlap / queryTokens.size + phraseBoost),
      matchedTerms,
      matchedConcepts: [...matchedConcepts],
      phraseBoostApplied
    };
  }

  private cosineSimilarity(a: number[], b: number[]) {
    if (!a.length || !b.length || a.length !== b.length) return 0;
    let dot = 0;
    let magA = 0;
    let magB = 0;
    for (let i = 0; i < a.length; i += 1) {
      dot += a[i] * b[i];
      magA += a[i] * a[i];
      magB += b[i] * b[i];
    }
    if (magA === 0 || magB === 0) return 0;
    return dot / (Math.sqrt(magA) * Math.sqrt(magB));
  }

  private async rerankWithEmbeddings(
    query: string,
    ranked: Array<{
      event: MemoryEvent;
      score: number;
      recency: number;
      matchedTerms: string[];
      matchedConcepts: string[];
      phraseBoostApplied: boolean;
      embeddingScore?: number;
      finalScore?: number;
      reranked?: boolean;
    }>
  ) {
    if (!this.options?.useEmbeddingRerank || !this.options.embeddingModel || !ranked.length) {
      return ranked;
    }

    const candidateLimit = Math.min(this.options.embeddingCandidateLimit ?? 24, ranked.length);
    const topCandidates = ranked.slice(0, candidateLimit);
    try {
      const embeddings = await this.options.embeddingModel.embed([query, ...topCandidates.map((item) => item.event.content)]);
      const queryVector = embeddings[0];
      const contentVectors = embeddings.slice(1);
      if (!queryVector || contentVectors.length !== topCandidates.length) {
        return ranked;
      }

      const originalOrder = new Map(topCandidates.map((item, index) => [item.event.id, index]));
      const rerankedTop = topCandidates
        .map((item, index) => {
          const embeddingScore = this.cosineSimilarity(queryVector, contentVectors[index]);
          const finalScore = embeddingScore * 0.55 + item.score * 0.25 + item.recency * 0.2;
          return {
            ...item,
            embeddingScore,
            finalScore
          };
        })
        .sort((a, b) => {
          const combinedA = a.finalScore ?? 0;
          const combinedB = b.finalScore ?? 0;
          if (combinedB !== combinedA) return combinedB - combinedA;
          return b.event.createdAt.getTime() - a.event.createdAt.getTime();
        })
        .map((item, index) => ({
          ...item,
          reranked: (originalOrder.get(item.event.id) ?? index) !== index
        }));

      return [...rerankedTop, ...ranked.slice(candidateLimit)];
    } catch {
      return ranked;
    }
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
      .map((event) => {
        const heuristic = this.explainQueryScore(query, event.content);
        return {
          event,
          score: heuristic.score,
          recency: (event.createdAt.getTime() - oldestTs) / timeRange,
          matchedTerms: heuristic.matchedTerms,
          matchedConcepts: heuristic.matchedConcepts,
          phraseBoostApplied: heuristic.phraseBoostApplied
        };
      })
      .sort((a, b) => {
        const combinedA = a.score * 0.8 + a.recency * 0.2;
        const combinedB = b.score * 0.8 + b.recency * 0.2;
        if (combinedB !== combinedA) return combinedB - combinedA;
        return b.event.createdAt.getTime() - a.event.createdAt.getTime();
      });

    const reranked = await this.rerankWithEmbeddings(query, ranked);
    const matches = reranked.slice(0, limit).map((item) => {
      const reasonParts = [
        item.embeddingScore !== undefined ? "embedding_rerank" : "heuristic_rank",
        item.matchedConcepts.length ? `concepts=${item.matchedConcepts.join("|")}` : null,
        item.matchedTerms.length ? `terms=${item.matchedTerms.slice(0, 5).join("|")}` : null,
        item.phraseBoostApplied ? "phrase_boost" : null,
        item.reranked ? "position_changed" : null
      ].filter(Boolean);
      const finalScore = item.embeddingScore !== undefined
        ? item.finalScore ?? (item.embeddingScore * 0.55 + item.score * 0.25 + item.recency * 0.2)
        : item.score * 0.8 + item.recency * 0.2;
      return {
        id: item.event.id,
        sourceType: item.event.type ?? "stream",
        key: item.event.key ?? null,
        heuristicScore: Number(item.score.toFixed(3)),
        recencyScore: Number(item.recency.toFixed(3)),
        ...(item.embeddingScore !== undefined ? { embeddingScore: Number(item.embeddingScore.toFixed(3)) } : {}),
        finalScore: Number(finalScore.toFixed(3)),
        rankingReason: reasonParts.join(", ")
      };
    });

    return {
      digest,
      events: reranked
        .map((item) => item.event)
        .slice(0, limit),
      retrieval: {
        mode: this.options?.useEmbeddingRerank && this.options?.embeddingModel ? "hybrid" : "heuristic",
        embeddingRequested: Boolean(this.options?.useEmbeddingRerank),
        embeddingConfigured: Boolean(this.options?.embeddingModel),
        reranked: matches.some((item) => item.rankingReason.includes("embedding_rerank")),
        candidateCount: ranked.length,
        returnedCount: matches.length,
        embeddingCandidateLimit: this.options?.embeddingModel ? Math.min(this.options.embeddingCandidateLimit ?? 24, ranked.length) : undefined,
        matches
      }
    };
  }
}

export class AnswerService {
  constructor(private retrieveService: RetrieveService, private llm: ChatModel) {}

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
  llm: ChatModel;
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
  llm: ChatModel;
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
export * from "./drift-metrics";
export * from "./assistant-runtime";
