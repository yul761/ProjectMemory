import { prisma as defaultPrisma } from "@statecore/db";
import type { EmbeddingModel } from "@statecore/core";

export async function runEmbedEventJob(
  data: { eventId: string; scopeId: string },
  embeddingModel: EmbeddingModel | null | undefined,
  db: typeof defaultPrisma = defaultPrisma,
  modelName: string
): Promise<void> {
  if (!embeddingModel) return;

  const event = await db.memoryEvent.findUnique({ where: { id: data.eventId } });
  if (!event) return;

  const vectors = await embeddingModel.embed([event.content]);
  const vector = vectors[0];
  if (!vector?.length) throw new Error(`Embedding returned empty vector for event ${data.eventId}`);

  const vectorString = `[${vector.join(",")}]`;
  await db.$executeRaw`
    INSERT INTO "MemoryEventEmbedding" ("eventId", "embedding", "model")
    VALUES (${data.eventId}, ${vectorString}::vector, ${modelName})
    ON CONFLICT ("eventId") DO UPDATE
      SET "embedding" = EXCLUDED."embedding",
          "model"     = EXCLUDED."model",
          "createdAt" = CURRENT_TIMESTAMP
  `;
}
