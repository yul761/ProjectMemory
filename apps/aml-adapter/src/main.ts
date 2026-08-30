/**
 * HTTP wiring for the AML adapter — see server.ts for the mapping itself.
 *
 * Env:
 *   PORT             adapter port (default 8787)
 *   CORE_URL         StateCore /v1 base, e.g. http://127.0.0.1:3002
 *   CORE_USER_ID     the x-user-id this adapter authenticates to the core as
 *   AML_MEMORY_KEY   the secret issued to the AML platform; required — the
 *                    adapter refuses to start without one rather than serving
 *                    an open write endpoint
 */
import { createServer } from "node:http";
import { authorize, handleAdd, handleSearch, type CoreClient, type HandlerResult } from "./server";

const PORT = Number(process.env.PORT || 8787);
const CORE_URL = (process.env.CORE_URL || "http://127.0.0.1:3002").replace(/\/$/, "");
const CORE_USER_ID = process.env.CORE_USER_ID || "";
const AML_MEMORY_KEY = process.env.AML_MEMORY_KEY || "";

if (!CORE_USER_ID) {
  console.error("[aml-adapter] CORE_USER_ID is required");
  process.exit(1);
}
if (!AML_MEMORY_KEY) {
  console.error("[aml-adapter] AML_MEMORY_KEY is required — refusing to serve an unauthenticated write endpoint");
  process.exit(1);
}

async function coreFetch(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${CORE_URL}${path}`, {
    method,
    headers: { "x-user-id": CORE_USER_ID, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  if (!res.ok) throw new Error(`core ${method} ${path} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

// Scope ids are stable, so the name→id resolution is cached; a miss re-lists
// so a scope created by a previous adapter process is still found.
const scopeCache = new Map<string, string>();

const core: CoreClient = {
  async findScope(name) {
    const cached = scopeCache.get(name);
    if (cached) return cached;
    const listed = await coreFetch("GET", "/v1/scopes");
    for (const scope of listed.items ?? []) {
      if (scope?.name && scope?.id) scopeCache.set(scope.name, scope.id);
    }
    return scopeCache.get(name) ?? null;
  },
  async createScope(name) {
    const created = await coreFetch("POST", "/v1/scopes", { name });
    scopeCache.set(name, created.id);
    return created.id;
  },
  async ingest(scopeId, content, occurredAtIso) {
    await coreFetch("POST", "/v1/memory/events", {
      scopeId,
      type: "stream",
      source: "api",
      content,
      ...(occurredAtIso ? { occurredAt: occurredAtIso } : {})
    });
  },
  async enqueueDigest(scopeId) {
    await coreFetch("POST", "/v1/memory/digest", { scopeId });
  },
  async retrieve(scopeId, query, limit, maxChars) {
    return coreFetch("POST", "/v1/memory/retrieve", { scopeId, query, limit, maxChars });
  }
};

function readBody(req: import("node:http").IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 5_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function send(res: import("node:http").ServerResponse, result: HandlerResult): void {
  res.writeHead(result.status, { "content-type": "application/json" });
  res.end(JSON.stringify(result.body));
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      // Mirror the truth: healthy only when the memory engine behind us is.
      try {
        const probe = await fetch(`${CORE_URL}/v1/health`, { headers: { "x-user-id": CORE_USER_ID } });
        send(res, { status: probe.ok ? 200 : 503, body: { ok: probe.ok } });
      } catch {
        send(res, { status: 503, body: { ok: false } });
      }
      return;
    }

    if (req.method !== "POST" || (req.url !== "/add" && req.url !== "/search")) {
      send(res, { status: 404, body: { error: "not found" } });
      return;
    }
    if (!authorize(req.headers, AML_MEMORY_KEY)) {
      send(res, { status: 401, body: { error: "unauthorized" } });
      return;
    }

    const body = await readBody(req);
    const result = req.url === "/add" ? await handleAdd(body, core) : await handleSearch(body, core);
    send(res, result);
  } catch (err) {
    send(res, { status: 400, body: { error: err instanceof Error ? err.message : "bad request" } });
  }
});

server.listen(PORT, () => {
  console.error(`[aml-adapter] listening on :${PORT}, core at ${CORE_URL}`);
});
