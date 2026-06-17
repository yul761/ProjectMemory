import { prisma as defaultPrisma } from "@statecore/db";
import { getDomainConfig } from "@statecore/core";

export async function runClassifyEventJob(
  data: { eventId: string; scopeId: string },
  llm: { chat: (messages: { role: string; content: string }[]) => Promise<string> },
  db: typeof defaultPrisma = defaultPrisma
): Promise<void> {
  const [event, scope] = await Promise.all([
    db.memoryEvent.findUnique({ where: { id: data.eventId } }),
    db.projectScope.findUnique({ where: { id: data.scopeId } })
  ]);
  if (!event || !scope) return;

  const config = getDomainConfig((scope as any).template ?? "project");

  let entityType: string;
  let importance: number;
  try {
    const raw = await llm.chat([
      { role: "system", content: config.classificationSystemPrompt },
      { role: "user",   content: event.content }
    ]);
    const parsed = JSON.parse(raw) as { entityType?: string; importance?: number };
    entityType = parsed.entityType ?? "noise";
    importance = typeof parsed.importance === "number"
      ? Math.max(0, Math.min(1, parsed.importance))
      : 0.5;
  } catch {
    return;
  }

  const typeConfig = config.entityTypes.find((t) => t.name === entityType);
  const expireDays = typeConfig?.autoExpireAfterDays;
  const expiresAt = expireDays
    ? new Date(Date.now() + expireDays * 86_400_000)
    : null;

  await db.memoryEvent.update({
    where: { id: data.eventId },
    data: {
      classifiedType:       entityType,
      classifiedImportance: importance,
      ...(expiresAt ? { expiresAt } : {})
    }
  });
}
