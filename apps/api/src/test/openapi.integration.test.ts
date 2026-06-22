import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { createTestApp } from "./setup";

describe("GET /openapi.json", () => {
  let app: INestApplication;
  beforeAll(async () => { app = await createTestApp(); }, 30000);
  afterAll(async () => { await app.close(); });

  it("is reachable without auth and returns a valid OpenAPI 3.0 doc", async () => {
    const res = await request(app.getHttpServer()).get("/openapi.json"); // no x-user-id
    expect(res.status).toBe(200);
    expect(String(res.body.openapi)).toMatch(/^3\.0\./);
    expect(res.body.paths["/v1/scopes"]).toBeDefined();
    expect(res.body.components.securitySchemes.apiKey.name).toBe("x-user-id");
  });
});
