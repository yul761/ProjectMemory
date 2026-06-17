ALTER TABLE "ProjectScope"
  ADD COLUMN "template"            TEXT NOT NULL DEFAULT 'project',
  ADD COLUMN "notificationWebhook" TEXT;

ALTER TABLE "MemoryEvent"
  ADD COLUMN "classifiedType"       TEXT,
  ADD COLUMN "classifiedImportance" DOUBLE PRECISION,
  ADD COLUMN "expiresAt"            TIMESTAMP(3);

CREATE INDEX "MemoryEvent_expiresAt_idx"
  ON "MemoryEvent"("expiresAt")
  WHERE "expiresAt" IS NOT NULL;
