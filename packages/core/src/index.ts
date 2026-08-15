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
export {
  packWithinBudget,
  rankFacts,
  FACT_BUDGET_SHARE,
  MAX_DROP_DETAIL_ITEMS,
  type BudgetDrop,
  type BudgetDropReason,
  type BudgetReport,
  type BudgetFact,
  type BudgetEvent,
  type PackInput,
  type PackResult
} from "./retrieve-budget";
import type { ChatModel, EmbeddingModel } from "./model-provider";

// Library code never writes to stdout: stdout is a protocol channel for hosts
// (MCP stdio, dsh ACP/JSON-RPC). Route all log output to stderr (fd 2).
export const logger = pino({ level: process.env.LOG_LEVEL || "info" }, pino.destination(2));

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
  template?: string | null;
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
  classifiedType?: string | null;
  /**
   * Caller-declared: this event must not lose a budget competition.
   *
   * The engine does not decide what matters — it has no way to know that one
   * document is a resume and another is a meeting note. Without this signal the
   * only tiebreaker is recency, which is exactly backwards for durable inputs:
   * the resume uploaded once and never touched again is always the oldest, and
   * so always the first to be dropped.
   */
  pinned?: boolean;
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
  create: (data: { userId: string; name: string; goal?: string | null; stage?: ProjectStage; template?: string }) => Promise<ProjectScope>;
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
    createdAt?: Date;
    pinned?: boolean;
  }) => Promise<MemoryEvent>;
  upsertDocument: (data: {
    userId: string;
    scopeId: string;
    source: MemorySource;
    key: string;
    content: string;
    contentHash?: string | null;
    createdAt?: Date;
    pinned?: boolean;
  }) => Promise<MemoryEvent>;
  listRecent: (scopeId: string, limit: number, cursor?: string | null) => Promise<{ items: MemoryEvent[]; nextCursor: string | null }>;
  listByLookback: (scopeId: string, since: Date, limit: number) => Promise<MemoryEvent[]>;
  findByIds: (ids: string[]) => Promise<MemoryEvent[]>;
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

  async createScope(userId: string, name: string, goal?: string | null, stage?: ProjectStage, template?: string) {
    const scope = await this.projects.create({ userId, name, goal, stage, template: template ?? "project" });
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
    occurredAt?: Date;
    pinned?: boolean;
  }) {
    if (input.type === "document" && input.key) {
      const contentHash = createHash("sha256").update(input.content).digest("hex");
      return this.memories.upsertDocument({
        userId: input.userId,
        scopeId: input.scopeId,
        source: input.source,
        key: input.key,
        content: input.content,
        contentHash,
        ...(input.occurredAt ? { createdAt: input.occurredAt } : {}),
        ...(input.pinned !== undefined ? { pinned: input.pinned } : {})
      });
    }
    return this.memories.create({
      userId: input.userId,
      scopeId: input.scopeId,
      type: input.type,
      source: input.source,
      key: input.key,
      content: input.content,
      ...(input.occurredAt ? { createdAt: input.occurredAt } : {}),
      ...(input.pinned !== undefined ? { pinned: input.pinned } : {})
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
      useVectorSearch?: boolean;
      vectorSearchFn?: (queryVector: number[], limit: number, scopeId: string) => Promise<string[]>;
    }
  ) {}

  private queryAliases: Record<string, string[]> = {
    decision: ["decide", "decision", "agreed", "we will", "chose"],
    constraint: ["constraint", "blocked", "blocker", "limitation", "must", "cannot"],
    todo: ["todo", "next step", "action item", "follow up", "pending"],
    status: ["status", "progress", "done", "shipped", "completed"]
  };

  private tokenize(text: string) {
    const lower = text.toLowerCase();
    const asciiTokens = lower
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((token) => token.length > 2);
    const cjkTokens: string[] = [];
    // Contiguous runs of CJK ideographs / Japanese kana / Korean syllables.
    const runs = lower.match(/[一-鿿぀-ヿ가-힯]+/g) ?? [];
    for (const run of runs) {
      if (run.length === 1) {
        cjkTokens.push(run); // single-char run: keep as unigram
        continue;
      }
      for (let i = 0; i < run.length - 1; i += 1) {
        cjkTokens.push(run.slice(i, i + 2)); // adjacent bigram
      }
    }
    return [...asciiTokens, ...cjkTokens];
  }

  /**
   * Relevance of one text to a query, on the same scale events are ranked by.
   *
   * Facts are ranked for the context budget outside this class, and the scorer
   * they need is this one. Exposing it beats copying the tokenizer and the
   * alias table into a second implementation that would drift.
   */
  scoreText(query: string, content: string): number {
    return this.scoreByQuery(query, content);
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
    } catch (err) {
      logger.warn({ err }, "Embedding rerank failed, falling back to heuristic ranking");
      return ranked;
    }
  }

  async retrieve(scopeId: string, limit: number, query?: string) {
    const tStart = Date.now();
    let embedMs = 0;
    let vectorSearchMs = 0;
    let rerankMs = 0;

    const digest = await this.digests.findLatest(scopeId);
    const candidateSize = Math.min(Math.max(limit * 4, 40), 200);
    const events = await this.memories.listRecent(scopeId, candidateSize);
    if (!query || !query.trim()) {
      logger.info(
        { retrieveTimings: { embedMs: 0, vectorSearchMs: 0, rerankMs: 0, totalMs: Date.now() - tStart } },
        "retrieve stage timings"
      );
      return { digest, events: events.items.slice(0, limit) };
    }

    let mergedItems = events.items;
    if (
      query?.trim() &&
      this.options?.useVectorSearch &&
      this.options.embeddingModel &&
      this.options.vectorSearchFn
    ) {
      try {
        const tEmbed = Date.now();
        const queryVectors = await this.options.embeddingModel.embed([query]);
        embedMs = Date.now() - tEmbed;
        const queryVector = queryVectors[0];
        if (queryVector?.length) {
          const tVectorSearch = Date.now();
          const vectorIds = await this.options.vectorSearchFn(queryVector, candidateSize, scopeId);
          vectorSearchMs = Date.now() - tVectorSearch;
          if (vectorIds.length) {
            const keywordIdSet = new Set(events.items.map((e) => e.id));
            const newIds = vectorIds.filter((id) => !keywordIdSet.has(id));
            if (newIds.length) {
              const vectorEvents = (await this.memories.findByIds(newIds)).filter(
                (e) => e.scopeId === scopeId
              );
              mergedItems = [...events.items, ...vectorEvents];
            }
          }
        }
      } catch {
        // Vector search failed — fall back to keyword candidates only
      }
    }

    const newestTs = mergedItems[0]?.createdAt.getTime() ?? Date.now();
    const oldestTs = mergedItems[mergedItems.length - 1]?.createdAt.getTime() ?? newestTs;
    const timeRange = Math.max(1, newestTs - oldestTs);

    const ranked = mergedItems
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

    const tRerank = Date.now();
    const reranked = await this.rerankWithEmbeddings(query, ranked);
    rerankMs = Date.now() - tRerank;

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

    logger.info(
      { retrieveTimings: { embedMs, vectorSearchMs, rerankMs, totalMs: Date.now() - tStart } },
      "retrieve stage timings"
    );

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
export * from "./provenance";
export * from "./drift-metrics";
export * from "./drop-log";
export * from "./facet-registry";
export * from "./facet-pack-resolver";
export * from "./assistant-runtime";
export * from "./memory-facts";
export * from "./facet-consolidation";
export { getDomainConfig, KNOWN_TEMPLATES } from "./domain-configs/index";
export type { DomainConfig, EntityTypeConfig } from "./domain-configs/types";
export type { RelationshipContext } from "./relationship-context";
export { buildRelationshipContext } from "./relationship-context";
export { buildRuntimeSystemPrompt } from "./runtime-system-prompt";
