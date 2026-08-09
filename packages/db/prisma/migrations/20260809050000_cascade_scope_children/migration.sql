-- Let the database, not the handler's statement order, remove a scope's children.
--
-- DELETE /v1/scopes/:id deleted children then deleted the scope. A digest job that
-- landed between those two statements re-created a Digest row, and the final delete
-- died on Digest_scopeId_fkey. assistant-backend swallows that failure by design
-- (best-effort, never blocks account deletion), so the account went away while the
-- memory stayed behind as an orphan scope nobody knew about — a silent privacy
-- failure, on the path whose whole job is erasing someone.
--
-- No statement order can win a race against a concurrent writer. Only the FK can.
--
-- Cascade for rows that belong to the scope; SET NULL for UserState, which belongs
-- to the user and must outlive any one scope. DigestJobLog and ForgottenFact carry a
-- scopeId but declare no relation, so they hold no constraint and are still cleaned
-- up explicitly by the handler.

-- MemoryEvent -> ProjectScope
ALTER TABLE "MemoryEvent" DROP CONSTRAINT "MemoryEvent_scopeId_fkey";
ALTER TABLE "MemoryEvent" ADD CONSTRAINT "MemoryEvent_scopeId_fkey"
  FOREIGN KEY ("scopeId") REFERENCES "ProjectScope"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Digest -> ProjectScope
ALTER TABLE "Digest" DROP CONSTRAINT "Digest_scopeId_fkey";
ALTER TABLE "Digest" ADD CONSTRAINT "Digest_scopeId_fkey"
  FOREIGN KEY ("scopeId") REFERENCES "ProjectScope"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- DigestStateSnapshot -> ProjectScope
ALTER TABLE "DigestStateSnapshot" DROP CONSTRAINT "DigestStateSnapshot_scopeId_fkey";
ALTER TABLE "DigestStateSnapshot" ADD CONSTRAINT "DigestStateSnapshot_scopeId_fkey"
  FOREIGN KEY ("scopeId") REFERENCES "ProjectScope"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- DigestStateSnapshot -> Digest. Without this, cascading a Digest away would strand
-- its snapshot and fail on Digest's own delete.
ALTER TABLE "DigestStateSnapshot" DROP CONSTRAINT "DigestStateSnapshot_digestId_fkey";
ALTER TABLE "DigestStateSnapshot" ADD CONSTRAINT "DigestStateSnapshot_digestId_fkey"
  FOREIGN KEY ("digestId") REFERENCES "Digest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- WorkingMemorySnapshot -> ProjectScope
ALTER TABLE "WorkingMemorySnapshot" DROP CONSTRAINT "WorkingMemorySnapshot_scopeId_fkey";
ALTER TABLE "WorkingMemorySnapshot" ADD CONSTRAINT "WorkingMemorySnapshot_scopeId_fkey"
  FOREIGN KEY ("scopeId") REFERENCES "ProjectScope"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Reminder -> ProjectScope. scopeId is nullable, but a reminder that had a scope
-- belongs to it; the handler already deleted these.
ALTER TABLE "Reminder" DROP CONSTRAINT "Reminder_scopeId_fkey";
ALTER TABLE "Reminder" ADD CONSTRAINT "Reminder_scopeId_fkey"
  FOREIGN KEY ("scopeId") REFERENCES "ProjectScope"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- UserState -> ProjectScope. The pointer dies, the user's state does not. This is
-- what the handler's `updateMany(activeProjectId: null)` was doing by hand.
ALTER TABLE "UserState" DROP CONSTRAINT "UserState_activeProjectId_fkey";
ALTER TABLE "UserState" ADD CONSTRAINT "UserState_activeProjectId_fkey"
  FOREIGN KEY ("activeProjectId") REFERENCES "ProjectScope"("id") ON DELETE SET NULL ON UPDATE CASCADE;
