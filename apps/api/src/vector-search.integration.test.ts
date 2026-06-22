import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "@statecore/db";
import { createVectorSearchFn } from "./vector-search";
import { clearDatabase } from "./test/helpers";

// A 1536-dim vector with one "hot" dimension, so L2 distance is controlled by `hot`.
function vecLiteral(hot: number): string {
  const arr = new Array(1536).fill(0);
  arr[0] = hot;
  return `[${arr.join(",")}]`;
}
function queryVector(hot: number): number[] {
  const arr = new Array(1536).fill(0);
  arr[0] = hot;
  return arr;
}

async function seedScopeWithEmbedding(opts: {
  identity: string;
  scopeName: string;
  content: string;
  hot: number;
}): Promise<{ scopeId: string; eventId: string }> {
  const user = await prisma.user.create({ data: { identity: opts.identity } });
  const scope = await prisma.projectScope.create({ data: { userId: user.id, name: opts.scopeName } });
  const event = await prisma.memoryEvent.create({
    data: { userId: user.id, scopeId: scope.id, type: "stream", source: "api", content: opts.content }
  });
  await prisma.$executeRaw`
    INSERT INTO "MemoryEventEmbedding" ("eventId", "embedding", "model")
    VALUES (${event.id}, ${vecLiteral(opts.hot)}::vector, 'test-model')
  `;
  return { scopeId: scope.id, eventId: event.id };
}

describe("createVectorSearchFn — real pgvector tenant isolation", () => {
  beforeEach(async () => {
    await clearDatabase();
  });
  afterAll(async () => {
    await clearDatabase();
  });

  it("never returns another scope's event, even when it is the nearest neighbor", async () => {
    // Scope A's event is far from the query; Scope B's event sits exactly on the
    // query vector (distance 0) — so without scope filtering B would rank first.
    const a = await seedScopeWithEmbedding({ identity: "user-a", scopeName: "a", content: "alpha", hot: 1 });
    const b = await seedScopeWithEmbedding({ identity: "user-b", scopeName: "b", content: "beta", hot: 10 });

    const fn = createVectorSearchFn(prisma);
    const query = queryVector(10); // identical to B's embedding → B is the nearest neighbor

    const idsForA = await fn(query, 10, a.scopeId);
    expect(idsForA).toContain(a.eventId);
    expect(idsForA).not.toContain(b.eventId); // isolation holds despite B being nearest

    const idsForB = await fn(query, 10, b.scopeId);
    expect(idsForB).toContain(b.eventId);
    expect(idsForB).not.toContain(a.eventId);
  });
});
