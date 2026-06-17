import { prisma as defaultPrisma } from "@statecore/db";

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z一-鿿]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 3);
}

export function groupSimilarFeelings<T extends { id: string; content: string }>(events: T[]): T[][] {
  const groups: T[][] = [];
  for (const event of events) {
    const tokens = new Set(tokenize(event.content));
    const match = groups.find((g) =>
      g.some((e) => tokenize(e.content).filter((t) => tokens.has(t)).length >= 1)
    );
    if (match) {
      match.push(event);
    } else {
      groups.push([event]);
    }
  }
  return groups.filter((g) => g.length >= 3);
}

export async function runDetectEmotionalPatternsJob(
  llm: { chat: (messages: { role: string; content: string }[]) => Promise<string> },
  db: typeof defaultPrisma = defaultPrisma
): Promise<void> {
  const scopes = await (db as any).projectScope.findMany({
    where: { template: "personal" }
  });

  for (const scope of scopes) {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000);
    const feelingEvents = await db.memoryEvent.findMany({
      where: {
        scopeId: scope.id,
        classifiedType: "feeling",
        createdAt: { gte: thirtyDaysAgo }
      },
      orderBy: { createdAt: "asc" }
    });

    if (feelingEvents.length < 3) continue;

    const candidateGroups = groupSimilarFeelings(feelingEvents);
    if (!candidateGroups.length) continue;

    const feelingLines = feelingEvents
      .map((e) => `${e.createdAt.toISOString().slice(0, 10)}: ${e.content}`)
      .join("\n");

    let patterns: string[];
    try {
      const raw = await llm.chat([
        {
          role: "system",
          content: `Analyze these feeling events and identify recurring emotional patterns.
Only report patterns that appear 3 or more times.
Be specific about context: time of week, triggers, or situations if evident.
Keep each pattern to one concise sentence.
Examples: "tends to feel anxious on Sunday evenings", "energized and positive after exercise"
Return JSON: { "patterns": string[] }
If no clear patterns: return { "patterns": [] }`
        },
        { role: "user", content: feelingLines }
      ]);
      const parsed = JSON.parse(raw) as { patterns?: string[] };
      patterns = (parsed.patterns ?? [])
        .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
        .slice(0, 5);
    } catch {
      continue;
    }

    if (!patterns.length) continue;

    await db.memoryEvent.deleteMany({
      where: { scopeId: scope.id, classifiedType: "emotional_pattern" }
    });

    for (const pattern of patterns) {
      await db.memoryEvent.create({
        data: {
          userId: (scope as any).userId,
          scopeId: scope.id,
          type: "stream",
          source: "api",
          content: pattern,
          classifiedType: "emotional_pattern",
          classifiedImportance: 0.7
        } as any
      });
    }
  }
}
