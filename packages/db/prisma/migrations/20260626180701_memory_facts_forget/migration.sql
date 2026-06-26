-- AlterTable: add soft-suppress column to MemoryEvent
ALTER TABLE "MemoryEvent" ADD COLUMN "suppressedAt" TIMESTAMP(3);

-- CreateTable: ForgottenFact
CREATE TABLE "ForgottenFact" (
    "id"              TEXT         NOT NULL,
    "userId"          TEXT         NOT NULL,
    "scopeId"         TEXT         NOT NULL,
    "factKey"         TEXT         NOT NULL,
    "contentSnapshot" TEXT         NOT NULL,
    "forgottenAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ForgottenFact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: compound unique used by forgottenFact.upsert (scopeId_factKey)
CREATE UNIQUE INDEX "ForgottenFact_scopeId_factKey_key" ON "ForgottenFact"("scopeId", "factKey");

-- CreateIndex: lookup by userId + scopeId
CREATE INDEX "ForgottenFact_userId_scopeId_idx" ON "ForgottenFact"("userId", "scopeId");
