import { randomUUID } from "crypto";
import { Queue, Worker } from "bullmq";
import { prisma } from "@statecore/db";
import {
  WorkingMemoryService,
  createModelProvider,
  logger,
  mergeWorkingMemoryState,
  runDigestControlPipeline,
  selectWorkingMemoryEvents,
  computeDriftMetrics,
  getDomainConfig
} from "@statecore/core";
import type { DigestState, DriftMetrics, WorkingMemoryState, WorkingMemoryView } from "@statecore/core";
import {
  digestClassifySystemPrompt,
  digestClassifyUserPrompt,
  digestStage2SystemPrompt,
  digestStage2UserPrompt
} from "@statecore/prompts";
import { workerEnv } from "./env";
import { withDigestLock, DigestAlreadyRunningError, type LockRedis } from "./digest-lock";
import { processRebuildDigestChainJob } from "./rebuild-job";
import { runEmbedEventJob } from "./embed-job";
import { runClassifyEventJob } from "./classify-job";
import { runDetectEmotionalPatternsJob } from "./detect-patterns";
import { runDailyRemindJob } from "./daily-remind";
import Redis from "ioredis";

const connection = {
  url: workerEnv.redisUrl
};

const lockRedis = new Redis(workerEnv.redisUrl) as unknown as LockRedis;

const reminderQueue = new Queue("reminder", { connection });

type WorkingMemoryPatch = Partial<Pick<
  WorkingMemoryState,
  "currentGoal" | "activeConstraints" | "recentDecisions" | "progressSummary" | "openQuestions" | "taskFrame"
>>;

