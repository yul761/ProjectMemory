import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { prisma } from "@statecore/db";
import { DigestSelectionOutput, FacetPackOutput, FactProvenanceOutput } from "@statecore/contracts";
import { createTestApp } from "./setup";
import { clearDatabase } from "./helpers";

const USER = "audit-reader-user";

// The three audit readers are frozen, and `PublicV1Contracts` is a claim about
// what they return. Nothing enforced that claim: unlike the endpoints that run
// their output through `parseOutput`, these three return plain objects, so the
// registry could describe a response the handler never produced and both the
// snapshot guard and the OpenAPI document would agree with it.
//
// Each test here parses a real response with the frozen schema.
describe("frozen /v1 audit readers answer with the shape the contract promises", () => {
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

  async function createScope(name: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post("/v1/scopes")
      .set("x-user-id", USER)
      .send({ name });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  /** A digest whose state carries a two-version fact chain, plus a selection log. */
  async function seedDigest(scopeId: string) {
    const digest = await prisma.digest.create({
      data: {
        scopeId,
        summary: "summary",
        changes: "changes",
        nextSteps: [],
        selectionLog: {
          rationale: ["kept 2 documents", "dropped 1 fact at capacity"],
          drops: [{ reason: "cap_evicted", detail: { facet: "followUps", cap: 10 } }]
        }
      }
    });
    await prisma.digestStateSnapshot.create({
      data: {
        scopeId,
        digestId: digest.id,
        state: {
          factRegistry: [
            {
              id: "fact-v1",
              content: "works at Acme",
              type: "profile",
              confidence: 0.85,
              addedAt: "2026-08-01T00:00:00.000Z",
              evidenceId: "evidence-1",
              evidenceType: "document",
              facet: "identity",
              supersededBy: "fact-v2"
            },
            {
              id: "fact-v2",
              content: "works at Beta",
              type: "profile",
              confidence: 0.85,
              addedAt: "2026-08-05T00:00:00.000Z",
              evidenceId: "evidence-2",
              evidenceType: "document",
              facet: "identity"
            }
          ]
        }
      }
    });
    return digest.id;
  }

  it("GET /v1/facet-pack answers for the account with no scopeId", async () => {
    const res = await request(app.getHttpServer())
      .get("/v1/facet-pack")
      .set("x-user-id", USER);

    expect(res.status).toBe(200);
    const pack = FacetPackOutput.parse(res.body);
    expect(pack.facets.length).toBeGreaterThan(0);
    // No scope named, so no template can have decided it.
    expect(pack.template).toBeNull();
    expect(pack.source).toBe("deployment-default");
  });

  it("GET /v1/facet-pack answers per scope when one is named", async () => {
    const scopeId = await createScope("packed");
    const res = await request(app.getHttpServer())
      .get(`/v1/facet-pack?scopeId=${scopeId}`)
      .set("x-user-id", USER);

    expect(res.status).toBe(200);
    expect(() => FacetPackOutput.parse(res.body)).not.toThrow();
  });

  it("GET /v1/memory/facts/:factId/provenance returns the chain from any version in it", async () => {
    const scopeId = await createScope("provenanced");
    await seedDigest(scopeId);

    // The older version, to prove the walk goes backwards as well as forwards.
    const res = await request(app.getHttpServer())
      .get(`/v1/memory/facts/fact-v1/provenance?scopeId=${scopeId}`)
      .set("x-user-id", USER);

    expect(res.status).toBe(200);
    const provenance = FactProvenanceOutput.parse(res.body);
    expect(provenance.fact.id).toBe("fact-v1");
    expect(provenance.chain.map((entry) => entry.id)).toEqual(["fact-v1", "fact-v2"]);
    expect(provenance.fact.evidenceId).toBe("evidence-1");
  });

  it("GET /v1/memory/digests/:digestId/selection returns what the digest kept and dropped", async () => {
    const scopeId = await createScope("selected");
    const digestId = await seedDigest(scopeId);

    const res = await request(app.getHttpServer())
      .get(`/v1/memory/digests/${digestId}/selection`)
      .set("x-user-id", USER);

    expect(res.status).toBe(200);
    const selection = DigestSelectionOutput.parse(res.body);
    expect(selection.rationale).toHaveLength(2);
    expect(selection.drops).toHaveLength(1);
  });

  it("keeps all three readable at their legacy unversioned paths", async () => {
    const scopeId = await createScope("dual-mounted");
    const digestId = await seedDigest(scopeId);

    for (const path of [
      "/facet-pack",
      `/memory/facts/fact-v1/provenance?scopeId=${scopeId}`,
      `/memory/digests/${digestId}/selection`
    ]) {
      const res = await request(app.getHttpServer()).get(path).set("x-user-id", USER);
      expect(res.status, path).toBe(200);
    }
  });

  it("does not serve another user's digest selection", async () => {
    const scopeId = await createScope("private");
    const digestId = await seedDigest(scopeId);

    const res = await request(app.getHttpServer())
      .get(`/v1/memory/digests/${digestId}/selection`)
      .set("x-user-id", "somebody-else");

    expect(res.status).toBe(404);
  });
});
