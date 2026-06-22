import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { createTestApp } from "./setup";
import { clearDatabase } from "./helpers";

const USER = "retrieve-user";

describe("POST /memory/retrieve without query", () => {
  let app: INestApplication;
  beforeAll(async () => { app = await createTestApp(); }, 30000);
  beforeEach(async () => { await clearDatabase(); });
  afterAll(async () => { await app.close(); });

  it("accepts a request with no query and returns recent events", async () => {
    const scopeRes = await request(app.getHttpServer())
      .post("/scopes").set("x-user-id", USER).send({ name: "s" });
    const scopeId = scopeRes.body.id as string;

    await request(app.getHttpServer())
      .post("/memory/events").set("x-user-id", USER)
      .send({ scopeId, type: "stream", source: "api", content: "hello world" });

    const res = await request(app.getHttpServer())
      .post("/memory/retrieve").set("x-user-id", USER)
      .send({ scopeId, limit: 5 }); // no query

    expect(res.status).toBe(201);
    expect(Array.isArray(res.body.events)).toBe(true);
  });
});
