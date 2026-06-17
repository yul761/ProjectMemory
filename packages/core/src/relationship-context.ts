import { getDomainConfig } from "./domain-configs/index";

export interface RelationshipContext {
  durationDays: number;
  personalDetails: string[];
  activeGoals: string[];
  currentFeeling: string | null;
  pendingFollowUps: string[];
  personaPrompt: string | null;
}

// Prisma client shape used only for typing the parameter — import is lazy to
// avoid bundling @statecore/db in environments that don't have it (e.g. tests).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PrismaClient = any;

export async function buildRelationshipContext(
  scopeId: string,
  db?: PrismaClient
): Promise<RelationshipContext> {
  if (!db) {
    // Lazy-load so the module can be imported without @statecore/db present
    const { prisma } = await import("@statecore/db");
    db = prisma;
  }
  const scope = await (db as any).projectScope.findUnique({ where: { id: scopeId } });
  const config = getDomainConfig((scope as any)?.template ?? "project");

  // 1. Duration: days since first event
  const firstEvent = await db.memoryEvent.findFirst({
    where: { scopeId },
    orderBy: { createdAt: "asc" }
  });
  const durationDays = firstEvent
    ? Math.floor((Date.now() - firstEvent.createdAt.getTime()) / 86_400_000)
    : 0;

  // 2. Personal details
  const personalDetailEvents = await db.memoryEvent.findMany({
    where: { scopeId, classifiedType: "personal_detail" },
    orderBy: { createdAt: "asc" }
  });
  const personalDetails = personalDetailEvents.map((e: any) => e.content);

  // 3. Active goals from latest digest state
  const latestSnapshot = await (db as any).digestStateSnapshot.findFirst({
    where: { scopeId },
    orderBy: { createdAt: "desc" }
  });
  const stableFacts = (latestSnapshot?.state as any)?.stableFacts;
  const activeGoals: string[] = [];
  if (stableFacts?.goal) activeGoals.push(stableFacts.goal);

  // 4. Current feeling (within 7 days)
  const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);
  const recentFeeling = await db.memoryEvent.findFirst({
    where: {
      scopeId,
      classifiedType: "feeling",
      createdAt: { gte: sevenDaysAgo }
    },
    orderBy: { createdAt: "desc" }
  });

  // 5. Pending follow-ups: commitments/experiences older than 7 days
  const oldEvents = await db.memoryEvent.findMany({
    where: {
      scopeId,
      classifiedType: { in: ["commitment", "experience"] },
      createdAt: { lt: sevenDaysAgo }
    },
    orderBy: { createdAt: "asc" },
    take: 3
  });
  const pendingFollowUps = oldEvents.map((e: any) => {
    const daysAgo = Math.floor((Date.now() - e.createdAt.getTime()) / 86_400_000);
    const preview = e.content.length > 60 ? `${e.content.slice(0, 60)}...` : e.content;
    return `${e.classifiedType}: "${preview}" (${daysAgo} days ago)`;
  });

  return {
    durationDays,
    personalDetails,
    activeGoals,
    currentFeeling: recentFeeling?.content ?? null,
    pendingFollowUps,
    personaPrompt: config.defaultPersonaPrompt ?? null
  };
}
