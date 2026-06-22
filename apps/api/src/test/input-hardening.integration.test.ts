import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { createTestApp } from "./setup";

describe("input hardening", () => {
  let app: INestApplication;
  beforeAll(async () => { app = await createTestApp({ maxBodyBytes: 1024 }); }, 30000);
  afterAll(async () => { await app.close(); });

  it("rejects an oversized JSON body with 413", async () => {
    const big = { scopeId: "x".repeat(2000) };
    const res = await request(app.getHttpServer())
      .post("/memory/events")
      .set("x-user-id", "local-dev-user")
      .send(big);
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: "Request body too large" });
  });

  it("rejects a malformed JSON body with 400", async () => {
    const res = await request(app.getHttpServer())
      .post("/memory/events")
      .set("x-user-id", "local-dev-user")
      .set("content-type", "application/json")
      .send('{ "scopeId": ');  // malformed JSON string
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Malformed JSON body" });
  });
});
