-- AlterTable
-- Caller-declared "must not lose a budget competition" flag. Defaults to false so
-- every existing row keeps today's behaviour; only events explicitly pinned by the
-- caller are prioritised when the digest char budget binds.
ALTER TABLE "MemoryEvent"
ADD COLUMN "pinned" BOOLEAN NOT NULL DEFAULT false;
