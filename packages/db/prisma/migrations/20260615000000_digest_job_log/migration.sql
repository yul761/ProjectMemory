CREATE TABLE "DigestJobLog" (
    "id"          TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "scopeId"     TEXT NOT NULL,
    "jobId"       TEXT,
    "status"      TEXT NOT NULL,
    "durationMs"  INTEGER,
    "error"       TEXT,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DigestJobLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DigestJobLog_scopeId_completedAt_idx" ON "DigestJobLog"("scopeId", "completedAt");
CREATE INDEX "DigestJobLog_status_idx" ON "DigestJobLog"("status");
