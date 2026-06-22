-- HNSW index on the embedding vector for scalable approximate-nearest-neighbour
-- search. Uses vector_cosine_ops to match the `<=>` (cosine) query operator in
-- apps/api/src/vector-search.ts. Postgres only uses an HNSW index when the query
-- operator matches the index opclass.
CREATE INDEX IF NOT EXISTS "MemoryEventEmbedding_embedding_hnsw_idx"
  ON "MemoryEventEmbedding" USING hnsw (embedding vector_cosine_ops);
