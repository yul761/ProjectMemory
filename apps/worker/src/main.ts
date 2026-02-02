import { Queue, Worker } from "bullmq";
import { prisma } from "@project-memory/db";
import { generateDigest, LlmClient, logger } from "@project-memory/core";
import { digestSystemPrompt, digestUserPrompt } from "@project-memory/prompts";
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
  const userId = telegramUserId.replace("telegram:", "");
  await fetch(`https://api.telegram.org/bot${workerEnv.telegramBotToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: userId, text })
  });
}

new Worker(
  "digest",
  async (job) => {
    if (job.name !== "digest_scope") return;
    if (!workerEnv.featureLlm || !llm) {
      throw new Error("FEATURE_LLM disabled or missing OPENAI_API_KEY");
    }

    const { userId, scopeId } = job.data as { userId: string; scopeId: string };
    const scope = await prisma.projectScope.findFirst({ where: { id: scopeId, userId } });
    if (!scope) {
      throw new Error("Scope not found for user");
    }

    const lastDigest = await prisma.digest.findFirst({
      where: { scopeId },
      orderBy: { createdAt: "desc" }
    });

    const since = new Date(Date.now() - workerEnv.maxDaysLookback * 24 * 60 * 60 * 1000);
    const recentEvents = await prisma.memoryEvent.findMany({
      where: { scopeId, createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: workerEnv.maxRecentEvents
    });

    const digest = await generateDigest({
      scope,
      lastDigest: lastDigest
        ? {
            id: lastDigest.id,
            scopeId: lastDigest.scopeId,
            summary: lastDigest.summary,
            changes: lastDigest.changes,
            nextSteps: Array.isArray(lastDigest.nextSteps) ? (lastDigest.nextSteps as string[]) : [],
            createdAt: lastDigest.createdAt
          }
        : null,
      recentEvents,
      systemPrompt: digestSystemPrompt,
      userPromptTemplate: digestUserPrompt,
      llm
    });

    const changesText = digest.changes.map((c) => `- ${c}`).join("\n");

    await prisma.digest.create({
      data: {
        scopeId,
        summary: digest.summary,
        changes: changesText,
        nextSteps: digest.nextSteps
      }
    });

    return { ok: true };
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
      if (reminder.user.telegramUserId?.startsWith("telegram:")) {
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
