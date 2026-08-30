import { describe, it, expect, vi } from "vitest";
import { authorize, handleAdd, handleSearch, type CoreClient } from "./server";

const KEY = "aml_secret_1";

function fakeCore(overrides: Partial<CoreClient> = {}): CoreClient {
  return {
    findScope: vi.fn(async () => null),
    createScope: vi.fn(async () => "scope-1"),
    ingest: vi.fn(async () => undefined),
    enqueueDigest: vi.fn(async () => undefined),
    retrieve: vi.fn(async () => ({ digest: null, factRegistry: [], events: [] })),
    ...overrides
  };
}

describe("authorize", () => {
  it("accepts Bearer, Token, and X-Api-Key forms", () => {
    expect(authorize({ authorization: `Bearer ${KEY}` }, KEY)).toBe(true);
    expect(authorize({ authorization: `Token ${KEY}` }, KEY)).toBe(true);
    expect(authorize({ "x-api-key": KEY }, KEY)).toBe(true);
  });

  it("rejects a missing or wrong key", () => {
    expect(authorize({}, KEY)).toBe(false);
    expect(authorize({ authorization: "Bearer nope" }, KEY)).toBe(false);
  });
});

describe("handleAdd", () => {
  const body = {
    request_id: "eval:r1:locomo:conv-0:chunk-0",
    user_id: "eval:r1:locomo:conv-0",
    session_id: "eval:r1:sample:0",
    messages: [
      { role: "user", content: "Melanie got a new bike", timestamp: 1704067200000 },
      { role: "assistant", content: "Noted!" }
    ]
  };

  it("creates the scope on first sight, persists every message, echoes ids", async () => {
    const core = fakeCore();
    const res = await handleAdd(body, core);

    expect(core.createScope).toHaveBeenCalledWith(body.user_id);
    expect(core.ingest).toHaveBeenCalledTimes(2);
    // Timestamps ride through as occurredAt so time-based reasoning survives replay.
    expect((core.ingest as any).mock.calls[0][2]).toBe(new Date(1704067200000).toISOString());
    expect((core.ingest as any).mock.calls[1][2]).toBeUndefined();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      request_id: body.request_id,
      user_id: body.user_id,
      session_id: body.session_id
    });
  });

  it("reuses an existing scope and enqueues distillation best-effort", async () => {
    const core = fakeCore({ findScope: vi.fn(async () => "scope-9"), enqueueDigest: vi.fn(async () => { throw new Error("queue down"); }) });
    const res = await handleAdd(body, core);
    expect(core.createScope).not.toHaveBeenCalled();
    expect(res.status).toBe(200); // digest enqueue failure must not fail the write
  });

  it("rejects a malformed body without touching the core", async () => {
    const core = fakeCore();
    const res = await handleAdd({ user_id: "u" }, core);
    expect(res.status).toBe(400);
    expect(core.ingest).not.toHaveBeenCalled();
  });

  it("fails closed when persistence fails: no 200 without durability", async () => {
    const core = fakeCore({ ingest: vi.fn(async () => { throw new Error("db down"); }) });
    const res = await handleAdd(body, core);
    expect(res.status).toBe(500);
  });
});

describe("handleSearch", () => {
  const facts = [
    { id: "f1", content: "Melanie rides on Sundays", addedAt: "2026-07-01T12:00:00.000Z" },
    { id: "f2", content: "Melanie owns a bike", addedAt: "2026-07-02T12:00:00.000Z" }
  ];
  const events = [
    { id: "e1", content: "raw turn about cycling", createdAt: "2026-07-03T12:00:00.000Z" }
  ];

  it("returns interleaved fact/event layers, digest first, capped at top_k", async () => {
    const core = fakeCore({
      findScope: vi.fn(async () => "scope-1"),
      retrieve: vi.fn(async () => ({ digest: "Melanie is an avid cyclist.", factRegistry: facts, events }))
    });

    const res = await handleSearch(
      { query: "what does Melanie do on Sundays?", user_id: "u1", top_k: 3 },
      core
    );

    expect(res.status).toBe(200);
    const data = (res.body as any).data;
    expect(data.map((d: any) => d.id)).toEqual(["digest:scope-1", "f1", "e1"]);
    expect(data[0].content).toContain("cyclist");
    expect(data[1].created_at).toBe("2026-07-01T12:00:00.000Z");
    // Relevance-ordered scores, strictly decreasing with position.
    expect(data[0].score).toBeGreaterThan(data[1].score);
  });

  it("folds choice options into the retrieval query", async () => {
    const retrieve = vi.fn(async () => ({ digest: null, factRegistry: [], events: [] }));
    const core = fakeCore({ findScope: vi.fn(async () => "scope-1"), retrieve });

    await handleSearch({ query: "who?", options: ["A. Melanie", "B. Igor"], user_id: "u1", top_k: 5 }, core);

    expect(retrieve.mock.calls[0][1]).toContain("Melanie");
    expect(retrieve.mock.calls[0][1]).toContain("Igor");
  });

  it("answers an unknown user with an empty result set, not an error", async () => {
    const res = await handleSearch({ query: "q", user_id: "ghost", top_k: 10 }, fakeCore());
    expect(res.status).toBe(200);
    expect((res.body as any).data).toEqual([]);
  });

  it("clamps top_k to the engine's retrieval ceiling", async () => {
    const retrieve = vi.fn(async () => ({ digest: null, factRegistry: [], events: [] }));
    const core = fakeCore({ findScope: vi.fn(async () => "scope-1"), retrieve });
    await handleSearch({ query: "q", user_id: "u1", top_k: 500 }, core);
    expect(retrieve.mock.calls[0][2]).toBeLessThanOrEqual(100);
  });
});
