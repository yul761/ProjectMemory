CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE "MemoryEventEmbedding" (
    "eventId"   TEXT         NOT NULL,
    "embedding" vector(1536) NOT NULL,
    "model"     TEXT         NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MemoryEventEmbedding_pkey" PRIMARY KEY ("eventId"),
    CONSTRAINT "MemoryEventEmbedding_eventId_fkey"
        FOREIGN KEY ("eventId")
        REFERENCES "MemoryEvent"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "MemoryEventEmbedding_eventId_idx" ON "MemoryEventEmbedding"("eventId");

-- Uncomment when MemoryEventEmbedding exceeds ~50k rows:
-- CREATE INDEX ON "MemoryEventEmbedding" USING hnsw (embedding vector_cosine_ops);
