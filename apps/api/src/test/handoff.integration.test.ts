import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { createTestApp } from "./setup";
import { clearDatabase } from "./helpers";

const USER = "handoff-user";

describe("POST /v1/memory/handoff", () => {
  let app: INestApplication;
  beforeAll(async () => { app = await createTestApp(); }, 30000);
  beforeEach(async () => { await clearDatabase(); });
  afterAll(async () => { await app.close(); });

  async function seedScope(): Promise<string> {
    const scopeRes = await request(app.getHttpServer())
      .post("/scopes").set("x-user-id", USER).send({ name: "s" });
    expect(scopeRes.status).toBe(201);
    return scopeRes.body.id as string;
  }

  it("set → retrieve returns the handoff; a second set supersedes the first", async () => {
    const scopeId = await seedScope();

    const first = await request(app.getHttpServer())
      .post("/v1/memory/handoff").set("x-user-id", USER)
      .send({ scopeId, summary: "stopped mid-migration", nextSteps: ["wire the controller"] });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ ok: true, superseded: false });
    expect(first.body.handoffId).toBeTruthy();

    const afterFirst = await request(app.getHttpServer())
      .post("/v1/memory/retrieve").set("x-user-id", USER)
      .send({ scopeId, query: "migration" });
    expect(afterFirst.status).toBe(201);
    expect(afterFirst.body.handoff?.content).toContain("stopped mid-migration");
    expect(afterFirst.body.handoff?.content).toContain("wire the controller");

    const second = await request(app.getHttpServer())
      .post("/v1/memory/handoff").set("x-user-id", USER)
      .send({ scopeId, summary: "controller wired, tests failing", openQuestions: ["flaky or real?"] });
    expect(second.status).toBe(201);
    expect(second.body).toMatchObject({ ok: true, superseded: true });

    const afterSecond = await request(app.getHttpServer())
      .post("/v1/memory/retrieve").set("x-user-id", USER)
      .send({ scopeId, query: "controller" });
    expect(afterSecond.body.handoff?.content).toContain("tests failing");
    expect(afterSecond.body.handoff?.versionCount).toBe(2);
  });

  it("rejects an empty summary and a foreign scope", async () => {
    const scopeId = await seedScope();

    const empty = await request(app.getHttpServer())
      .post("/v1/memory/handoff").set("x-user-id", USER)
      .send({ scopeId, summary: "   " });
    expect(empty.status).toBeGreaterThanOrEqual(400);

    const foreign = await request(app.getHttpServer())
      .post("/v1/memory/handoff").set("x-user-id", "someone-else")
      .send({ scopeId, summary: "not my scope" });
    expect(foreign.status).toBe(404);
  });

  it("retrieve reports no handoff when none was ever set", async () => {
    const scopeId = await seedScope();
    const res = await request(app.getHttpServer())
      .post("/v1/memory/retrieve").set("x-user-id", USER)
      .send({ scopeId, query: "anything" });
    expect(res.status).toBe(201);
    expect(res.body.handoff ?? null).toBeNull();
  });
});
