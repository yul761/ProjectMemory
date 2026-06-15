import { describe, it, expect, beforeAll } from "vitest";

const BASE = "http://127.0.0.1:3002";

async function api(path: string, options: { method?: string; userId: string; body?: unknown }) {
  const res = await fetch(`${BASE}${path}`, {
    method: options.method ?? "GET",
    headers: {
      "content-type": "application/json",
      "x-user-id": options.userId
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe("Multi-user isolation", () => {
  let scopeIdA: string;

  beforeAll(async () => {
    // Create a scope as user A
    const res = await api("/scopes", {
      method: "POST",
      userId: "test-isolation-user-a",
      body: { name: "Isolation test scope A" }
    });
    expect(res.status).toBe(201);
    scopeIdA = res.body.id;
  });

  it("user B scope list does not include user A scope", async () => {
    const res = await api("/scopes", { userId: "test-isolation-user-b" });
    expect(res.status).toBe(200);
    // GET /scopes returns { items: [...] }
    const items: Array<{ id: string }> = res.body?.items ?? res.body ?? [];
    const ids = items.map((s) => s.id);
    expect(ids).not.toContain(scopeIdA);
  });

  it("user B cannot ingest events into user A scope", async () => {
    const res = await api("/memory/events", {
      method: "POST",
      userId: "test-isolation-user-b",
      body: {
        scopeId: scopeIdA,
        type: "stream",
        source: "api",
        content: "hostile injection attempt"
      }
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("user B cannot retrieve memory from user A scope", async () => {
    const res = await api("/memory/retrieve", {
      method: "POST",
      userId: "test-isolation-user-b",
      body: { scopeId: scopeIdA, query: "hostile query", limit: 10 }
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("user B cannot trigger a digest on user A scope", async () => {
    const res = await api("/memory/digest", {
      method: "POST",
      userId: "test-isolation-user-b",
      body: { scopeId: scopeIdA }
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
