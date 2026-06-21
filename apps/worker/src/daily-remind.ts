import { prisma as defaultPrisma } from "@statecore/db";
import { getDomainConfig, logger } from "@statecore/core";

type Llm = { chat: (messages: { role: "system" | "user"; content: string }[]) => Promise<string> };

export async function runDailyRemindJob(
  llm: Llm,
  db: typeof defaultPrisma = defaultPrisma
): Promise<void> {
  const scopes = await (db as any).projectScope.findMany({
    where: { notificationWebhook: { not: null } }
  });

  for (const scope of scopes) {
    const config = getDomainConfig((scope as any).template ?? "project");
    if (!config.dailyReminderPrompt) continue;
    if (!scope.notificationWebhook) continue;

    const stateSnapshot = await db.digestStateSnapshot.findFirst({
      where: { scopeId: scope.id },
      orderBy: { createdAt: "desc" }
    });
    if (!stateSnapshot) continue;

    const commitments = await db.memoryEvent.findMany({
      where: {
        scopeId: scope.id,
        classifiedType: "commitment",
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }]
      },
      orderBy: { createdAt: "desc" },
      take: 10
    });

    const personalDetails = await db.memoryEvent.findMany({
      where: { scopeId: scope.id, classifiedType: "personal_detail" },
      orderBy: { createdAt: "asc" },
      take: 10
    });

    const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);
    const pendingFollowUps = await db.memoryEvent.findMany({
      where: {
        scopeId: scope.id,
        classifiedType: { in: ["commitment", "experience"] },
        createdAt: { lt: sevenDaysAgo }
      },
      orderBy: { createdAt: "asc" },
      take: 3
    });

    const recentPatterns = await db.memoryEvent.findMany({
      where: { scopeId: scope.id, classifiedType: "emotional_pattern" },
      orderBy: { createdAt: "desc" },
      take: 5
    });

    const state = stateSnapshot.state as any;

    const context = JSON.stringify({
      stableFacts: state?.stableFacts ?? {},
      personalDetails: personalDetails.map((e) => e.content),
      commitments: commitments.map((e) => e.content),
      pendingFollowUps: pendingFollowUps.map((e) => {
        const daysAgo = Math.floor((Date.now() - (e as any).createdAt.getTime()) / 86_400_000);
        return `${(e as any).classifiedType}: "${e.content.slice(0, 60)}" (${daysAgo} days ago, no update)`;
      }),
      emotionalPatterns: recentPatterns.map((e) => e.content),
      profile: {
        goals: state?.profile?.goals ?? [],
        ongoing: state?.profile?.ongoing ?? [],
        followUps: state?.profile?.followUps ?? [],
        relationships: state?.profile?.relationships ?? []
      }
    });

    let reminders: string[];
    try {
      const raw = await llm.chat([
        { role: "system", content: config.dailyReminderPrompt },
        { role: "user",   content: context }
      ]);
      const parsed = JSON.parse(raw) as { reminders?: string[] };
      reminders = (parsed.reminders ?? []).slice(0, 2).filter((r) => typeof r === "string");
    } catch (err) {
      logger.warn({ scopeId: scope.id, err }, "daily_remind LLM call failed");
      continue;
    }

    if (!reminders.length) continue;

    try {
      await fetch(scope.notificationWebhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scopeId: scope.id, reminders })
      });
      logger.info({ scopeId: scope.id, count: reminders.length }, "Daily reminders sent");
    } catch (err) {
      logger.warn({ scopeId: scope.id, err }, "daily_remind webhook delivery failed");
    }
  }
}
