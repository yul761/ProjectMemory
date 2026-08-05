import { prisma as defaultPrisma } from "@statecore/db";
import {
  getDomainConfig,
  getDefaultFacetPack,
  packClassificationTypes,
  resolveFacetPack,
  type FacetPack
} from "@statecore/core";
import { buildPackClassificationSystemPrompt } from "@statecore/prompts";

export async function runClassifyEventJob(
  data: { eventId: string; scopeId: string },
  llm: { chat: (messages: { role: "system" | "user"; content: string }[]) => Promise<string> },
  db: typeof defaultPrisma = defaultPrisma
): Promise<void> {
  const [event, scope] = await Promise.all([
    db.memoryEvent.findUnique({ where: { id: data.eventId } }),
    db.projectScope.findUnique({ where: { id: data.scopeId } })
  ]);
  if (!event || !scope) return;

  const config = getDomainConfig((scope as any).template ?? "project");

  // A tenant running its own pack has no hand-written DomainConfig prompt, and the
  // built-in ones name a vocabulary its facets do not route from. Derive the
  // classifier's types from the pack instead, so what the classifier emits is what
  // the engine can actually route. Tenants on the default pack are unaffected.
  const pack: FacetPack = await resolveFacetPack(
    {
      findFacetPack: async (userId: string) => {
        const row = await db.user.findUnique({ where: { id: userId }, select: { facetPack: true } });
        return row?.facetPack ?? null;
      }
    },
    (scope as any).userId as string
  );
  const packTypes = packClassificationTypes(pack);
  const usePackTypes = pack.name !== getDefaultFacetPack().name && packTypes.length > 0;
  const systemPrompt = usePackTypes
    ? buildPackClassificationSystemPrompt(packTypes)
    : config.classificationSystemPrompt;

  let entityType: string;
  let importance: number;
  try {
    const raw = await llm.chat([
      { role: "system", content: systemPrompt },
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

  // Pack-declared types carry no retention policy of their own; they simply do not
  // auto-expire, which is the safe default for a tenant we know nothing about.
  const typeConfig = usePackTypes ? undefined : config.entityTypes.find((t) => t.name === entityType);
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
