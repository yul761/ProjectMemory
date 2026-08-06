-- AlterTable
-- "When we learned it", kept separate from createdAt, which ingest overwrites with
-- occurredAt when the caller backdates an event. Existing rows were never
-- backdated by anything in production, so seeding from createdAt is accurate for
-- them and keeps the digest window behaving exactly as before.
ALTER TABLE "MemoryEvent"
ADD COLUMN "ingestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "MemoryEvent" SET "ingestedAt" = "createdAt";

-- The digest window now filters on either clock.
CREATE INDEX IF NOT EXISTS "MemoryEvent_scopeId_ingestedAt_idx"
  ON "MemoryEvent" ("scopeId", "ingestedAt");
