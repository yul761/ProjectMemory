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

    const scope = await prisma.projectScope.findUnique({ where: { id: scopeId } });
    expect(scope).toBeNull();
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
