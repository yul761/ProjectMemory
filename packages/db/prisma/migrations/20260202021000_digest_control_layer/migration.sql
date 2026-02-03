-- AlterTable
ALTER TABLE "Digest" ADD COLUMN "rebuildGroupId" TEXT;

-- CreateIndex
CREATE INDEX "Digest_scopeId_rebuildGroupId_idx" ON "Digest"("scopeId", "rebuildGroupId");
