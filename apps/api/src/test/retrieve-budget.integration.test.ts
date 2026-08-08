import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { createTestApp } from "./setup";
import { clearDatabase } from "./helpers";

const USER = "retrieve-budget-user";

describe("POST /memory/retrieve with maxChars", () => {
  let app: INestApplication;
  beforeAll(async () => { app = await createTestApp(); }, 30000);
  beforeEach(async () => { await clearDatabase(); });
  afterAll(async () => { await app.close(); });

  async function seedScope(): Promise<string> {
    const scopeRes = await request(app.getHttpServer())
      .post("/scopes").set("x-user-id", USER).send({ name: "s" });
    expect(scopeRes.status).toBe(201);
    const scopeId = scopeRes.body.id as string;

    // Six events of 400 chars each: more than a 1000-char budget can hold, so
    // the packer has to refuse some and say so.
    for (let i = 0; i < 6; i += 1) {
      await request(app.getHttpServer())
        .post("/memory/events").set("x-user-id", USER)
        .send({ scopeId, type: "stream", source: "api", content: `event ${i} ${"x".repeat(390)}` });
    }
    return scopeId;
  }

  it("stays within the budget and reports what it dropped", async () => {
    const scopeId = await seedScope();
    const res = await request(app.getHttpServer())
      .post("/memory/retrieve").set("x-user-id", USER)
      .send({ scopeId, query: "event", limit: 10, maxChars: 1000 });

    expect(res.status).toBe(201);
    const budget = res.body.retrieval.budget;
    expect(budget).toBeDefined();
    expect(budget.maxChars).toBe(1000);
    expect(budget.usedChars).toBeLessThanOrEqual(1000);
    // Six events were offered; each returned or dropped event is accounted for.
    expect(res.body.events.length + budget.droppedCounts.event).toBe(6);
    expect(budget.droppedCounts.event).toBeGreaterThan(0);
  });

  it("omits the budget and returns everything when maxChars is absent", async () => {
    // The compatibility guarantee: a caller that never heard of this feature
    // must see exactly what it saw before the feature existed.
    const scopeId = await seedScope();
    const res = await request(app.getHttpServer())
      .post("/memory/retrieve").set("x-user-id", USER)
      .send({ scopeId, query: "event", limit: 10 });

    expect(res.status).toBe(201);
    expect(res.body.retrieval.budget).toBeUndefined();
    expect(res.body.events).toHaveLength(6);
  });

  it("rejects a non-positive maxChars rather than silently ignoring it", async () => {
    const scopeId = await seedScope();
    const res = await request(app.getHttpServer())
      .post("/memory/retrieve").set("x-user-id", USER)
      .send({ scopeId, query: "event", maxChars: 0 });

    expect(res.status).toBe(400);
  });

  it("applies limit and maxChars together, whichever binds first", async () => {
    // limit binds upstream, inside retrieve(); maxChars binds after. With a
    // budget large enough for everything, limit is what shows.
    const scopeId = await seedScope();
    const res = await request(app.getHttpServer())
      .post("/memory/retrieve").set("x-user-id", USER)
      .send({ scopeId, query: "event", limit: 2, maxChars: 1_000_000 });

    expect(res.status).toBe(201);
    expect(res.body.events).toHaveLength(2);
    expect(res.body.retrieval.budget.droppedCounts.event).toBe(0);
  });
});
