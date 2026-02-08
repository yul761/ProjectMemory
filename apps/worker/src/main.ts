import { randomUUID } from "crypto";
import { Queue, Worker } from "bullmq";
import { prisma } from "@project-memory/db";
import { LlmClient, logger, runDigestControlPipeline } from "@project-memory/core";
import {
  digestClassifySystemPrompt,
  digestClassifyUserPrompt,
  digestStage2SystemPrompt,
  digestStage2UserPrompt
} from "@project-memory/prompts";
import { workerEnv } from "./env";

const connection = {
  url: workerEnv.redisUrl
};

const reminderQueue = new Queue("reminder", { connection });

const llm = workerEnv.featureLlm && workerEnv.openaiApiKey
  ? new LlmClient({
      apiKey: workerEnv.openaiApiKey,
      baseUrl: workerEnv.openaiBaseUrl,
      model: workerEnv.openaiModel,
      timeoutMs: 20000
    })
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

async function runDigestScopeJob(data: { userId: string; scopeId: string }) {
  if (!workerEnv.featureLlm || !llm) {
    throw new Error("FEATURE_LLM disabled or missing OPENAI_API_KEY. Set FEATURE_LLM=true and OPENAI_API_KEY.");
  }

  const t0 = Date.now();
  const scope = await prisma.projectScope.findFirst({ where: { id: data.scopeId, userId: data.userId } });
  if (!scope) {
    throw new Error("Scope not found for user");
  }

  const lastDigestRow = await prisma.digest.findFirst({
    where: { scopeId: data.scopeId },
    orderBy: { createdAt: "desc" }
  });

  const since = new Date(Date.now() - workerEnv.maxDaysLookback * 24 * 60 * 60 * 1000);
  const recentEvents = await prisma.memoryEvent.findMany({
    where: { scopeId: data.scopeId, createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    take: workerEnv.maxRecentEvents
  });

  const result = await runDigestControlPipeline({
    scope,
    lastDigest: lastDigestRow ? toCoreDigest(lastDigestRow) : null,
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

  await prisma.digest.create({
    data: {
      scopeId: data.scopeId,
      summary: result.digest.summary,
      changes: result.digest.changes.map((c) => `- ${c}`).join("\n"),
      nextSteps: result.digest.nextSteps
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
}

async function runRebuildDigestChainJob(data: { userId: string; scopeId: string; from?: string; to?: string; strategy?: "full" | "since_last_good" }) {
  if (!workerEnv.featureLlm || !llm) {
    throw new Error("FEATURE_LLM disabled or missing OPENAI_API_KEY. Rebuild requires LLM.");
  }

  const scope = await prisma.projectScope.findFirst({ where: { id: data.scopeId, userId: data.userId } });
  if (!scope) throw new Error("Scope not found for user");

  let fromDate = data.from ? new Date(data.from) : undefined;
  const toDate = data.to ? new Date(data.to) : undefined;

  if (data.strategy === "since_last_good" && !fromDate) {
    const latest = await prisma.digest.findFirst({ where: { scopeId: data.scopeId }, orderBy: { createdAt: "desc" } });
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
    orderBy: { createdAt: "asc" }
  });

  if (!events.length) {
    throw new Error("No events found in rebuild range");
  }

  const rebuildGroupId = randomUUID();
  let lastDigest = data.strategy === "full"
    ? null
    : await prisma.digest.findFirst({ where: { scopeId: data.scopeId }, orderBy: { createdAt: "desc" } });

  for (let i = 0; i < events.length; i += workerEnv.digestRebuildChunkSize) {
    const chunk = events.slice(i, i + workerEnv.digestRebuildChunkSize).reverse();

    const result = await runDigestControlPipeline({
      scope,
      lastDigest: lastDigest ? toCoreDigest(lastDigest) : null,
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
  }

  logger.info({ scopeId: data.scopeId, rebuildGroupId, eventCount: events.length }, "Digest rebuild chain completed");
}

new Worker(
  "digest",
  async (job) => {
    if (job.name === "digest_scope") {
      await runDigestScopeJob(job.data as { userId: string; scopeId: string });
      return { ok: true };
    }

    if (job.name === "rebuild_digest_chain") {
      await runRebuildDigestChainJob(job.data as { userId: string; scopeId: string; from?: string; to?: string; strategy?: "full" | "since_last_good" });
      return { ok: true };
    }
  },
  { connection }
).on("completed", (job) => {
  logger.info({ jobId: job.id, name: job.name }, "Digest job completed");
}).on("failed", (job, err) => {
  logger.error({ jobId: job?.id, name: job?.name, err }, "Digest job failed");
});

new Worker(
  "reminder",
  async (job) => {
    if (job.name !== "send_reminders") return;
    const due = await prisma.reminder.findMany({
      where: { status: "scheduled", dueAt: { lte: new Date() } },
      orderBy: { dueAt: "asc" },
      take: 50,
      include: { user: true }
    });

    for (const reminder of due) {
      await prisma.reminder.update({ where: { id: reminder.id }, data: { status: "sent" } });
      if (reminder.user.telegramUserId) {
        await sendTelegramMessage(reminder.user.telegramUserId, `Reminder: ${reminder.text}`);
      }
    }

    return { ok: true };
  },
  { connection }
).on("completed", (job) => {
  logger.info({ jobId: job.id, name: job.name }, "Reminder job completed");
}).on("failed", (job, err) => {
  logger.error({ jobId: job?.id, name: job?.name, err }, "Reminder job failed");
});

setInterval(() => {
  reminderQueue.add("send_reminders", {}, { removeOnComplete: true, removeOnFail: true });
}, 60_000);

logger.info("Worker started");
