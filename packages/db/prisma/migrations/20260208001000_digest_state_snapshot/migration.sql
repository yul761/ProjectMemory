-- CreateTable
CREATE TABLE "DigestStateSnapshot" (
    "id" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "digestId" TEXT NOT NULL,
    "state" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DigestStateSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DigestStateSnapshot_digestId_key" ON "DigestStateSnapshot"("digestId");

-- CreateIndex
CREATE INDEX "DigestStateSnapshot_scopeId_createdAt_idx" ON "DigestStateSnapshot"("scopeId", "createdAt");

-- AddForeignKey
ALTER TABLE "DigestStateSnapshot" ADD CONSTRAINT "DigestStateSnapshot_scopeId_fkey" FOREIGN KEY ("scopeId") REFERENCES "ProjectScope"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DigestStateSnapshot" ADD CONSTRAINT "DigestStateSnapshot_digestId_fkey" FOREIGN KEY ("digestId") REFERENCES "Digest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
