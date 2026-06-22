import { BadRequestException, Body, Controller, Get, Inject, NotFoundException, Param, Post, Query, Req } from "@nestjs/common";
import { checkContradiction } from "./check-contradiction";
import { createHash, randomUUID } from "crypto";
import {
  AGENT_SCENARIOS,
  AgentScenarioRunOutput,
  AnswerInput,
  AnswerOutput,
  DigestEnqueueOutput,
  DigestListOutput,
  DigestRebuildOutput,
  DigestStateHistoryOutput,
  DigestStateOutput,
  DigestRebuildInput,
  DigestRequestInput,
  FastLayerViewOutput,
  LayerStatusOutput,
  MemoryEventListOutput,
  MemoryEventInput,
  MemoryEventOutput,
  RetrieveOutput,
  RuntimeTurnInput,
  RuntimeTurnOutput,
  RetrieveInput,
  StableStateOutput,
  WorkingMemoryOutput
} from "@statecore/contracts";
import {
  AssistantSession,
  buildGroundingEvidence,
  buildRelationshipContext,
  buildRuntimeSystemPrompt,
  type ChatModel,
  compileFastLayerContext,
  compileStateLayerView,
  computeLayerDiagnostics,
  createChatModelClient,
  createRuntimePolicyBundle,
  createRuntimeRecallPolicy,
  createModelProvider,
  generateAnswer,
  getActiveFactRegistry,
  getDomainConfig,
  logger
} from "@statecore/core";
import { z } from "zod";
import { prisma } from "@statecore/db";
import { digestQueue, workingMemoryQueue, embedQueue, classifyQueue } from "./queue";
import { DomainService } from "./domain.service";
import { parseOutput } from "./output";
import type { RequestWithUser } from "./types";
import { apiEnv } from "./env";
import { answerSystemPrompt, answerUserPrompt, runtimeSystemPrompt, runtimeUserPrompt } from "@statecore/prompts";

const WORKING_MEMORY_CAUGHT_UP_WINDOW_MS = 15_000;
const STABLE_STATE_CAUGHT_UP_WINDOW_MS = 60_000;
const AGENT_SCENARIO_TIMEOUT_MS = 15_000;
const AGENT_SCENARIO_STABLE_SOFT_WAIT_MS = 8_000;

type SimpleWorkingView = {
  goal?: string;
  constraints?: string[];
  decisions?: string[];
  progressSummary?: string;
  openQuestions?: string[];
  taskFrame?: string;
} | null;

type SimpleStableView = {
  goal?: string;
  constraints?: string[];
  decisions?: string[];
  todos?: string[];
  openQuestions?: string[];
  risks?: string[];
} | null;

function splitStructuredTurnLines(message: string) {
  const lines = message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length <= 1) {
    return lines;
  }

  const structuredLineCount = lines.filter((line) =>
    /^(goal|constraint|decision|todo|question|open question|risk|status|status update)\s*:/i.test(line)
    || /^(we decide|we agreed|agreed)\b/i.test(line)
  ).length;

  if (structuredLineCount < 2) {
    return [message];
  }

  return lines;
}

function summarizeFieldDiff(
  label: string,
  previousValue: unknown,
  nextValue: unknown
) {
  if (Array.isArray(previousValue) || Array.isArray(nextValue)) {
    const previousItems = Array.isArray(previousValue) ? previousValue : [];
    const nextItems = Array.isArray(nextValue) ? nextValue : [];
    const added = nextItems.filter((item) => !previousItems.includes(item));
    const removed = previousItems.filter((item) => !nextItems.includes(item));
    if (!added.length && !removed.length) {
      return null;
    }

    const parts = [
      added.length ? `added ${added.join(" | ")}` : null,
      removed.length ? `removed ${removed.join(" | ")}` : null
    ].filter(Boolean);
    return `${label}: ${parts.join("; ")}`;
  }

  const normalizedPrevious = previousValue ?? null;
  const normalizedNext = nextValue ?? null;
  if (normalizedPrevious === normalizedNext) {
    return null;
  }

  return `${label}: ${normalizedPrevious || "none"} -> ${normalizedNext || "none"}`;
}

function diffWorkingView(previous: SimpleWorkingView, next: SimpleWorkingView) {
  return [
    summarizeFieldDiff("Goal", previous?.goal, next?.goal),
    summarizeFieldDiff("Constraints", previous?.constraints, next?.constraints),
    summarizeFieldDiff("Decisions", previous?.decisions, next?.decisions),
    summarizeFieldDiff("Progress", previous?.progressSummary, next?.progressSummary),
    summarizeFieldDiff("Open Questions", previous?.openQuestions, next?.openQuestions),
    summarizeFieldDiff("Task Frame", previous?.taskFrame, next?.taskFrame)
  ].filter((value): value is string => Boolean(value));
}

