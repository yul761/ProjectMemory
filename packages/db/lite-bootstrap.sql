-- Generated from schema.lite.prisma via prisma migrate diff; regenerate when the lite schema changes.

-- CreateTable
CREATE TABLE IF NOT EXISTS "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "identity" TEXT NOT NULL,
    "telegramUserId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "facetPack" JSONB
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ProjectScope" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "goal" TEXT,
    "stage" TEXT NOT NULL DEFAULT 'idea',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "template" TEXT NOT NULL DEFAULT 'project',
    "notificationWebhook" TEXT,
    CONSTRAINT "ProjectScope_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "UserState" (
    "userId" TEXT NOT NULL PRIMARY KEY,
    "activeProjectId" TEXT,
    CONSTRAINT "UserState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "UserState_activeProjectId_fkey" FOREIGN KEY ("activeProjectId") REFERENCES "ProjectScope" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "MemoryEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'api',
    "key" TEXT,
    "content" TEXT NOT NULL,
    "contentHash" TEXT,
    "chatId" TEXT,
    "messageId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ingestedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME,
    "classifiedType" TEXT,
    "classifiedImportance" REAL,
    "expiresAt" DATETIME,
    "suppressedAt" DATETIME,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "MemoryEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "MemoryEvent_scopeId_fkey" FOREIGN KEY ("scopeId") REFERENCES "ProjectScope" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Digest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scopeId" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "changes" TEXT NOT NULL,
    "nextSteps" JSONB NOT NULL,
    "selectionLog" JSONB,
    "rebuildGroupId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Digest_scopeId_fkey" FOREIGN KEY ("scopeId") REFERENCES "ProjectScope" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "DigestStateSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scopeId" TEXT NOT NULL,
    "digestId" TEXT NOT NULL,
    "state" JSONB NOT NULL,
    "consistency" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DigestStateSnapshot_scopeId_fkey" FOREIGN KEY ("scopeId") REFERENCES "ProjectScope" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DigestStateSnapshot_digestId_fkey" FOREIGN KEY ("digestId") REFERENCES "Digest" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "WorkingMemorySnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scopeId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "state" JSONB NOT NULL,
    "view" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WorkingMemorySnapshot_scopeId_fkey" FOREIGN KEY ("scopeId") REFERENCES "ProjectScope" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Reminder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "scopeId" TEXT,
    "dueAt" DATETIME NOT NULL,
    "text" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Reminder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Reminder_scopeId_fkey" FOREIGN KEY ("scopeId") REFERENCES "ProjectScope" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ForgottenFact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "factKey" TEXT NOT NULL,
    "contentSnapshot" TEXT NOT NULL,
    "forgottenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
-- MCP-private: serializes digest runs across processes sharing one SQLite
-- file. Not part of the engine data model, so it carries no schema.lite.prisma
-- model — apps/mcp/src/digest-lock.ts reads and writes it with
-- $executeRawUnsafe/$queryRawUnsafe.
CREATE TABLE IF NOT EXISTS "DigestLock" (
    "scopeId" TEXT NOT NULL PRIMARY KEY,
    "acquiredAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "User_identity_key" ON "User"("identity");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "User_telegramUserId_key" ON "User"("telegramUserId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProjectScope_userId_idx" ON "ProjectScope"("userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MemoryEvent_userId_scopeId_createdAt_idx" ON "MemoryEvent"("userId", "scopeId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MemoryEvent_scopeId_key_idx" ON "MemoryEvent"("scopeId", "key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MemoryEvent_expiresAt_idx" ON "MemoryEvent"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "MemoryEvent_scopeId_key_key" ON "MemoryEvent"("scopeId", "key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Digest_scopeId_createdAt_idx" ON "Digest"("scopeId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Digest_scopeId_rebuildGroupId_idx" ON "Digest"("scopeId", "rebuildGroupId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "DigestStateSnapshot_digestId_key" ON "DigestStateSnapshot"("digestId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DigestStateSnapshot_scopeId_createdAt_idx" ON "DigestStateSnapshot"("scopeId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "WorkingMemorySnapshot_scopeId_key" ON "WorkingMemorySnapshot"("scopeId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorkingMemorySnapshot_scopeId_updatedAt_idx" ON "WorkingMemorySnapshot"("scopeId", "updatedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Reminder_userId_status_dueAt_idx" ON "Reminder"("userId", "status", "dueAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ForgottenFact_userId_scopeId_idx" ON "ForgottenFact"("userId", "scopeId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ForgottenFact_scopeId_factKey_key" ON "ForgottenFact"("scopeId", "factKey");

-- CreateTable
CREATE TABLE IF NOT EXISTS "MemoryEventToken" (
    "eventId" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "token" TEXT NOT NULL,

    PRIMARY KEY ("eventId", "token"),
    CONSTRAINT "MemoryEventToken_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "MemoryEvent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MemoryEventToken_scopeId_token_idx" ON "MemoryEventToken"("scopeId", "token");
