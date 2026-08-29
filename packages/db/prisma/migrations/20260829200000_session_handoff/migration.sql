-- CreateTable
CREATE TABLE "SessionHandoff" (
    "id" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersededBy" TEXT,
    "retiredAt" TIMESTAMP(3),
    "retiredReason" TEXT,

    CONSTRAINT "SessionHandoff_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SessionHandoff_scopeId_createdAt_idx" ON "SessionHandoff"("scopeId", "createdAt");

-- AddForeignKey
ALTER TABLE "SessionHandoff" ADD CONSTRAINT "SessionHandoff_scopeId_fkey" FOREIGN KEY ("scopeId") REFERENCES "ProjectScope"("id") ON DELETE CASCADE ON UPDATE CASCADE;
