export type RawQueryClient = {
  $queryRaw: <T = unknown>(query: TemplateStringsArray, ...values: unknown[]) => Promise<T>;
};

/**
 * Builds a vector-search closure that is ALWAYS scoped to a single scopeId.
 * The join to "MemoryEvent" plus the scopeId predicate ensures embeddings from
 * other tenants' scopes can never be returned.
 */
export function createVectorSearchFn(client: RawQueryClient) {
  return async (queryVector: number[], limit: number, scopeId: string): Promise<string[]> => {
    const vectorString = `[${queryVector.join(",")}]`;
    const rows = await client.$queryRaw<{ eventId: string }[]>`
      SELECT mee."eventId"
      FROM "MemoryEventEmbedding" mee
      JOIN "MemoryEvent" me ON me.id = mee."eventId"
      WHERE me."scopeId" = ${scopeId}
      ORDER BY mee.embedding <-> ${vectorString}::vector
      LIMIT ${limit}
    `;
    return rows.map((r) => r.eventId);
  };
}
