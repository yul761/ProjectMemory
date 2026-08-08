import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { prisma } from "@statecore/db";
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

  // Seeds an active fact registry directly via prisma, bypassing the digest
  // pipeline (which needs a real LLM call and is impractical in this test
  // environment). A real Digest + DigestStateSnapshot row is still required
  // because getLatestDigestState reads the newest snapshot for the scope.
  async function seedFacts(scopeId: string): Promise<void> {
    const digest = await prisma.digest.create({
      data: { scopeId, summary: "s", changes: "c", nextSteps: [] }
    });
    await prisma.digestStateSnapshot.create({
      data: {
        scopeId,
        digestId: digest.id,
        state: {
          factRegistry: [
            {
              id: "f1",
              content: "Fact one",
              type: "decision",
              confidence: 0.9,
              addedAt: "2026-01-01T00:00:00.000Z",
              evidenceId: "e1",
              evidenceType: "event"
            },
            {
              id: "f2",
              content: "Fact two",
              type: "constraint",
              confidence: 0.8,
              addedAt: "2026-01-02T00:00:00.000Z",
              evidenceId: "e2",
              evidenceType: "event"
            }
          ]
        }
      }
    });
  }

  it("stays within the budget and reports what it dropped", async () => {
    const scopeId = await seedScope();
    const res = await request(app.getHttpServer())
      .post("/memory/retrieve").set("x-user-id", USER)
      .send({ scopeId, query: "event", limit: 10, maxChars: 1000 });

    expect(res.status).toBe(201);
    // `budget` lives at the top level, not inside `retrieval` — `retrieval` is
    // absent whenever there is no query, and a budget statement about the whole
    // response must not depend on a container that can legitimately not exist.
    const budget = res.body.budget;
    expect(budget).toBeDefined();
    expect(budget.maxChars).toBe(1000);
    expect(budget.usedChars).toBeLessThanOrEqual(1000);
    // Six events were offered; each returned or dropped event is accounted for.
    expect(res.body.events.length + budget.droppedCounts.event).toBe(6);
    expect(budget.droppedCounts.event).toBeGreaterThan(0);

    // retrieval.matches/returnedCount were computed before the budget dropped
    // anything; the budget path must recompute both from what actually survived
    // the pack, or a caller reconciling on returnedCount sees a number that
    // contradicts the events it was handed.
    const returnedIds = new Set(res.body.events.map((e: { id: string }) => e.id));
    for (const match of res.body.retrieval.matches) {
      expect(returnedIds.has(match.id)).toBe(true);
    }
    expect(res.body.retrieval.returnedCount).toBe(res.body.events.length);
  });

  it("packs a response when there is no query", async () => {
    // The no-query branch of retrieve() returns { digest, events } with no
    // `retrieval` key at all (RetrieveOutput.retrieval is optional and always
    // has been). Before this fix, the budget path spread `...result.retrieval`
    // — `undefined` — into an object that still claimed to carry `retrieval`'s
    // seven required fields, which parseOutput rejected as a 500. Nothing
    // exercised this path before even though it is contract-legal and
    // documented (RetrieveInput.query is optional).
    const scopeId = await seedScope();
    const res = await request(app.getHttpServer())
      .post("/memory/retrieve").set("x-user-id", USER)
      .send({ scopeId, maxChars: 1000 }); // no query

    expect(res.status).toBe(201);
    expect(res.body.retrieval).toBeUndefined();
    const budget = res.body.budget;
    expect(budget).toBeDefined();
    expect(budget.usedChars).toBeLessThanOrEqual(1000);
    expect(res.body.events.length + budget.droppedCounts.event).toBe(6);
  });

  it("omits the budget and returns everything when maxChars is absent", async () => {
    // The compatibility guarantee: a caller that never heard of this feature
    // must see exactly what it saw before the feature existed.
    const scopeId = await seedScope();
    await seedFacts(scopeId);

    const res = await request(app.getHttpServer())
      .post("/memory/retrieve").set("x-user-id", USER)
      .send({ scopeId, query: "event", limit: 10 });

    expect(res.status).toBe(201);
    expect(res.body.budget).toBeUndefined();
    expect(res.body.retrieval.budget).toBeUndefined();
    expect(res.body.events).toHaveLength(6);

    // The subtlest part of the compatibility promise: factRegistry order on
    // this path is unranked, exactly what getActiveFactRegistry returned, and
    // that is currently true only by construction — nothing asserted it. Two
    // identical calls must return facts in identical order.
    expect(res.body.factRegistry).toHaveLength(2);
    const secondRes = await request(app.getHttpServer())
      .post("/memory/retrieve").set("x-user-id", USER)
      .send({ scopeId, query: "event", limit: 10 });
    expect(secondRes.status).toBe(201);
    expect(secondRes.body.factRegistry.map((f: { id: string }) => f.id))
      .toEqual(res.body.factRegistry.map((f: { id: string }) => f.id));
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
    expect(res.body.budget.droppedCounts.event).toBe(0);
  });
});
