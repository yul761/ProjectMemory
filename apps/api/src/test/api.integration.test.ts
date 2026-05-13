import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { createTestApp } from "./setup";
import { clearDatabase } from "./helpers";

const TEST_USER = "test-user";

describe("API Integration Tests", () => {
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

  describe("Scope management", () => {
    it("POST /scopes creates a scope and returns it", async () => {
      const res = await request(app.getHttpServer())
        .post("/scopes")
        .set("x-user-id", TEST_USER)
        .send({ name: "test-scope" });

      expect(res.status).toBe(201);
      expect(res.body.name).toBe("test-scope");
      expect(typeof res.body.id).toBe("string");
    });

    it("GET /scopes returns created scopes", async () => {
      await request(app.getHttpServer())
        .post("/scopes")
        .set("x-user-id", TEST_USER)
        .send({ name: "scope-a" });

      const res = await request(app.getHttpServer())
        .get("/scopes")
        .set("x-user-id", TEST_USER);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.items)).toBe(true);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].name).toBe("scope-a");
    });

    it("POST /scopes/:id/active sets the active scope", async () => {
      const createRes = await request(app.getHttpServer())
        .post("/scopes")
        .set("x-user-id", TEST_USER)
        .send({ name: "active-scope" });

      const scopeId = createRes.body.id;

      const res = await request(app.getHttpServer())
        .post(`/scopes/${scopeId}/active`)
        .set("x-user-id", TEST_USER);

      expect(res.status).toBe(201);
      expect(res.body.activeScopeId).toBe(scopeId);
    });
  });

  describe("Memory events", () => {
    it("POST /memory/events ingests a stream event", async () => {
      const scopeRes = await request(app.getHttpServer())
        .post("/scopes")
        .set("x-user-id", TEST_USER)
        .send({ name: "event-scope" });

      const scopeId = scopeRes.body.id;

      const res = await request(app.getHttpServer())
        .post("/memory/events")
        .set("x-user-id", TEST_USER)
        .send({ scopeId, type: "stream", content: "User decided to use TypeScript" });

      expect(res.status).toBe(201);
      expect(res.body.scopeId).toBe(scopeId);
      expect(res.body.type).toBe("stream");
      expect(res.body.content).toBe("User decided to use TypeScript");
      expect(typeof res.body.id).toBe("string");
    });
  });

  describe("Fast view", () => {
    it("GET /memory/fast-view returns context for a scope", async () => {
      const scopeRes = await request(app.getHttpServer())
        .post("/scopes")
        .set("x-user-id", TEST_USER)
        .send({ name: "fastview-scope" });

      const scopeId = scopeRes.body.id;

      const res = await request(app.getHttpServer())
        .get(`/memory/fast-view?scopeId=${scopeId}`)
        .set("x-user-id", TEST_USER);

      expect(res.status).toBe(200);
      expect(res.body.scopeId).toBe(scopeId);
      expect(typeof res.body.fastLayerContext).toBe("object");
      expect(typeof res.body.fastLayerContext.summary).toBe("string");
    });

    it("GET /memory/fast-view without scopeId returns 400", async () => {
      const res = await request(app.getHttpServer())
        .get("/memory/fast-view")
        .set("x-user-id", TEST_USER);

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "scopeId required" });
    });
  });
});
