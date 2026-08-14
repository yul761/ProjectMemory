import type { MemoryBackend } from "./backend";

/** Non-2xx response: status code plus the first 200 characters of the body, enough to diagnose without flooding stderr. */
function httpError(method: string, path: string, status: number, body: string): Error {
  return new Error(`${method} ${path} failed: ${status} ${body.slice(0, 200)}`);
}

/**
 * Remote `MemoryBackend` over a self-hosted StateCore stack: every operation
 * is one call to the frozen `/v1` surface (packages/contracts/src/index.ts,
 * apps/api/src/memory.controller.ts and scopes.controller.ts), authenticated
 * with the `x-user-id` header apps/api/src/auth.middleware.ts reads. Uses
 * global `fetch` only — no HTTP client dependency.
 *
 * Digest scheduling is out of scope here: a remote deployment runs its own
 * worker (apps/worker) that owns digest triggering for every scope it knows
 * about, so `init()` never starts one locally the way the embedded backend
 * does.
 */
export function createHttpBackend(opts: { baseUrl: string; userId: string; scopeName: string }): MemoryBackend {
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  let scopeId: string;

  async function request(method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "x-user-id": opts.userId,
        ...(body !== undefined ? { "content-type": "application/json" } : {})
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
    const text = await res.text();
    return { status: res.status, text };
  }

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const { status, text } = await request(method, path, body);
    if (status < 200 || status >= 300) throw httpError(method, path, status, text);
    return text ? (JSON.parse(text) as T) : (undefined as T);
  }

  function scopedQuery(extra: Record<string, string> = {}): string {
    return new URLSearchParams({ scopeId, ...extra }).toString();
  }

  return {
    async init() {
      const list = await call<{ items: Array<{ id: string; name: string }> }>("GET", "/v1/scopes");
      const existing = list.items.find((scope) => scope.name === opts.scopeName);
      if (existing) {
        scopeId = existing.id;
        return;
      }
      const created = await call<{ id: string }>("POST", "/v1/scopes", { name: opts.scopeName, template: "project" });
      scopeId = created.id;
    },

    async remember({ text, consolidate }) {
      if (consolidate) {
        await call("POST", "/v1/memory/events", { scopeId, type: "stream", source: "api", content: text });
        return { ok: true, mode: "event" };
      }
      await call("POST", "/v1/memory/notes", { scopeId, text });
      return { ok: true, mode: "note" };
    },

    async recall({ query, maxChars }) {
      return call("POST", "/v1/memory/retrieve", {
        scopeId,
        ...(query !== undefined ? { query } : {}),
        ...(maxChars !== undefined ? { maxChars } : {})
      });
    },

    async facts() {
      // GET /v1/memory/facts returns { groups }; groups is what
      // embedded.ts#facts() returns too (MemoryFactsOutput's shape). Remote
      // group items carry no fact-registry id — why() in this mode takes its
      // factId from recall()'s factRegistry or a prior provenance response,
      // never invented here.
      const result = await call<{ groups: unknown }>("GET", `/v1/memory/facts?${scopedQuery()}`);
      return result.groups;
    },

    async why({ factId }) {
      const { status, text } = await request("GET", `/v1/memory/facts/${encodeURIComponent(factId)}/provenance?${scopedQuery()}`);
      if (status === 404) return null;
      if (status < 200 || status >= 300) {
        throw httpError("GET", `/v1/memory/facts/${factId}/provenance`, status, text);
      }
      return JSON.parse(text);
    },

    async forget({ factKey }) {
      return call("POST", "/v1/memory/facts/forget", { scopeId, factKey });
    },

    async close() {
      // Nothing to release: every call above is a one-shot fetch, no held connection.
    }
  };
}
