-- AlterTable
-- Records what the digest selection stage kept and what it discarded, so that
-- information loss is queryable rather than silent. NULL means the digest predates
-- this column, which is distinct from "this run discarded nothing" (an empty log).
ALTER TABLE "Digest"
ADD COLUMN "selectionLog" JSONB;
