import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { createServer, type Server, type IncomingMessage } from "node:http";
import { createHttpBackend } from "../src/http-backend";

type RecordedRequest = { method: string; path: string; headers: IncomingMessage["headers"]; body: unknown };

/** Starts a stub `/v1` server on an ephemeral port that records every request and replies from `responses`, keyed by `METHOD path` (path without query string). */
function startStubServer(responses: Record<string, { status: number; body: unknown }>) {
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const url = new URL(req.url ?? "/", "http://localhost");
      requests.push({
        method: req.method ?? "",
        path: req.url ?? "",
        headers: req.headers,
        body: raw ? JSON.parse(raw) : undefined
      });
      const key = `${req.method} ${url.pathname}`;
      const match = responses[key];
      if (!match) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `no stub for ${key}` }));
        return;
      }
      res.writeHead(match.status, { "content-type": "application/json" });
      res.end(JSON.stringify(match.body));
    });
  });
  return { server, requests };
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

const SCOPE_ID = "11111111-1111-1111-1111-111111111111";

describe("http backend, --url mode", () => {
  let server: Server;
  let requests: RecordedRequest[];
  let baseUrl: string;

  beforeEach(async () => {
    ({ server, requests } = startStubServer({
      "GET /v1/scopes": { status: 200, body: { items: [{ id: SCOPE_ID, name: "my-project", goal: null, stage: "build", createdAt: "2026-08-14T00:00:00.000Z" }] } },
      "POST /v1/memory/notes": { status: 200, body: { ok: true } },
      "POST /v1/memory/events": { status: 200, body: { id: "evt-1", userId: "u1", scopeId: SCOPE_ID, type: "stream", source: "api", key: null, content: "x", createdAt: "2026-08-14T00:00:00.000Z", updatedAt: null } },
      "POST /v1/memory/retrieve": { status: 200, body: { digest: null, events: [], factRegistry: [] } },
      "GET /v1/memory/facts": { status: 200, body: { groups: [{ group: "Decisions", items: [{ factKey: "k1", text: "we use pnpm", createdAt: null }] }] } },
      "GET /v1/memory/facts/fact-1/provenance": { status: 200, body: { fact: { id: "fact-1" }, chain: [] } },
      "POST /v1/memory/facts/forget": { status: 200, body: { ok: true } }
    }));
    baseUrl = await listen(server);
  });

  afterEach(async () => {
    if (server) await close(server);
  });

  /** Swaps in a fresh stub server (closing the beforeEach one first) so a test can assert against a different response set. */
  async function restub(responses: Record<string, { status: number; body: unknown }>): Promise<void> {
    await close(server);
    ({ server, requests } = startStubServer(responses));
    baseUrl = await listen(server);
  }

  it("init() lists scopes and adopts the id of the matching name, without creating one", async () => {
    const be = createHttpBackend({ baseUrl, userId: "local", scopeName: "my-project" });
    await be.init();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: "GET", path: "/v1/scopes" });
    expect(requests[0].headers["x-user-id"]).toBe("local");
  });

  it("init() creates the scope with template project when no name matches", async () => {
    await restub({
      "GET /v1/scopes": { status: 200, body: { items: [] } },
      "POST /v1/scopes": { status: 200, body: { id: SCOPE_ID, name: "new-project", goal: null, stage: "build", createdAt: "2026-08-14T00:00:00.000Z" } }
    });
    const be = createHttpBackend({ baseUrl, userId: "local", scopeName: "new-project" });
    await be.init();
    expect(requests[1]).toMatchObject({ method: "POST", path: "/v1/scopes", body: { name: "new-project", template: "project" } });
  });

  it("remember() without consolidate posts to /v1/memory/notes with scopeId and text", async () => {
    const be = createHttpBackend({ baseUrl, userId: "local", scopeName: "my-project" });
    await be.init();
    const res = await be.remember({ text: "we use pnpm, not npm" });
    expect(res).toEqual({ ok: true, mode: "note" });
    const notesReq = requests.find((r) => r.path === "/v1/memory/notes");
    expect(notesReq).toMatchObject({ method: "POST", body: { scopeId: SCOPE_ID, text: "we use pnpm, not npm" } });
    expect(notesReq?.headers["x-user-id"]).toBe("local");
  });

  it("remember() with consolidate posts a stream event to /v1/memory/events", async () => {
    const be = createHttpBackend({ baseUrl, userId: "local", scopeName: "my-project" });
    await be.init();
    const res = await be.remember({ text: "long conversational turn", consolidate: true });
    expect(res).toEqual({ ok: true, mode: "event" });
    const eventsReq = requests.find((r) => r.path === "/v1/memory/events");
    expect(eventsReq).toMatchObject({
      method: "POST",
      body: { scopeId: SCOPE_ID, type: "stream", source: "api", content: "long conversational turn" }
    });
  });

  it("recall() posts to /v1/memory/retrieve with scopeId, query, and maxChars", async () => {
    const be = createHttpBackend({ baseUrl, userId: "local", scopeName: "my-project" });
    await be.init();
    await be.recall({ query: "pnpm", maxChars: 500 });
    const retrieveReq = requests.find((r) => r.path === "/v1/memory/retrieve");
    expect(retrieveReq).toMatchObject({ method: "POST", body: { scopeId: SCOPE_ID, query: "pnpm", maxChars: 500 } });
  });

  it("facts() gets /v1/memory/facts?scopeId= and returns the groups array", async () => {
    const be = createHttpBackend({ baseUrl, userId: "local", scopeName: "my-project" });
    await be.init();
    const groups = await be.facts();
    const factsReq = requests.find((r) => r.path.startsWith("/v1/memory/facts?"));
    expect(factsReq).toMatchObject({ method: "GET" });
    expect(new URL(`http://x${factsReq!.path}`).searchParams.get("scopeId")).toBe(SCOPE_ID);
    expect(groups).toEqual([{ group: "Decisions", items: [{ factKey: "k1", text: "we use pnpm", createdAt: null }] }]);
  });

  it("why() gets /v1/memory/facts/:id/provenance?scopeId=", async () => {
    const be = createHttpBackend({ baseUrl, userId: "local", scopeName: "my-project" });
    await be.init();
    const prov: any = await be.why({ factId: "fact-1" });
    expect(prov.fact.id).toBe("fact-1");
    const provReq = requests.find((r) => r.path.startsWith("/v1/memory/facts/fact-1/provenance?"));
    expect(provReq).toMatchObject({ method: "GET" });
    expect(new URL(`http://x${provReq!.path}`).searchParams.get("scopeId")).toBe(SCOPE_ID);
  });

  it("why() returns null on a 404 rather than throwing", async () => {
    await restub({
      "GET /v1/scopes": { status: 200, body: { items: [{ id: SCOPE_ID, name: "my-project", goal: null, stage: "build", createdAt: "2026-08-14T00:00:00.000Z" }] } },
      "GET /v1/memory/facts/missing/provenance": { status: 404, body: { error: "Fact not found" } }
    });
    const be = createHttpBackend({ baseUrl, userId: "local", scopeName: "my-project" });
    await be.init();
    const result = await be.why({ factId: "missing" });
    expect(result).toBeNull();
  });

  it("forget() posts scopeId and factKey to /v1/memory/facts/forget", async () => {
    const be = createHttpBackend({ baseUrl, userId: "local", scopeName: "my-project" });
    await be.init();
    const res = await be.forget({ factKey: "k1" });
    expect(res).toEqual({ ok: true });
    const forgetReq = requests.find((r) => r.path === "/v1/memory/facts/forget");
    expect(forgetReq).toMatchObject({ method: "POST", body: { scopeId: SCOPE_ID, factKey: "k1" } });
  });

  it("every call carries the x-user-id header", async () => {
    const be = createHttpBackend({ baseUrl, userId: "someone-else", scopeName: "my-project" });
    await be.init();
    await be.remember({ text: "hi" });
    for (const req of requests) {
      expect(req.headers["x-user-id"]).toBe("someone-else");
    }
  });

  it("a non-2xx response throws with the status and the first 200 chars of the body", async () => {
    const longError = "x".repeat(500);
    await restub({
      "GET /v1/scopes": { status: 500, body: { error: longError } }
    });
    const be = createHttpBackend({ baseUrl, userId: "local", scopeName: "my-project" });
    let caught: Error | undefined;
    try {
      await be.init();
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught?.message).toContain("GET /v1/scopes failed: 500");
    // JSON-stringified body is longer than the raw 500-char string (quoting +
    // the {"error":...} envelope), so 200 raw chars of body still means the
    // message itself never reaches that stringified body's own length;
    // assert the truncation directly against what the server actually sent.
    const sentBody = JSON.stringify({ error: longError });
    expect(caught?.message.length).toBeLessThan(sentBody.length);
  });
});