function diffStableView(previous: SimpleStableView, next: SimpleStableView) {
  return [
    summarizeFieldDiff("Goal", previous?.goal, next?.goal),
    summarizeFieldDiff("Constraints", previous?.constraints, next?.constraints),
    summarizeFieldDiff("Decisions", previous?.decisions, next?.decisions),
    summarizeFieldDiff("Todos", previous?.todos, next?.todos),
    summarizeFieldDiff("Open Questions", previous?.openQuestions, next?.openQuestions),
    summarizeFieldDiff("Risks", previous?.risks, next?.risks)
  ].filter((value): value is string => Boolean(value));
}

function buildNextAgentSees(workingView: SimpleWorkingView, stableView: SimpleStableView) {
  const goal = stableView?.goal ?? workingView?.goal;
  const constraints = stableView?.constraints?.length ? stableView.constraints : workingView?.constraints;
  const decisions = stableView?.decisions?.length ? stableView.decisions : workingView?.decisions;
  const risks = stableView?.risks ?? [];

  return [
    goal ? `Goal: ${goal}` : null,
    constraints?.length ? `Constraints: ${constraints.join("; ")}` : null,
    decisions?.length ? `Decisions: ${decisions.join("; ")}` : null,
    risks.length ? `Risks: ${risks.join("; ")}` : null
  ].filter((value): value is string => Boolean(value));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

@Controller()
export class MemoryController {
  private answerLlm: ChatModel | null = null;
  private runtimeLlm: ChatModel | null = null;

  constructor(@Inject(DomainService) private readonly domain: DomainService) {
    if (apiEnv.featureLlm) {
      this.answerLlm = createModelProvider({
        provider: apiEnv.modelProvider,
        apiKey: apiEnv.modelApiKey,
        baseUrl: apiEnv.modelBaseUrl,
        model: apiEnv.modelName,
        chatApiKey: apiEnv.chatModelApiKey,
        chatBaseUrl: apiEnv.chatModelBaseUrl,
        chatModel: apiEnv.chatModelName,
        structuredOutputApiKey: apiEnv.structuredOutputModelApiKey,
        structuredOutputBaseUrl: apiEnv.structuredOutputModelBaseUrl,
        structuredOutputModel: apiEnv.structuredOutputModelName,
        embeddingApiKey: apiEnv.embeddingModelApiKey,
        embeddingBaseUrl: apiEnv.embeddingModelBaseUrl,
        embeddingModel: apiEnv.embeddingModelName || undefined,
        timeoutMs: apiEnv.modelTimeoutMs
      })?.chat ?? null;
      this.runtimeLlm = createChatModelClient({
        provider: apiEnv.modelProvider,
        apiKey: apiEnv.runtimeModelApiKey,
        baseUrl: apiEnv.runtimeModelBaseUrl,
        model: apiEnv.runtimeModelName,
        timeoutMs: apiEnv.runtimeModelTimeoutMs
      });
    }
  }

  private async resolveRuntimeRecall(scopeId: string, message: string) {
    const runtimePolicy = createRuntimeRecallPolicy(this.domain.retrieveService, {
      scopeStateLoader: async (value) => this.domain.getLatestDigestState(value),
      workingMemoryLoader: async (value) => {
        const snapshot = await this.domain.getLatestWorkingMemory(value);
        return snapshot
          ? {
              scopeId: snapshot.scopeId,
              id: snapshot.id,
              version: snapshot.version,
              state: snapshot.state,
              view: snapshot.view,
              updatedAt: snapshot.updatedAt,
              createdAt: snapshot.createdAt
            }
          : null;
      },
      recentTurnsLoader: async (value, limit) => this.domain.listRecentTurns(value, limit)
    });

    return runtimePolicy.resolve({ scopeId, message });
  }

  private async buildLayerStatus(scopeId: string, message: string, recall: Awaited<ReturnType<MemoryController["resolveRuntimeRecall"]>>) {
    const workingMemoryView = recall.workingMemoryView ?? null;
    const stableStateView = recall.stableStateView ?? compileStateLayerView(recall.stateSnapshot?.state ?? null);
    const latestEvent = await this.domain.getLatestMemoryEvent(scopeId);
    const fastLayerContext = recall.fastLayerContext ?? compileFastLayerContext({
      message,
      workingMemoryView,
      stateLayerView: stableStateView,
      retrievalSnippets: recall.events.map((event) => ({
        id: event.id,
        content: event.content,
        createdAt: event.createdAt
      })),
      recentTurns: recall.recentTurns ?? []
    });

    const diagnostics = computeLayerDiagnostics({
      workingMemoryView,
      stableStateView,
      workingMemoryVersion: recall.workingMemorySnapshot?.version ?? null,
      stableStateVersion: recall.stateRef ?? null
    });

    const latestEventCreatedAt = latestEvent?.createdAt ?? null;
    const workingMemoryUpdatedAt = recall.workingMemorySnapshot?.updatedAt ?? null;
    const stableStateCreatedAt = recall.stateSnapshot?.createdAt ?? null;
    const workingMemoryLagMs = latestEventCreatedAt && workingMemoryUpdatedAt
      ? Math.max(0, latestEventCreatedAt.getTime() - workingMemoryUpdatedAt.getTime())
      : null;
    const stableStateLagMs = latestEventCreatedAt && stableStateCreatedAt
      ? Math.max(0, latestEventCreatedAt.getTime() - stableStateCreatedAt.getTime())
      : null;
    const freshness = {
      latestEventCreatedAt: latestEventCreatedAt?.toISOString() ?? null,
      workingMemoryUpdatedAt: workingMemoryUpdatedAt?.toISOString() ?? null,
      stableStateCreatedAt: stableStateCreatedAt?.toISOString() ?? null,
      workingMemoryLagMs,
      stableStateLagMs,
      workingMemoryCaughtUp: latestEventCreatedAt
        ? Boolean(workingMemoryUpdatedAt && workingMemoryLagMs !== null && workingMemoryLagMs <= WORKING_MEMORY_CAUGHT_UP_WINDOW_MS)
        : true,
      stableStateCaughtUp: latestEventCreatedAt
        ? Boolean(stableStateCreatedAt && stableStateLagMs !== null && stableStateLagMs <= STABLE_STATE_CAUGHT_UP_WINDOW_MS)
        : true
    };
    const warnings = [...diagnostics.warnings];

    if (latestEventCreatedAt && !workingMemoryUpdatedAt) {
      warnings.push("working_memory_missing_with_recent_events");
    } else if (workingMemoryLagMs !== null && workingMemoryLagMs > WORKING_MEMORY_CAUGHT_UP_WINDOW_MS) {
      warnings.push("working_memory_lagging_behind_events");
    }

    if (latestEventCreatedAt && !stableStateCreatedAt) {
      warnings.push("stable_state_missing_with_recent_events");
    } else if (stableStateLagMs !== null && stableStateLagMs > STABLE_STATE_CAUGHT_UP_WINDOW_MS) {
      warnings.push("stable_state_lagging_behind_events");
    }

    return parseOutput(LayerStatusOutput, {
      scopeId,
      message,
      workingMemoryVersion: recall.workingMemorySnapshot?.version ?? null,
      stableStateVersion: recall.stateRef ?? null,
      workingMemoryView,
      stableStateView,
      fastLayerSummary: fastLayerContext.summary,
      retrievalPlan: recall.retrievalPlan ?? null,
      layerAlignment: diagnostics.layerAlignment,
      freshness,
      warnings
    });
  }

  private createRuntimeSession(
    userId: string,
    scopeId: string,
    policyProfile: "default" | "conservative" | "document-heavy",
    policyOverrides?: {
      recallLimit?: number;
      promoteLongFormToDocumented?: boolean;
      digestOnCandidate?: boolean;
    },
    personaPrompt?: string | null,
    styleLines?: string[] | null
  ) {
    if (!this.runtimeLlm) {
      throw new BadRequestException("FEATURE_LLM disabled");
    }
    const policies = createRuntimePolicyBundle(policyProfile);
    return new AssistantSession({
      userId,
      scopeId,
      memoryService: this.domain.memoryService,
      recallPolicy: createRuntimeRecallPolicy(this.domain.retrieveService, {
        profile: policyProfile,
        overrides: policyOverrides,
        scopeStateLoader: async (value) => this.domain.getLatestDigestState(value),
        workingMemoryLoader: async (value) => {
          const snapshot = await this.domain.getLatestWorkingMemory(value);
          return snapshot
            ? {
                scopeId: snapshot.scopeId,
                id: snapshot.id,
                version: snapshot.version,
                state: snapshot.state,
                view: snapshot.view,
                updatedAt: snapshot.updatedAt,
                createdAt: snapshot.createdAt
              }
            : null;
        },
        recentTurnsLoader: async (value, limit) => this.domain.listRecentTurns(value, limit)
      }),
      llm: this.runtimeLlm,
      prompts: {
        system: buildRuntimeSystemPrompt(personaPrompt ?? null, styleLines ?? null, runtimeSystemPrompt),
        user: runtimeUserPrompt
      },
      runtimeResponseOptions: {
        maxOutputTokens: apiEnv.runtimeModelMaxOutputTokens,
        reasoningEffort: apiEnv.runtimeModelReasoningEffort
      },
      memoryWritePolicy: policies.memoryWritePolicy,
      digestPolicy: policies.digestPolicy,
      digestTrigger: {
        requestDigest: async (value) => {
          await digestQueue.add("digest_scope", { userId, scopeId: value });
        }
      },
      backgroundProcessor: {
        persistTurnArtifacts: async ({ turn, writeTier, answer, assistantReplySource }) => {
          if (writeTier === "documented") {
            const documentKey = turn.documentKey
              ?? (typeof turn.metadata?.documentKey === "string" ? turn.metadata.documentKey : null)
              ?? `runtime:${createHash("sha1").update(turn.message).digest("hex").slice(0, 12)}`;
            await this.domain.memoryService.ingestEvent({
              userId,
              scopeId,
              type: "document",
              source: turn.source ?? "api",
              key: documentKey,
              content: turn.message
            });
          } else {
            for (const line of splitStructuredTurnLines(turn.message)) {
              await this.domain.memoryService.ingestEvent({
                userId,
                scopeId,
                type: "stream",
                source: turn.source ?? "api",
                content: line
              });
            }
          }

          await this.domain.memoryService.ingestEvent({
            userId,
            scopeId,
            type: "stream",
            source: assistantReplySource,
            content: `Assistant reply: ${answer}`
          });
        },
        requestWorkingMemoryUpdate: async (value) => {
          await workingMemoryQueue.add("working_memory_update", { userId, scopeId: value });
        },
        requestStableStateDigest: async (value) => {
          await digestQueue.add("digest_scope", { userId, scopeId: value });
        }
      },
      assistantReplySource: "api"
    });
  }

  private async executeRuntimeTurn(
    userId: string,
    input: {
      scopeId: string;
      message: string;
      source?: "telegram" | "cli" | "api" | "sdk";
      policyProfile?: "default" | "conservative" | "document-heavy";
      policyOverrides?: {
        recallLimit?: number;
        promoteLongFormToDocumented?: boolean;
        digestOnCandidate?: boolean;
      };
      writeTier?: "ephemeral" | "candidate" | "stable" | "documented";
      documentKey?: string;
      digestMode?: "auto" | "force" | "skip";
      metadata?: Record<string, unknown>;
    }
  ) {
    const policyProfile = input.policyProfile ?? "default";
    const [scope, digestSnapshot] = await Promise.all([
      this.domain.projectService.getScope(userId, input.scopeId),
      this.domain.getLatestDigestState(input.scopeId)
    ]);
    const personaPrompt = getDomainConfig(scope?.template).defaultPersonaPrompt ?? null;
    const styleLines = digestSnapshot?.state?.profile?.style ?? null;
    const session = this.createRuntimeSession(
      userId,
      input.scopeId,
      policyProfile,
      input.policyOverrides,
      personaPrompt,
      styleLines
    );
    return session.handleTurn({
      message: input.message,
      source: input.source ?? "api",
      policyProfile,
      policyOverrides: input.policyOverrides,
      writeTier: input.writeTier,
      documentKey: input.documentKey,
      digestMode: input.digestMode ?? "auto",
      metadata: input.metadata
    });
  }

  private async waitForRuntimeArtifacts(scopeId: string, message: string, digestTriggered: boolean) {
    const deadline = Date.now() + AGENT_SCENARIO_TIMEOUT_MS;
    const stableSoftDeadline = Date.now() + AGENT_SCENARIO_STABLE_SOFT_WAIT_MS;
    let latestWorking = await this.domain.getLatestWorkingMemory(scopeId);
    let latestStable = await this.domain.getStateLayerView(scopeId);
    let latestLayer = parseOutput(LayerStatusOutput, {
      scopeId,
      message,
      workingMemoryVersion: latestWorking?.version ?? null,
      stableStateVersion: latestStable?.digestId ?? null,
      workingMemoryView: latestWorking?.view ?? null,
      stableStateView: latestStable?.view ?? null,
      fastLayerSummary: "",
      retrievalPlan: null,
      layerAlignment: {
        goalAligned: false,
        sharedConstraintCount: 0,
        sharedDecisionCount: 0,
        fastPathReady: false
      },
      freshness: {
        latestEventCreatedAt: null,
        workingMemoryUpdatedAt: latestWorking?.updatedAt?.toISOString() ?? null,
        stableStateCreatedAt: latestStable?.createdAt?.toISOString() ?? null,
        workingMemoryLagMs: null,
        stableStateLagMs: null,
        workingMemoryCaughtUp: !latestWorking,
        stableStateCaughtUp: !latestStable
      },
      warnings: []
    });

    while (Date.now() < deadline) {
      const recall = await this.resolveRuntimeRecall(scopeId, message);
      latestLayer = await this.buildLayerStatus(scopeId, message, recall);
      latestWorking = await this.domain.getLatestWorkingMemory(scopeId);
      latestStable = await this.domain.getStateLayerView(scopeId);

      if (
        latestLayer.freshness.workingMemoryCaughtUp
        && (
          !digestTriggered
          || latestLayer.freshness.stableStateCaughtUp
          || Date.now() >= stableSoftDeadline
        )
      ) {
        break;
      }

      await sleep(1500);
    }

    return {
      working: latestWorking,
      stable: latestStable,
      layer: latestLayer
    };
  }

  @Post(["/memory/events", "/v1/memory/events"])
  async ingestEvent(@Req() req: RequestWithUser, @Body() body: unknown) {
    const input = MemoryEventInput.parse(body);
    if (input.type === "document" && !input.key) {
      throw new BadRequestException("key required for document events");
    }
    const scope = await this.domain.projectService.getScope(req.userId, input.scopeId);
    if (!scope) {
      throw new NotFoundException("Scope not found");
    }
    const event = await this.domain.memoryService.ingestEvent({
      userId: req.userId,
      scopeId: input.scopeId,
      type: input.type,
      source: input.source ?? "api",
      key: input.key ?? null,
      content: input.content
    });
    // Queue async embedding generation (best-effort, ingest must not fail if queue is unavailable)
    embedQueue.add("embed_event",       { eventId: event.id, scopeId: input.scopeId })
      .catch((err) => logger.error({ err, eventId: event.id }, "embed_event enqueue failed"));
    classifyQueue.add("classify_event", { eventId: event.id, scopeId: input.scopeId })
      .catch((err) => logger.error({ err, eventId: event.id }, "classify_event enqueue failed"));
    return parseOutput(MemoryEventOutput, {
      id: event.id,
      userId: event.userId,
      scopeId: event.scopeId,
      type: event.type,
      source: event.source,
      key: event.key ?? null,
      content: event.content,
      createdAt: event.createdAt.toISOString(),
      updatedAt: event.updatedAt ? event.updatedAt.toISOString() : null
    });
  }

  @Post("/memory/check-contradiction")
  async checkContradictionEndpoint(@Req() req: RequestWithUser, @Body() body: unknown) {
    const input = z.object({
      scopeId: z.string().uuid(),
      content: z.string().min(1).max(500)
    }).parse(body);

    const scope = await this.domain.projectService.getScope(req.userId, input.scopeId);
    if (!scope) throw new NotFoundException("Scope not found");

    if (!this.runtimeLlm) {
      return { hasContradiction: false, message: null };
    }

    return checkContradiction(input.scopeId, input.content, this.runtimeLlm, prisma);
  }

  @Post("/memory/embed/backfill")
  async backfillEmbeddings(@Req() req: RequestWithUser, @Body() body: unknown) {
    const input = z.object({ scopeId: z.string().uuid() }).parse(body);
    const scope = await this.domain.projectService.getScope(req.userId, input.scopeId);
    if (!scope) throw new NotFoundException("Scope not found");

    const eventsWithoutEmbedding = await prisma.$queryRaw<{ id: string }[]>`
      SELECT me.id
      FROM "MemoryEvent" me
      LEFT JOIN "MemoryEventEmbedding" mee ON me.id = mee."eventId"
      WHERE me."scopeId" = ${input.scopeId}
        AND me."userId" = ${req.userId}
        AND mee."eventId" IS NULL
      ORDER BY me."createdAt" DESC
      LIMIT 1000
    `;

    for (const event of eventsWithoutEmbedding) {
      await embedQueue.add("embed_event", { eventId: event.id, scopeId: input.scopeId });
    }

    return { queued: eventsWithoutEmbedding.length };
  }

  @Get("/memory/relationship-context/:scopeId")
  async getRelationshipContext(
    @Param("scopeId") scopeId: string,
    @Req() req: RequestWithUser
  ) {
    const scope = await this.domain.projectService.getScope(req.userId, scopeId);
    if (!scope) throw new NotFoundException("Scope not found");
    return buildRelationshipContext(scopeId, prisma);
  }

  @Get("/memory/events")
  async listEvents(
    @Req() req: RequestWithUser,
    @Query("scopeId") scopeId?: string,
    @Query("limit") limit?: string,
    @Query("cursor") cursor?: string
  ) {
    if (!scopeId) throw new BadRequestException("scopeId required");
    const scope = await this.domain.projectService.getScope(req.userId, scopeId);
    if (!scope) {
      throw new NotFoundException("Scope not found");
    }
    const parsed = Number(limit ?? 20);
    const take = Math.min(Number.isFinite(parsed) ? parsed : 20, 100);
    const { items, nextCursor } = await this.domain.memoryService.listEvents(scopeId, take, cursor ?? null);
    return parseOutput(MemoryEventListOutput, {
      items: items.map((event) => ({
        id: event.id,
        userId: event.userId,
        scopeId: event.scopeId,
        type: event.type,
        source: event.source,
        key: event.key ?? null,
        content: event.content,
        createdAt: event.createdAt.toISOString(),
        updatedAt: event.updatedAt ? event.updatedAt.toISOString() : null
      })),
      nextCursor
    });
  }

  @Post(["/memory/digest", "/v1/memory/digest"])
  async enqueueDigest(@Req() req: RequestWithUser, @Body() body: unknown) {
    if (!apiEnv.featureLlm) {
      throw new BadRequestException("FEATURE_LLM disabled. Enable FEATURE_LLM=true and configure MODEL_* or OPENAI_* to run digest.");
    }
    const input = DigestRequestInput.parse(body);
    const scope = await this.domain.projectService.getScope(req.userId, input.scopeId);
    if (!scope) {
      throw new NotFoundException("Scope not found");
    }
    const job = await digestQueue.add("digest_scope", { userId: req.userId, scopeId: input.scopeId });
    return parseOutput(DigestEnqueueOutput, { jobId: String(job.id) });
  }

  @Post("/memory/digest/rebuild")
  async rebuildDigest(@Req() req: RequestWithUser, @Body() body: unknown) {
    if (!apiEnv.featureLlm) {
      throw new BadRequestException("FEATURE_LLM disabled. Enable FEATURE_LLM=true and configure MODEL_* or OPENAI_* to run digest rebuild.");
    }
    const input = DigestRebuildInput.parse(body);
    const scope = await this.domain.projectService.getScope(req.userId, input.scopeId);
    if (!scope) {
      throw new NotFoundException("Scope not found");
    }
    const rebuildGroupId = randomUUID();
    const job = await digestQueue.add("rebuild_digest_chain", {
      userId: req.userId,
      scopeId: input.scopeId,
      from: input.from,
      to: input.to,
      strategy: input.strategy ?? "full",
      rebuildGroupId
    });
    return parseOutput(DigestRebuildOutput, { jobId: String(job.id), rebuildGroupId });
  }

  @Get("/memory/digests")
  async listDigests(
    @Req() req: RequestWithUser,
    @Query("scopeId") scopeId?: string,
    @Query("limit") limit?: string,
    @Query("cursor") cursor?: string,
    @Query("rebuildGroupId") rebuildGroupId?: string
  ) {
    if (!scopeId) throw new BadRequestException("scopeId required");
    const scope = await this.domain.projectService.getScope(req.userId, scopeId);
    if (!scope) {
      throw new NotFoundException("Scope not found");
    }
    const parsed = Number(limit ?? 20);
    const take = Math.min(Number.isFinite(parsed) ? parsed : 20, 100);
    const { items, nextCursor } = rebuildGroupId
      ? await this.domain.listDigests(scopeId, take, cursor ?? null, rebuildGroupId)
      : await this.domain.digestService.listDigests(scopeId, take, cursor ?? null);
    return parseOutput(DigestListOutput, {
      items: items.map((digest) => ({
        id: digest.id,
        scopeId: digest.scopeId,
        summary: digest.summary,
        changes: digest.changes,
        nextSteps: digest.nextSteps,
        createdAt: digest.createdAt.toISOString(),
        rebuildGroupId: digest.rebuildGroupId ?? null
      })),
      nextCursor
    });
  }

  @Get("/memory/state")
  async getLatestDigestState(@Req() req: RequestWithUser, @Query("scopeId") scopeId?: string) {
    if (!scopeId) throw new BadRequestException("scopeId required");
    const scope = await this.domain.projectService.getScope(req.userId, scopeId);
    if (!scope) {
      throw new NotFoundException("Scope not found");
    }
    const snapshot = await this.domain.getLatestDigestState(scopeId);
    if (!snapshot) {
      return parseOutput(DigestStateOutput, { digestId: null, state: null, consistency: null, createdAt: null });
    }
    return parseOutput(DigestStateOutput, {
      digestId: snapshot.digestId,
      state: snapshot.state,
      consistency: snapshot.consistency,
      createdAt: snapshot.createdAt.toISOString()
    });
  }

  @Get("/memory/stable-state")
  async getStableState(@Req() req: RequestWithUser, @Query("scopeId") scopeId?: string) {
    if (!scopeId) throw new BadRequestException("scopeId required");
    const scope = await this.domain.projectService.getScope(req.userId, scopeId);
    if (!scope) {
      throw new NotFoundException("Scope not found");
    }
    const snapshot = await this.domain.getStateLayerView(scopeId);
    if (!snapshot) {
      return parseOutput(StableStateOutput, { digestId: null, state: null, view: null, consistency: null, createdAt: null });
    }
    return parseOutput(StableStateOutput, {
      digestId: snapshot.digestId,
      state: snapshot.state,
      view: snapshot.view,
      consistency: snapshot.consistency,
      createdAt: snapshot.createdAt.toISOString()
    });
  }

  @Get("/memory/working-state")
  async getWorkingState(@Req() req: RequestWithUser, @Query("scopeId") scopeId?: string) {
    if (!scopeId) throw new BadRequestException("scopeId required");
    const scope = await this.domain.projectService.getScope(req.userId, scopeId);
    if (!scope) {
      throw new NotFoundException("Scope not found");
    }
    const snapshot = await this.domain.getLatestWorkingMemory(scopeId);
    if (!snapshot) {
      return parseOutput(WorkingMemoryOutput, { scopeId, version: 0, state: null, view: null, updatedAt: null });
    }
    return parseOutput(WorkingMemoryOutput, {
      scopeId,
      version: snapshot.version,
      state: snapshot.state,
      view: snapshot.view,
      updatedAt: snapshot.updatedAt.toISOString()
    });
  }

  @Get("/memory/fast-view")
  async getFastView(
    @Req() req: RequestWithUser,
    @Query("scopeId") scopeId?: string,
    @Query("message") message?: string
  ) {
    if (!scopeId) throw new BadRequestException("scopeId required");
    const scope = await this.domain.projectService.getScope(req.userId, scopeId);
    if (!scope) {
      throw new NotFoundException("Scope not found");
    }
    const resolvedMessage = message || "Show the current fast-layer context.";
    const recall = await this.resolveRuntimeRecall(scopeId, resolvedMessage);
    return parseOutput(FastLayerViewOutput, {
      scopeId,
      workingMemoryVersion: recall.workingMemorySnapshot?.version ?? null,
      stableStateVersion: recall.stateRef ?? null,
      retrievalPlan: recall.retrievalPlan ?? null,
      fastLayerContext: recall.fastLayerContext ?? compileFastLayerContext({
        message: resolvedMessage,
        workingMemoryView: recall.workingMemoryView,
        stateLayerView: recall.stableStateView ?? compileStateLayerView(recall.stateSnapshot?.state ?? null),
        retrievalSnippets: recall.events.map((event) => ({
          id: event.id,
          content: event.content,
          createdAt: event.createdAt
        })),
        recentTurns: recall.recentTurns ?? []
      })
    });
  }

  @Get("/memory/layer-status")
  async getLayerStatus(
    @Req() req: RequestWithUser,
    @Query("scopeId") scopeId?: string,
    @Query("message") message?: string
  ) {
    if (!scopeId) throw new BadRequestException("scopeId required");
    const scope = await this.domain.projectService.getScope(req.userId, scopeId);
    if (!scope) {
      throw new NotFoundException("Scope not found");
    }
    const resolvedMessage = message || "What is the current architecture goal?";
    const recall = await this.resolveRuntimeRecall(scopeId, resolvedMessage);
    return await this.buildLayerStatus(scopeId, resolvedMessage, recall);
  }

  @Get("/memory/state/history")
  async getDigestStateHistory(
    @Req() req: RequestWithUser,
    @Query("scopeId") scopeId?: string,
    @Query("limit") limit?: string,
    @Query("rebuildGroupId") rebuildGroupId?: string
  ) {
    if (!scopeId) throw new BadRequestException("scopeId required");
    const scope = await this.domain.projectService.getScope(req.userId, scopeId);
    if (!scope) {
      throw new NotFoundException("Scope not found");
    }
    const parsed = Number(limit ?? 10);
    const take = Math.min(Number.isFinite(parsed) ? parsed : 10, 50);
    const items = await this.domain.listDigestStates(scopeId, take, rebuildGroupId ?? null);
    return parseOutput(DigestStateHistoryOutput, {
      items: items.map((snapshot) => ({
        digestId: snapshot.digestId,
        state: snapshot.state,
        consistency: snapshot.consistency,
        createdAt: snapshot.createdAt.toISOString()
      }))
    });
  }

  @Post(["/memory/retrieve", "/v1/memory/retrieve"])
  async retrieve(@Req() req: RequestWithUser, @Body() body: unknown) {
    const input = RetrieveInput.parse(body);
    const scope = await this.domain.projectService.getScope(req.userId, input.scopeId);
    if (!scope) {
      throw new NotFoundException("Scope not found");
    }
    const limit = input.limit ?? 20;
    const [result, snapshot] = await Promise.all([
      this.domain.retrieveService.retrieve(input.scopeId, limit, input.query),
      this.domain.getLatestDigestState(input.scopeId)
    ]);
    const activeFactRegistry = snapshot ? getActiveFactRegistry(snapshot.state) : [];
    return parseOutput(RetrieveOutput, {
      digest: result.digest ? result.digest.summary : null,
      events: result.events.map((event) => ({
        id: event.id,
        content: event.content,
        createdAt: event.createdAt.toISOString()
      })),
      factRegistry: activeFactRegistry,
      retrieval: result.retrieval
    });
  }

  @Post(["/memory/answer", "/v1/memory/answer"])
  async answer(@Req() req: RequestWithUser, @Body() body: unknown) {
    if (!apiEnv.featureLlm || !this.answerLlm) {
      throw new BadRequestException("FEATURE_LLM disabled");
    }
    const input = AnswerInput.parse(body);
    const scope = await this.domain.projectService.getScope(req.userId, input.scopeId);
    if (!scope) {
      throw new NotFoundException("Scope not found");
    }
    const result = await this.domain.retrieveService.retrieve(input.scopeId, 25, input.question);
    const snapshot = await this.domain.getLatestDigestState(input.scopeId);
    const digestText = result.digest ? result.digest.summary : null;
    const eventsText = result.events.map((event) => `- ${event.createdAt.toISOString()}: ${event.content}`).join("\n");

    const answer = await generateAnswer({
      question: input.question,
      digestText,
      eventsText,
      systemPrompt: answerSystemPrompt,
      userPromptTemplate: answerUserPrompt,
      llm: this.answerLlm
    });

    return parseOutput(AnswerOutput, {
      answer,
      evidence: buildGroundingEvidence({
        digest: result.digest,
        events: result.events,
        retrieval: result.retrieval,
        stateRef: snapshot?.digestId ?? null,
        stateSnapshot: snapshot ? { digestId: snapshot.digestId, state: snapshot.state } : null
      })
    });
  }

  @Post(["/memory/runtime/turn", "/v1/memory/runtime/turn"])
  async runtimeTurn(@Req() req: RequestWithUser, @Body() body: unknown) {
    if (!apiEnv.featureLlm || !this.runtimeLlm) {
      throw new BadRequestException("FEATURE_LLM disabled");
    }
    const input = RuntimeTurnInput.parse(body);
    const scope = await this.domain.projectService.getScope(req.userId, input.scopeId);
    if (!scope) {
      throw new NotFoundException("Scope not found");
    }

    return parseOutput(RuntimeTurnOutput, await this.executeRuntimeTurn(req.userId, input));
  }

  @Post("/demo/agent-scenarios/:id/run")
  async runAgentScenario(@Req() req: RequestWithUser, @Param("id") scenarioId: string) {
    if (!apiEnv.featureLlm || !this.runtimeLlm) {
      throw new BadRequestException("FEATURE_LLM disabled");
    }

    const scenario = AGENT_SCENARIOS.find((item) => item.id === scenarioId);
    if (!scenario) {
      throw new BadRequestException(`Unknown agent scenario: ${scenarioId}`);
    }

    const scope = await this.domain.projectService.createScope(
      req.userId,
      `${scenario.title} run`,
      null,
      "build"
    );

    let previousWorkingView: SimpleWorkingView = null;
    let previousStableView: SimpleStableView = null;
    const steps = [];

    for (const step of scenario.steps) {
      const runtimeMessage = step.runtimeMessage ?? step.userTurn;
      const result = await this.executeRuntimeTurn(req.userId, {
        scopeId: scope.id,
        message: runtimeMessage,
        source: "api",
        writeTier: "stable",
        digestMode: "force",
        metadata: {
          demoKind: "agent_scenario",
          agentScenarioId: scenario.id,
          agentRole: step.activeAgent
        }
      });

      const settled = await this.waitForRuntimeArtifacts(scope.id, runtimeMessage, result.digestTriggered);
      const workingView = (settled.working?.view ?? null) as SimpleWorkingView;
      const stableView = (settled.stable?.view ?? null) as SimpleStableView;

      steps.push({
        label: step.label,
        activeAgent: step.activeAgent,
        userTurn: step.userTurn,
        answer: result.answer,
        answerMode: result.answerMode ?? null,
        retrievalPlan: result.retrievalPlan ?? null,
        digestTriggered: result.digestTriggered,
        workingMemoryVersion: settled.working?.version ?? result.workingMemoryVersion ?? null,
        stableStateVersion: settled.stable?.digestId ?? result.stableStateVersion ?? null,
        workingMemoryView: workingView,
        stableStateView: stableView,
        layerAlignment: settled.layer.layerAlignment ?? result.layerAlignment ?? null,
        warnings: Array.from(new Set([...(settled.layer.warnings || []), ...(result.warnings || [])])),
        workingWrites: diffWorkingView(previousWorkingView, workingView),
        stableWrites: diffStableView(previousStableView, stableView),
        nextAgentSees: buildNextAgentSees(workingView, stableView),
        completedAt: new Date().toISOString()
      });

      previousWorkingView = workingView;
      previousStableView = stableView;
    }

    return parseOutput(AgentScenarioRunOutput, {
      scenarioId: scenario.id,
      title: scenario.title,
      scopeId: scope.id,
      scopeName: scope.name,
      completedAt: new Date().toISOString(),
      steps
    });
  }
}