function shouldAttemptWorkingMemoryLlm(events: Array<{ content: string }>, state: WorkingMemoryState) {
  if (state.currentGoal && state.activeConstraints.length && state.openQuestions.length) {
    return false;
  }

  return events.some((event) =>
    /\b(i am|i'm)\s+trying\s+to\b/i.test(event.content)
    || /\b(i want to|i'd like to|i would like to|my goal is to)\b/i.test(event.content)
    || /\b(i prefer|i'd prefer|prefer)\b/i.test(event.content)
    || /\?$/.test(event.content.trim())
  );
}

function parseJsonObject(text: string) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? text;
  const objectMatch = candidate.match(/\{[\s\S]*\}/);
  if (!objectMatch) {
    throw new Error("working_memory_llm_missing_json");
  }
  return JSON.parse(objectMatch[0]) as WorkingMemoryPatch;
}

async function refineWorkingMemoryStateWithLlm(input: {
  scopeId: string;
  events: Array<{ id: string; type: "stream" | "document"; content: string; createdAt: Date; role?: "user" | "assistant" | "system" }>;
  state: WorkingMemoryState;
}) {
  if (!workerEnv.workingMemoryUseLlm || !llm) {
    return input.state;
  }
  if (!shouldAttemptWorkingMemoryLlm(input.events, input.state)) {
    return input.state;
  }

  const transcript = input.events
    .map((event) => `[${event.role ?? "user"}] ${event.content}`)
    .join("\n");

  try {
    const response = await llm.chat([
      {
        role: "system",
        content:
          "Extract lightweight working memory from natural language conversation. Return only JSON with keys: currentGoal, activeConstraints, recentDecisions, progressSummary, openQuestions, taskFrame. Use arrays for list fields. Leave fields empty or omit them when unsure. Keep phrases short and concrete."
      },
      {
        role: "user",
        content: `Current heuristic state:\n${JSON.stringify(input.state, null, 2)}\n\nRecent conversation:\n${transcript}`
      }
    ]);

    const parsed = parseJsonObject(response);
    return mergeWorkingMemoryState(input.state, {
      currentGoal: typeof parsed.currentGoal === "string" ? parsed.currentGoal.trim() : undefined,
      activeConstraints: Array.isArray(parsed.activeConstraints) ? parsed.activeConstraints.filter((item): item is string => typeof item === "string") : undefined,
      recentDecisions: Array.isArray(parsed.recentDecisions) ? parsed.recentDecisions.filter((item): item is string => typeof item === "string") : undefined,
      progressSummary: typeof parsed.progressSummary === "string" ? parsed.progressSummary.trim() : undefined,
      openQuestions: Array.isArray(parsed.openQuestions) ? parsed.openQuestions.filter((item): item is string => typeof item === "string") : undefined,
      taskFrame: typeof parsed.taskFrame === "string" ? parsed.taskFrame.trim() : undefined
    }, {
      maxItemsPerField: workerEnv.workingMemoryMaxItemsPerField
    });
  } catch (error) {
    logger.warn({ scopeId: input.scopeId, err: error }, "Working memory LLM refinement failed; keeping heuristic state");
    return input.state;
  }
}

const workingMemoryService = new WorkingMemoryService({
  findLatest: async (scopeId) => {
    const snapshot = await prisma.workingMemorySnapshot.findUnique({ where: { scopeId } });
    if (!snapshot) return null;
    return {
      id: snapshot.id,
      scopeId: snapshot.scopeId,
      version: snapshot.version,
      state: snapshot.state as unknown as WorkingMemoryState,
      view: snapshot.view as unknown as WorkingMemoryView,
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt
    };
  },
  upsert: async (input) => {
    const snapshot = await prisma.workingMemorySnapshot.upsert({
      where: { scopeId: input.scopeId },
      update: {
        version: input.version,
        state: input.state as any,
        view: input.view as any
      },
      create: {
        scopeId: input.scopeId,
        version: input.version,
        state: input.state as any,
        view: input.view as any
      }
    });
    return {
      id: snapshot.id,
      scopeId: snapshot.scopeId,
      version: snapshot.version,
      state: snapshot.state as unknown as WorkingMemoryState,
      view: snapshot.view as unknown as WorkingMemoryView,
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt
    };
  }
}, {
  maxItemsPerField: workerEnv.workingMemoryMaxItemsPerField,
  refineState: async ({ scopeId, events, state }) =>
    refineWorkingMemoryStateWithLlm({
      scopeId,
      events,
      state
    })
});

const structuredOutputModel = workerEnv.featureLlm
  ? createModelProvider({
      provider: workerEnv.modelProvider,
      apiKey: workerEnv.modelApiKey,
      baseUrl: workerEnv.modelBaseUrl,
      model: workerEnv.modelName,
      chatApiKey: workerEnv.chatModelApiKey,
      chatBaseUrl: workerEnv.chatModelBaseUrl,
      chatModel: workerEnv.chatModelName,
      structuredOutputApiKey: workerEnv.structuredOutputModelApiKey,
      structuredOutputBaseUrl: workerEnv.structuredOutputModelBaseUrl,
      structuredOutputModel: workerEnv.structuredOutputModelName,
      embeddingApiKey: workerEnv.embeddingModelApiKey,
      embeddingBaseUrl: workerEnv.embeddingModelBaseUrl,
      embeddingModel: workerEnv.embeddingModelName || undefined,
      timeoutMs: workerEnv.modelTimeoutMs
    })?.structuredOutput ?? null
  : null;

const llm = structuredOutputModel
  ? {
      chat: (messages: { role: "system" | "user"; content: string }[]) =>
        structuredOutputModel.chat(messages, {
          ...(typeof workerEnv.structuredOutputMaxOutputTokens === "number"
            ? { maxOutputTokens: workerEnv.structuredOutputMaxOutputTokens }
            : {}),
          ...(workerEnv.structuredOutputReasoningEffort
            ? { reasoningEffort: workerEnv.structuredOutputReasoningEffort }
            : {})
        })
    }
  : null;

async function sendTelegramMessage(telegramUserId: string, text: string) {
  if (!workerEnv.featureTelegram || !workerEnv.telegramBotToken) return;
  await fetch(`https://api.telegram.org/bot${workerEnv.telegramBotToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: telegramUserId, text })
  });
}

function toCoreDigest(digest: { id: string; scopeId: string; summary: string; changes: string; nextSteps: unknown; createdAt: Date; rebuildGroupId?: string | null }) {
  return {
    id: digest.id,
    scopeId: digest.scopeId,
    summary: digest.summary,
    changes: digest.changes,
    nextSteps: Array.isArray(digest.nextSteps) ? (digest.nextSteps as string[]) : [],
    createdAt: digest.createdAt,
    rebuildGroupId: digest.rebuildGroupId
  };
}

async function runDigestScopeJob(data: { userId: string; scopeId: string }): Promise<{ driftMetrics: DriftMetrics }> {
  if (!workerEnv.featureLlm || !llm) {
    throw new Error("FEATURE_LLM disabled or model provider not configured. Set FEATURE_LLM=true and configure MODEL_* or OPENAI_*.");
  }

  const t0 = Date.now();
  const scope = await prisma.projectScope.findFirst({ where: { id: data.scopeId, userId: data.userId } });
  if (!scope) {
    throw new Error("Scope not found for user");
  }

  const lastDigestRow = await prisma.digest.findFirst({
    where: { scopeId: data.scopeId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }]
  });

  const lastStateRow = await prisma.digestStateSnapshot.findFirst({
    where: { scopeId: data.scopeId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }]
  });

  const since = new Date(Date.now() - workerEnv.maxDaysLookback * 24 * 60 * 60 * 1000);
  const streamEventQuery = {
    where: { scopeId: data.scopeId, createdAt: { gte: since }, type: "stream" as const },
    orderBy: [{ createdAt: "desc" as const }, { id: "desc" as const }],
    take: lastDigestRow ? workerEnv.maxRecentEvents : workerEnv.digestFirstRunMaxEvents
  };
  const recentStreamEvents = await prisma.memoryEvent.findMany({
    ...streamEventQuery
  });
  const recentDocumentEvents = await prisma.memoryEvent.findMany({
    where: { scopeId: data.scopeId, createdAt: { gte: since }, type: "document" },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }]
  });
  const recentEvents = [...recentStreamEvents, ...recentDocumentEvents];

  const prevDigestState = (lastStateRow?.state as unknown as DigestState) ?? null;

  const result = await runDigestControlPipeline({
    scope,
    lastDigest: lastDigestRow ? toCoreDigest(lastDigestRow) : null,
    prevState: prevDigestState,
    recentEvents,
    llm,
    prompts: {
      digestStage2SystemPrompt,
      digestStage2UserPrompt,
      digestClassifySystemPrompt,
      digestClassifyUserPrompt
    },
    config: {
      eventBudgetTotal: workerEnv.digestEventBudgetTotal,
      eventBudgetDocs: workerEnv.digestEventBudgetDocs,
      eventBudgetStream: workerEnv.digestEventBudgetStream,
      noveltyThreshold: workerEnv.digestNoveltyThreshold,
      maxRetries: workerEnv.digestMaxRetries,
      useLlmClassifier: workerEnv.digestUseLlmClassifier,
      debug: workerEnv.digestDebug
    }
  });

  const driftMetrics = computeDriftMetrics(prevDigestState, result.state);

  const createdDigest = await prisma.digest.create({
    data: {
      scopeId: data.scopeId,
      summary: result.digest.summary,
      changes: result.digest.changes.map((c) => `- ${c}`).join("\n"),
      nextSteps: result.digest.nextSteps
    } as any
  });

  await prisma.digestStateSnapshot.create({
    data: {
      scopeId: data.scopeId,
      digestId: createdDigest.id,
      state: result.state as any,
      consistency: result.consistency as any
    } as any
  });

  logger.info({
    scopeId: data.scopeId,
    stage: "selection",
    tookMs: result.metrics.selectionMs,
    selectedCount: result.selection.selectedEvents.length,
    docCount: result.selection.documents.length
  }, "Digest stage completed");
  if (typeof result.metrics.classificationMs === "number") {
    logger.info({
      scopeId: data.scopeId,
      stage: "classification",
      tookMs: result.metrics.classificationMs
    }, "Digest stage completed");
  }
  logger.info({
    scopeId: data.scopeId,
    stage: "delta_detection",
    tookMs: result.metrics.deltaMs,
    deltaCount: result.deltas.length
  }, "Digest stage completed");
  logger.info({
    scopeId: data.scopeId,
    stage: "state_merge",
    tookMs: result.metrics.mergeMs
  }, "Digest stage completed");
  logger.info({
    scopeId: data.scopeId,
    stage: "generation",
    tookMs: result.metrics.generationMs
  }, "Digest stage completed");
  logger.info({
    scopeId: data.scopeId,
    selectedCount: result.selection.selectedEvents.length,
    deltaCount: result.deltas.length,
    metrics: result.metrics,
    tookMs: Date.now() - t0
  }, "Digest pipeline completed");

  if (workerEnv.digestDebug) {
    logger.info({ scopeId: data.scopeId, rationale: result.selection.rationale, deltas: result.deltas.map((d) => ({ id: d.eventId, reason: d.reason })) }, "Digest debug details");
  }

  return { driftMetrics };
}

async function runWorkingMemoryUpdateJob(data: { userId: string; scopeId: string }) {
  if (!workerEnv.workingMemoryEnabled) {
    return;
  }

  const scope = await prisma.projectScope.findFirst({ where: { id: data.scopeId, userId: data.userId } });
  if (!scope) {
    throw new Error("Scope not found for user");
  }

  const recentEvents = await prisma.memoryEvent.findMany({
    where: { scopeId: data.scopeId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: Math.max(workerEnv.workingMemoryMaxRecentTurns * 3, workerEnv.workingMemoryMaxRecentTurns + 8)
  });

  const selectedEvents = selectWorkingMemoryEvents(recentEvents.reverse().map((event) => ({
    id: event.id,
    type: event.type,
    key: event.key,
    content: event.content,
    createdAt: event.createdAt,
    role: /^assistant reply:/i.test(event.content.trim()) ? "assistant" : "user"
  })), workerEnv.workingMemoryMaxRecentTurns);

  const startedAt = Date.now();
  const snapshot = await workingMemoryService.updateFromEvents(data.scopeId, selectedEvents, scope.goal);

  logger.info({
    scopeId: data.scopeId,
    version: snapshot.version,
    tookMs: Date.now() - startedAt
  }, "Working memory updated");
}

async function runRebuildDigestChainJob(data: { userId: string; scopeId: string; from?: string; to?: string; strategy?: "full" | "since_last_good"; rebuildGroupId?: string }) {
  if (!workerEnv.featureLlm || !llm) {
    throw new Error("FEATURE_LLM disabled or model provider not configured. Rebuild requires MODEL_* or OPENAI_* configuration.");
  }

  const scope = await prisma.projectScope.findFirst({ where: { id: data.scopeId, userId: data.userId } });
  if (!scope) throw new Error("Scope not found for user");

  let fromDate = data.from ? new Date(data.from) : undefined;
  const toDate = data.to ? new Date(data.to) : undefined;

  if (data.strategy === "since_last_good" && !fromDate) {
    const latest = await prisma.digest.findFirst({ where: { scopeId: data.scopeId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    if (latest) fromDate = latest.createdAt;
  }

  const events = await prisma.memoryEvent.findMany({
    where: {
      scopeId: data.scopeId,
      ...(fromDate || toDate
        ? {
            createdAt: {
              ...(fromDate ? { gte: fromDate } : {}),
              ...(toDate ? { lte: toDate } : {})
            }
          }
        : {})
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }]
  });

  if (!events.length) {
    throw new Error("No events found in rebuild range");
  }

  const rebuildGroupId = data.rebuildGroupId || randomUUID();
  let lastDigest = data.strategy === "full"
    ? null
    : await prisma.digest.findFirst({ where: { scopeId: data.scopeId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  let lastState: DigestState | null = null;
  if (lastDigest && data.strategy !== "full") {
    const snapshot = await prisma.digestStateSnapshot.findUnique({ where: { digestId: lastDigest.id } });
    lastState = (snapshot?.state as unknown as DigestState) ?? null;
  }

  for (let i = 0; i < events.length; i += workerEnv.digestRebuildChunkSize) {
    const chunk = events.slice(i, i + workerEnv.digestRebuildChunkSize).reverse();

    const result = await runDigestControlPipeline({
      scope,
      lastDigest: lastDigest ? toCoreDigest(lastDigest) : null,
      prevState: lastState,
      recentEvents: chunk,
      llm,
      prompts: {
        digestStage2SystemPrompt,
        digestStage2UserPrompt,
        digestClassifySystemPrompt,
        digestClassifyUserPrompt
      },
      config: {
        eventBudgetTotal: workerEnv.digestEventBudgetTotal,
        eventBudgetDocs: workerEnv.digestEventBudgetDocs,
        eventBudgetStream: workerEnv.digestEventBudgetStream,
        noveltyThreshold: workerEnv.digestNoveltyThreshold,
        maxRetries: workerEnv.digestMaxRetries,
        useLlmClassifier: workerEnv.digestUseLlmClassifier,
        debug: workerEnv.digestDebug
      }
    });

    lastDigest = await prisma.digest.create({
      data: {
        scopeId: data.scopeId,
        summary: result.digest.summary,
        changes: result.digest.changes.map((c) => `- ${c}`).join("\n"),
        nextSteps: result.digest.nextSteps,
        rebuildGroupId
      } as any
    });

    await prisma.digestStateSnapshot.create({
      data: {
        scopeId: data.scopeId,
        digestId: lastDigest.id,
        state: result.state as any,
        consistency: result.consistency as any
      } as any
    });

    lastState = result.state;
  }

  logger.info({ scopeId: data.scopeId, rebuildGroupId, eventCount: events.length }, "Digest rebuild chain completed");
}

new Worker(
  "digest",
  async (job) => {
    if (job.name === "digest_scope") {
      const data = job.data as { userId: string; scopeId: string };
      const t0 = Date.now();
      try {
        const { driftMetrics } = await withDigestLock(lockRedis, data.scopeId, () => runDigestScopeJob(data));
        await prisma.digestJobLog.create({
          data: { scopeId: data.scopeId, jobId: job.id ?? undefined, status: "success", durationMs: Date.now() - t0, driftMetrics: driftMetrics as any }
        });
        return { ok: true };
      } catch (err) {
        if (err instanceof DigestAlreadyRunningError) {
          logger.info({ scopeId: data.scopeId }, "Digest already running for scope — skipping");
          return { ok: true, skipped: true };
        }
        await prisma.digestJobLog.create({
          data: {
            scopeId: data.scopeId,
            jobId: job.id ?? undefined,
            status: "failed",
            durationMs: Date.now() - t0,
            error: err instanceof Error ? err.message : String(err)
          }
        });
        throw err;
      }
    }

    if (job.name === "rebuild_digest_chain") {
      return processRebuildDigestChainJob(
        lockRedis,
        job.data as { userId: string; scopeId: string; from?: string; to?: string; strategy?: "full" | "since_last_good"; rebuildGroupId?: string },
        runRebuildDigestChainJob,
        logger
      );
    }
  },
  { connection, concurrency: workerEnv.digestConcurrency }
).on("completed", (job) => {
  logger.info({ jobId: job.id, name: job.name }, "Digest job completed");
}).on("failed", (job, err) => {
  logger.error({ jobId: job?.id, name: job?.name, err }, "Digest job failed");
});

new Worker(
  "working-memory",
  async (job) => {
    if (job.name !== "working_memory_update") return;
    await runWorkingMemoryUpdateJob(job.data as { userId: string; scopeId: string });
    return { ok: true };
  },
  { connection, concurrency: Math.max(1, workerEnv.digestConcurrency) }
).on("completed", (job) => {
  logger.info({ jobId: job.id, name: job.name }, "Working memory job completed");
}).on("failed", (job, err) => {
  logger.error({ jobId: job?.id, name: job?.name, err }, "Working memory job failed");
});

new Worker(
  "reminder",
  async (job) => {
    if (job.name !== "send_reminders") return;
    const now = new Date();
    let batches = 0;
    while (batches < workerEnv.reminderMaxBatches) {
      const due = await prisma.reminder.findMany({
        where: { status: "scheduled", dueAt: { lte: now } },
        orderBy: { dueAt: "asc" },
        take: workerEnv.reminderBatchSize,
        include: { user: true }
      });

      if (!due.length) break;

      for (const reminder of due) {
        await prisma.reminder.update({ where: { id: reminder.id }, data: { status: "sent" } });
        if (reminder.user.telegramUserId) {
          await sendTelegramMessage(reminder.user.telegramUserId, `Reminder: ${reminder.text}`);
        }
      }

      batches += 1;
      if (due.length < workerEnv.reminderBatchSize) break;
    }

    return { ok: true };
  },
  { connection, concurrency: workerEnv.reminderConcurrency }
).on("completed", (job) => {
  logger.info({ jobId: job.id, name: job.name }, "Reminder job completed");
}).on("failed", (job, err) => {
  logger.error({ jobId: job?.id, name: job?.name, err }, "Reminder job failed");
});

const workerEmbeddingModel = workerEnv.featureLlm && workerEnv.embeddingModelName
  ? createModelProvider({
      provider: workerEnv.modelProvider,
      apiKey: workerEnv.modelApiKey,
      baseUrl: workerEnv.modelBaseUrl,
      model: workerEnv.modelName,
      embeddingApiKey: workerEnv.embeddingModelApiKey,
      embeddingBaseUrl: workerEnv.embeddingModelBaseUrl,
      embeddingModel: workerEnv.embeddingModelName || undefined,
      timeoutMs: workerEnv.modelTimeoutMs
    })?.embedding ?? null
  : null;

new Worker(
  "embed",
  async (job) => {
    if (job.name !== "embed_event") return;
    await runEmbedEventJob(
      job.data as { eventId: string; scopeId: string },
      workerEmbeddingModel,
      prisma,
      workerEnv.embeddingModelName
    );
    return { ok: true };
  },
  { connection, concurrency: 4 }
).on("completed", (job) => {
  logger.info({ jobId: job.id }, "Embed job completed");
}).on("failed", (job, err) => {
  logger.error({ jobId: job?.id, err }, "Embed job failed");
});

new Worker(
  "classify",
  async (job) => {
    if (job.name !== "classify_event") return;
    if (!llm) return;
    await runClassifyEventJob(
      job.data as { eventId: string; scopeId: string },
      llm,
      prisma
    );
    return { ok: true };
  },
  { connection, concurrency: 4 }
).on("failed", (job, err) => {
  logger.warn({ jobId: job?.id, err }, "Classify job failed — event stored without classification");
});

setInterval(() => {
  reminderQueue.add(
    "send_reminders",
    {},
    { jobId: "send_reminders_tick", removeOnComplete: true, removeOnFail: true }
  );
}, 60_000);

// expire_events: purge MemoryEvent rows past their expiresAt (runs every 6 hours)
setInterval(() => {
  prisma.memoryEvent.deleteMany({
    where: { expiresAt: { lt: new Date() } }
  }).then(({ count }) => {
    if (count > 0) logger.info({ count }, "Expired events purged");
  }).catch((err) => {
    logger.error({ err }, "expire_events failed");
  });
}, 6 * 60 * 60 * 1000);

// Run daily_remind once per day (24h)
setInterval(() => {
  if (!llm) return;
  runDailyRemindJob(llm, prisma).catch((err) => {
    logger.error({ err }, "daily_remind job crashed");
  });
}, 24 * 60 * 60 * 1000);

setInterval(() => {
  if (!llm) return;
  runDetectEmotionalPatternsJob(llm, prisma).catch((err) => {
    logger.error({ err }, "detect_emotional_patterns job crashed");
  });
}, 7 * 24 * 60 * 60 * 1000);

logger.info("Worker started");
