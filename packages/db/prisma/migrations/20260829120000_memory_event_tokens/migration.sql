-- CreateTable
CREATE TABLE "MemoryEventToken" (
    "eventId" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "token" TEXT NOT NULL,

    CONSTRAINT "MemoryEventToken_pkey" PRIMARY KEY ("eventId","token")
);

-- CreateIndex
CREATE INDEX "MemoryEventToken_scopeId_token_idx" ON "MemoryEventToken"("scopeId", "token");

-- AddForeignKey
ALTER TABLE "MemoryEventToken" ADD CONSTRAINT "MemoryEventToken_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "MemoryEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
