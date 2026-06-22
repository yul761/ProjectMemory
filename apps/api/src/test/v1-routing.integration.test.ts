import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { createTestApp } from "./setup";
import { clearDatabase } from "./helpers";

const USER = "v1-user";

describe("/v1 dual-mount routing", () => {
  let app: INestApplication;
  beforeAll(async () => { app = await createTestApp(); }, 30000);
  beforeEach(async () => { await clearDatabase(); });
  afterAll(async () => { await app.close(); });

  it("serves health at both /health and /v1/health without auth", async () => {
    const legacy = await request(app.getHttpServer()).get("/health");
    const v1 = await request(app.getHttpServer()).get("/v1/health");
    expect(legacy.status).toBe(200);
    expect(v1.status).toBe(200);
  });

  it("serves scope create + list under /v1", async () => {
    const created = await request(app.getHttpServer())
      .post("/v1/scopes").set("x-user-id", USER).send({ name: "v1-scope" });
    expect(created.status).toBe(201);

    const listed = await request(app.getHttpServer())
      .get("/v1/scopes").set("x-user-id", USER);
    expect(listed.status).toBe(200);
    expect(listed.body.items).toHaveLength(1);
  });

  it("serves the same scope to both legacy and /v1 paths", async () => {
    await request(app.getHttpServer())
      .post("/scopes").set("x-user-id", USER).send({ name: "shared" });
    const viaV1 = await request(app.getHttpServer())
      .get("/v1/scopes").set("x-user-id", USER);
    expect(viaV1.body.items).toHaveLength(1);
  });

  it("does NOT mount excluded internal endpoints under /v1", async () => {
    // working-state is internal; legacy path exists, /v1 path must 404.
    const v1 = await request(app.getHttpServer())
      .get("/v1/memory/working-state?scopeId=00000000-0000-0000-0000-000000000000")
      .set("x-user-id", USER);
    expect(v1.status).toBe(404);

    // check-contradiction and digest/rebuild are POST-only; POST (their real
    // method) to the /v1 path must 404 — a mistaken POST mount would 201/400.
    const checkContradiction = await request(app.getHttpServer())
      .post("/v1/memory/check-contradiction").set("x-user-id", USER).send({});
    expect(checkContradiction.status).toBe(404);

    const digestRebuild = await request(app.getHttpServer())
      .post("/v1/memory/digest/rebuild").set("x-user-id", USER).send({});
    expect(digestRebuild.status).toBe(404);
  });
});
