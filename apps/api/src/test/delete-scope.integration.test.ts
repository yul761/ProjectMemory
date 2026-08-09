import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { prisma } from "@statecore/db";
import { createTestApp } from "./setup";
import { clearDatabase } from "./helpers";

const USER_A = "user-a";
const USER_B = "user-b";

describe("DELETE /v1/scopes/:id", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  }, 30000);

  beforeEach(async () => {
    await clearDatabase();
  });

  afterAll(async () => {
    await app.close();
  });

  async function createScopeAs(user: string, name: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post("/v1/scopes")
      .set("x-user-id", user)
      .send({ name });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  it("USER_A can delete their own scope and all related data is removed", async () => {
    const scopeId = await createScopeAs(USER_A, "to-be-deleted");

    // Write a memory event to the scope
    const eventRes = await request(app.getHttpServer())
      .post("/v1/memory/events")
      .set("x-user-id", USER_A)
      .send({ scopeId, type: "stream", source: "api", content: "x" });
    expect(eventRes.status).toBe(201);

    // Seed a ForgottenFact row directly via prisma
    await prisma.forgottenFact.create({
      data: {
        userId: USER_A,
        scopeId,
        factKey: "fk",
        contentSnapshot: "x"
      }
    });

    // Seed a Digest + DigestStateSnapshot to exercise the FK-ordering cascade
    // (DigestStateSnapshot.digestId → Digest.id, no cascade, so handler must delete
    //  DigestStateSnapshot BEFORE Digest; swapping that order would break the real DB)
    const digest = await prisma.digest.create({
      data: {
        scopeId,
        summary: "test summary",
        changes: "test changes",
        nextSteps: []
      }
    });
    await prisma.digestStateSnapshot.create({
      data: {
        scopeId,
        digestId: digest.id,
        state: {}
      }
    });

    // DELETE the scope
    const deleteRes = await request(app.getHttpServer())
      .delete(`/v1/scopes/${scopeId}`)
      .set("x-user-id", USER_A);

    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body).toEqual({ ok: true });

    // Assert all related data is gone
    const memoryEventCount = await prisma.memoryEvent.count({ where: { scopeId } });
    expect(memoryEventCount).toBe(0);

    const forgottenFactCount = await prisma.forgottenFact.count({ where: { scopeId } });
    expect(forgottenFactCount).toBe(0);

    const digestCount = await prisma.digest.count({ where: { scopeId } });
    expect(digestCount).toBe(0);

    const digestStateSnapshotCount = await prisma.digestStateSnapshot.count({ where: { scopeId } });
    expect(digestStateSnapshotCount).toBe(0);

    const scope = await prisma.projectScope.findUnique({ where: { id: scopeId } });
    expect(scope).toBeNull();
  });

  // The handler deletes children then deletes the scope. A digest job that lands
  // between those two statements re-creates a Digest row, and the final delete
  // dies on Digest_scopeId_fkey. Remi swallows that failure
  // (`deleteScopeById(...).catch(() => undefined)` — best-effort, never blocks
  // account deletion), so the user's account disappears while their memory stays
  // behind as an orphan scope nobody knows about. A privacy failure, and a silent
  // one.
  //
  // Deleting the scope directly, with children still present, is that race
  // reduced to something deterministic: it asks whether the database enforces the
  // invariant, or whether the handler's statement order is the only thing holding
  // it up. Only the database can win a race against a concurrent writer.
  it("the database, not the handler's statement order, removes a scope's children", async () => {
    const scopeId = await createScopeAs(USER_A, "raced-delete");

    await request(app.getHttpServer())
      .post("/v1/memory/events")
      .set("x-user-id", USER_A)
      .send({ scopeId, type: "stream", source: "api", content: "x" });

    const digest = await prisma.digest.create({
      data: { scopeId, summary: "s", changes: "c", nextSteps: [] }
    });
    await prisma.digestStateSnapshot.create({
      data: { scopeId, digestId: digest.id, state: {} }
    });
    await prisma.workingMemorySnapshot.create({
      data: { scopeId, state: {}, view: {} }
    });
    // `USER_A` is the x-user-id header, i.e. User.identity; the FK wants User.id,
    // which the auth middleware generated on upsert.
    const { userId } = await prisma.projectScope.findUniqueOrThrow({
      where: { id: scopeId },
      select: { userId: true }
    });
    await prisma.reminder.create({
      data: { userId, scopeId, dueAt: new Date("2030-01-01"), text: "r" }
    });
    // Creating a scope already points UserState at it, so upsert rather than create.
    await prisma.userState.upsert({
      where: { userId },
      update: { activeProjectId: scopeId },
      create: { userId, activeProjectId: scopeId }
    });

    // No manual cleanup — exactly what the handler is left holding when a writer
    // repopulates a table it already emptied.
    await prisma.projectScope.delete({ where: { id: scopeId } });

    expect(await prisma.digest.count({ where: { scopeId } })).toBe(0);
    expect(await prisma.digestStateSnapshot.count({ where: { scopeId } })).toBe(0);
    expect(await prisma.memoryEvent.count({ where: { scopeId } })).toBe(0);
    expect(await prisma.workingMemorySnapshot.count({ where: { scopeId } })).toBe(0);
    expect(await prisma.reminder.count({ where: { scopeId } })).toBe(0);

    // The user outlives their scope: cascading here would delete a row that
    // belongs to the user, not to the scope. It must be nulled instead.
    const userState = await prisma.userState.findUnique({ where: { userId } });
    expect(userState).not.toBeNull();
    expect(userState?.activeProjectId).toBeNull();
  });

  it("USER_B cannot delete USER_A's scope — returns 404, scope still exists", async () => {
    const scopeId = await createScopeAs(USER_A, "protected-scope");

    const deleteRes = await request(app.getHttpServer())
      .delete(`/v1/scopes/${scopeId}`)
      .set("x-user-id", USER_B);

    expect(deleteRes.status).toBe(404);

    // Scope still exists
    const scope = await prisma.projectScope.findUnique({ where: { id: scopeId } });
    expect(scope).not.toBeNull();
  });

  it("deleting a non-existent scope returns 404", async () => {
    const res = await request(app.getHttpServer())
      .delete("/v1/scopes/nonexistent-scope-id-xyz")
      .set("x-user-id", USER_A);

    expect(res.status).toBe(404);
  });
});
