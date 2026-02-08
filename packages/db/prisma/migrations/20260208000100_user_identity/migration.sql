-- Add identity to User and normalize telegramUserId storage
ALTER TABLE "User" ADD COLUMN "identity" TEXT;

-- Backfill identity from existing telegramUserId values
UPDATE "User"
SET "identity" = "telegramUserId"
WHERE "identity" IS NULL AND "telegramUserId" IS NOT NULL;

-- Normalize telegramUserId to raw telegram id (no prefix)
UPDATE "User"
SET "telegramUserId" = substring("identity" from length('telegram:') + 1)
WHERE "identity" LIKE 'telegram:%';

-- Clear telegramUserId for non-telegram identities
UPDATE "User"
SET "telegramUserId" = NULL
WHERE "identity" IS NOT NULL AND "identity" NOT LIKE 'telegram:%';

-- Ensure identity is always set (fallback for unexpected rows)
UPDATE "User"
SET "identity" = concat('legacy:', "id")
WHERE "identity" IS NULL;

ALTER TABLE "User" ALTER COLUMN "identity" SET NOT NULL;

-- Unique identity for all users
CREATE UNIQUE INDEX "User_identity_key" ON "User"("identity");
