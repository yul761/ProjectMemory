import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { createTestApp } from "./setup";
import { clearDatabase } from "./helpers";

const USER_A = "user-a";
const USER_B = "user-b";

describe("Multi-tenant isolation", () => {
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
      .post("/scopes")
      .set("x-user-id", user)
      .send({ name });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  it("user B cannot list user A's scopes", async () => {
    await createScopeAs(USER_A, "a-scope");
    const res = await request(app.getHttpServer()).get("/scopes").set("x-user-id", USER_B);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(0);
  });

  it("user B cannot read user A's memory events", async () => {
    const scopeId = await createScopeAs(USER_A, "a-scope");
    const res = await request(app.getHttpServer())
      .get(`/memory/events?scopeId=${scopeId}`)
      .set("x-user-id", USER_B);
    expect(res.status).toBe(404);
  });

  it("user B cannot retrieve from user A's scope", async () => {
    const scopeId = await createScopeAs(USER_A, "a-scope");
    const res = await request(app.getHttpServer())
      .post("/memory/retrieve")
      .set("x-user-id", USER_B)
      .send({ scopeId, query: "anything", limit: 5 });
    expect(res.status).toBe(404);
  });

  it("user B cannot set a webhook on user A's scope", async () => {
    const scopeId = await createScopeAs(USER_A, "a-scope");
    const res = await request(app.getHttpServer())
      .patch(`/scopes/${scopeId}/webhook`)
      .set("x-user-id", USER_B)
      .send({ notificationWebhook: "https://evil.example.com/hook" });
    expect(res.status).toBe(404);
  });

  it("user B cannot backfill embeddings on user A's scope", async () => {
    const scopeId = await createScopeAs(USER_A, "a-scope");
    const res = await request(app.getHttpServer())
      .post("/memory/embed/backfill")
      .set("x-user-id", USER_B)
      .send({ scopeId });
    expect(res.status).toBe(404);
  });
});
