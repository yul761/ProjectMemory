# MCP Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `apps/adapter-mcp/` — a Model Context Protocol server that exposes StateCore memory to Claude Code, with per-project scope isolation based on `cwd`.

**Architecture:** A Node.js process spawned by Claude Code via stdio. On startup it resolves (or creates) a StateCore scope keyed to `process.cwd()`. It exposes 5 MCP tools that map directly to StateCore REST API calls. No business logic — all memory work stays in StateCore.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk@^1.x`, `zod@^3`, `tsx` for dev, `tsc` for prod build. Vitest for unit tests on scope-manager and api-client.

---

## File Map

| File | Responsibility |
|------|---------------|
| `apps/adapter-mcp/package.json` | Package config, deps, scripts |
| `apps/adapter-mcp/tsconfig.json` | Extends `../../tsconfig.base.json` |
| `apps/adapter-mcp/src/env.ts` | Parse + validate env vars |
| `apps/adapter-mcp/src/api-client.ts` | `apiFetch` with 3-attempt retry |
| `apps/adapter-mcp/src/scope-manager.ts` | Resolve or create scope from `cwd` |
| `apps/adapter-mcp/src/main.ts` | MCP server, tool registrations |
| `apps/adapter-mcp/src/api-client.test.ts` | Unit tests for retry logic |
| `apps/adapter-mcp/src/scope-manager.test.ts` | Unit tests for find-or-create logic |

---

## Task 1: Scaffold Package

**Files:**
- Create: `apps/adapter-mcp/package.json`
- Create: `apps/adapter-mcp/tsconfig.json`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@statecore/adapter-mcp",
  "version": "1.0.0",
  "private": true,
  "type": "commonjs",
  "main": "dist/main.js",
  "scripts": {
    "dev": "tsx watch src/main.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/main.js",
    "test": "vitest run"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0",
    "zod": "^3.24.1"
  },
  "devDependencies": {
    "tsx": "^4.19.2",
    "typescript": "^5.7.3",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "moduleResolution": "Bundler"
  },
  "include": ["src"]
}
```

Note: `moduleResolution: Bundler` is required to resolve `@modelcontextprotocol/sdk` subpath exports (e.g. `sdk/server/mcp.js`). Without it TypeScript can't find the types.

- [ ] **Step 3: Install dependencies**

Run from repo root:
```bash
pnpm install
```
Expected: `@modelcontextprotocol/sdk` appears in `apps/adapter-mcp/node_modules`.

- [ ] **Step 4: Commit**

```bash
git add apps/adapter-mcp/package.json apps/adapter-mcp/tsconfig.json pnpm-lock.yaml
git commit -m "feat(adapter-mcp): scaffold package"
```

---

## Task 2: env.ts

**Files:**
- Create: `apps/adapter-mcp/src/env.ts`

- [ ] **Step 1: Write env.ts**

```typescript
import { existsSync, readFileSync } from "fs";
import path from "path";
import { z } from "zod";

function loadEnvFile(filePath: string) {
  if (!existsSync(filePath)) return;
  const lines = readFileSync(filePath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

const repoRoot = path.resolve(__dirname, "../../..");
loadEnvFile(path.join(repoRoot, ".env"));

const envSchema = z.object({
  STATECORE_API_URL: z.string().default("http://localhost:3000"),
  STATECORE_TOKEN: z.string().default("local-dev-user"),
  STATECORE_USER_ID: z.string().default("mcp-user")
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid env", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const mcpEnv = {
  apiBaseUrl: parsed.data.STATECORE_API_URL,
  token: parsed.data.STATECORE_TOKEN,
  userId: parsed.data.STATECORE_USER_ID
};
```

- [ ] **Step 2: Commit**

```bash
git add apps/adapter-mcp/src/env.ts
git commit -m "feat(adapter-mcp): add env config"
```

---

## Task 3: api-client.ts + tests

**Files:**
- Create: `apps/adapter-mcp/src/api-client.ts`
- Create: `apps/adapter-mcp/src/api-client.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/adapter-mcp/src/api-client.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { apiFetch } from "./api-client";

describe("apiFetch", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns parsed JSON on success", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "abc" })
    });
    const result = await apiFetch("/scopes", "local-dev-user", "http://localhost:3000");
    expect(result).toEqual({ id: "abc" });
  });

  it("retries on 503 then succeeds", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "abc" }) });
    const result = await apiFetch("/scopes", "local-dev-user", "http://localhost:3000");
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ id: "abc" });
  });

  it("returns error object after 3 failures", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    const result = await apiFetch("/scopes", "local-dev-user", "http://localhost:3000");
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(result).toHaveProperty("error");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/adapter-mcp && pnpm test
```
Expected: FAIL — `apiFetch` not defined.

- [ ] **Step 3: Write api-client.ts**

```typescript
// apps/adapter-mcp/src/api-client.ts
function shouldRetry(status: number) {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJsonSafe<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export async function apiFetch<T>(
  path: string,
  token: string,
  baseUrl: string,
  options?: RequestInit
): Promise<T | { error: string; detail?: string }> {
  const url = `${baseUrl}${path}`;
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          "x-user-id": token,
          ...(options?.headers ?? {})
        }
      });
      const data = await readJsonSafe<T>(response);
      if (!response.ok) {
        if (shouldRetry(response.status) && attempt < 2) {
          await sleep(Math.min(200 * Math.pow(2, attempt), 1000));
          continue;
        }
        return (data ?? { error: `HTTP ${response.status}` }) as { error: string };
      }
      return data as T;
    } catch (err) {
      lastError = err;
      if (attempt < 2) {
        await sleep(Math.min(200 * Math.pow(2, attempt), 1000));
        continue;
      }
    }
  }
  return { error: "request_failed", detail: String(lastError ?? "") };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/adapter-mcp && pnpm test
```
Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/adapter-mcp/src/api-client.ts apps/adapter-mcp/src/api-client.test.ts
git commit -m "feat(adapter-mcp): add api-client with retry"
```

---

## Task 4: scope-manager.ts + tests

**Files:**
- Create: `apps/adapter-mcp/src/scope-manager.ts`
- Create: `apps/adapter-mcp/src/scope-manager.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/adapter-mcp/src/scope-manager.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock is hoisted above imports by vitest
vi.mock("./api-client");
vi.mock("./env", () => ({
  mcpEnv: { apiBaseUrl: "http://localhost:3000", token: "local-dev-user", userId: "mcp-user" }
}));

import { apiFetch } from "./api-client";
import { ScopeManager } from "./scope-manager";

const mockApiFetch = vi.mocked(apiFetch);

describe("ScopeManager", () => {
  beforeEach(() => mockApiFetch.mockReset());

  it("returns existing scope id when name matches", async () => {
    mockApiFetch.mockResolvedValueOnce({
      items: [{ id: "scope-1", name: "project:myapp" }]
    });
    const manager = new ScopeManager("/home/user/myapp");
    const id = await manager.getScopeId();
    expect(id).toBe("scope-1");
    expect(mockApiFetch).toHaveBeenCalledTimes(1);
  });

  it("creates scope when not found", async () => {
    mockApiFetch
      .mockResolvedValueOnce({ items: [] })                             // GET /scopes
      .mockResolvedValueOnce({ id: "scope-2", name: "project:myapp" }) // POST /scopes
      .mockResolvedValueOnce({ activeScopeId: "scope-2" });            // POST /scopes/:id/active
    const manager = new ScopeManager("/home/user/myapp");
    const id = await manager.getScopeId();
    expect(id).toBe("scope-2");
    expect(mockApiFetch).toHaveBeenCalledTimes(3);
  });

  it("caches scope id after first resolution", async () => {
    mockApiFetch.mockResolvedValueOnce({
      items: [{ id: "scope-1", name: "project:myapp" }]
    });
    const manager = new ScopeManager("/home/user/myapp");
    await manager.getScopeId();
    await manager.getScopeId();
    expect(mockApiFetch).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/adapter-mcp && pnpm test
```
Expected: FAIL — `ScopeManager` not defined.

- [ ] **Step 3: Write scope-manager.ts**

```typescript
// apps/adapter-mcp/src/scope-manager.ts
import path from "path";
import { apiFetch } from "./api-client";
import { mcpEnv } from "./env";

interface ScopeItem {
  id: string;
  name: string;
}

interface ScopeListResponse {
  items: ScopeItem[];
}

interface ScopeResponse {
  id: string;
  name: string;
}

export class ScopeManager {
  private readonly scopeName: string;
  private cachedScopeId: string | null = null;

  constructor(cwd: string = process.cwd()) {
    const base = path.basename(cwd);
    this.scopeName = `project:${base}`;
  }

  async getScopeId(): Promise<string> {
    if (this.cachedScopeId) return this.cachedScopeId;

    const list = await apiFetch<ScopeListResponse>(
      "/scopes",
      mcpEnv.token,
      mcpEnv.apiBaseUrl
    ) as ScopeListResponse;

    const existing = list.items?.find((s) => s.name === this.scopeName);
    if (existing) {
      this.cachedScopeId = existing.id;
      return existing.id;
    }

    const created = await apiFetch<ScopeResponse>(
      "/scopes",
      mcpEnv.token,
      mcpEnv.apiBaseUrl,
      { method: "POST", body: JSON.stringify({ name: this.scopeName }) }
    ) as ScopeResponse;

    await apiFetch(
      `/scopes/${created.id}/active`,
      mcpEnv.token,
      mcpEnv.apiBaseUrl,
      { method: "POST" }
    );

    this.cachedScopeId = created.id;
    return created.id;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/adapter-mcp && pnpm test
```
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/adapter-mcp/src/scope-manager.ts apps/adapter-mcp/src/scope-manager.test.ts
git commit -m "feat(adapter-mcp): add scope manager with cwd-based isolation"
```

---

## Task 5: main.ts — MCP Server

**Files:**
- Create: `apps/adapter-mcp/src/main.ts`

- [ ] **Step 1: Write main.ts**

```typescript
// apps/adapter-mcp/src/main.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { apiFetch } from "./api-client";
import { mcpEnv } from "./env";
import { ScopeManager } from "./scope-manager";

const scopeManager = new ScopeManager();
const server = new McpServer({ name: "statecore", version: "1.0.0" });

function fetch_(path: string, options?: RequestInit) {
  return apiFetch(path, mcpEnv.token, mcpEnv.apiBaseUrl, options);
}

server.tool(
  "get_context",
  "Load compressed memory state for the current project into context.",
  { message: z.string().optional().describe("Optional hint about what you need context for") },
  async ({ message }) => {
    const scopeId = await scopeManager.getScopeId();
    const params = new URLSearchParams({ scopeId });
    if (message) params.set("message", message);
    const data = await fetch_(`/memory/fast-view?${params}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "save_turn",
  "Persist a summary of this conversation turn to project memory.",
  { content: z.string().describe("Summary of what was discussed or decided") },
  async ({ content }) => {
    const scopeId = await scopeManager.getScopeId();
    await fetch_("/memory/events", {
      method: "POST",
      body: JSON.stringify({ scopeId, type: "stream", source: "claude-code", content })
    });
    return { content: [{ type: "text" as const, text: "Saved." }] };
  }
);

server.tool(
  "recall",
  "Answer a specific question grounded in stored project memory.",
  { question: z.string().describe("Question to answer from memory") },
  async ({ question }) => {
    const scopeId = await scopeManager.getScopeId();
    const data = await fetch_("/memory/answer", {
      method: "POST",
      body: JSON.stringify({ scopeId, question })
    }) as { answer?: string; error?: string };
    const text = data.answer ?? data.error ?? JSON.stringify(data);
    return { content: [{ type: "text" as const, text }] };
  }
);

server.tool(
  "get_working_state",
  "Get the current structured working memory: active tasks, open issues, recent decisions.",
  {},
  async () => {
    const scopeId = await scopeManager.getScopeId();
    const data = await fetch_(`/memory/working-state?scopeId=${scopeId}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "force_digest",
  "Manually trigger State Layer consolidation to compress accumulated memory events.",
  {},
  async () => {
    const scopeId = await scopeManager.getScopeId();
    const data = await fetch_("/memory/digest", {
      method: "POST",
      body: JSON.stringify({ scopeId })
    }) as { jobId?: string; error?: string };
    const text = data.jobId ? `Digest queued. Job: ${data.jobId}` : (data.error ?? JSON.stringify(data));
    return { content: [{ type: "text" as const, text }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
```

- [ ] **Step 2: Verify it compiles**

```bash
cd apps/adapter-mcp && pnpm build
```
Expected: `dist/main.js` created, no TypeScript errors.

- [ ] **Step 3: Verify it starts without crashing**

```bash
cd apps/adapter-mcp && echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}' | node dist/main.js
```
Expected: JSON response with `serverInfo.name: "statecore"` printed to stdout.

- [ ] **Step 4: Commit**

```bash
git add apps/adapter-mcp/src/main.ts
git commit -m "feat(adapter-mcp): add MCP server with 5 tools"
```

---

## Task 6: Wire into Monorepo + Claude Code Setup

**Files:**
- Modify: `apps/adapter-mcp/package.json` (no change needed — pnpm workspace picks up `apps/*` automatically)
- Create: `.claude/settings.json` (or modify if exists)

- [ ] **Step 1: Verify workspace picks up the package**

```bash
pnpm list --filter @statecore/adapter-mcp
```
Expected: package listed.

- [ ] **Step 2: Add dev:mcp script to root package.json**

Open `package.json` at repo root. Add to `scripts`:
```json
"dev:mcp": "pnpm --filter @statecore/adapter-mcp dev"
```

- [ ] **Step 3: Configure Claude Code MCP integration**

Check if `.claude/settings.json` exists in the repo root. If it does not exist, create it. If it exists, merge the `mcpServers` key.

```json
{
  "mcpServers": {
    "statecore": {
      "command": "node",
      "args": ["PATH_TO_REPO/apps/adapter-mcp/dist/main.js"],
      "env": {
        "STATECORE_API_URL": "http://localhost:3000",
        "STATECORE_TOKEN": "local-dev-user"
      }
    }
  }
}
```

Replace `PATH_TO_REPO` with the absolute path to the repo root (e.g. `C:/StateCore/StateCore`).

For development (no build step), use tsx instead:
```json
{
  "mcpServers": {
    "statecore": {
      "command": "npx",
      "args": ["tsx", "PATH_TO_REPO/apps/adapter-mcp/src/main.ts"],
      "env": {
        "STATECORE_API_URL": "http://localhost:3000",
        "STATECORE_TOKEN": "local-dev-user"
      }
    }
  }
}
```

- [ ] **Step 4: Restart Claude Code and verify MCP server loads**

Restart Claude Code. Open a new conversation. Run:
```
/mcp
```
Expected: `statecore` listed as a connected MCP server with 5 tools: `get_context`, `save_turn`, `recall`, `get_working_state`, `force_digest`.

- [ ] **Step 5: Smoke test — call get_context**

With StateCore API running (`pnpm dev:api` + `pnpm dev:worker`), ask Claude:
```
Use the get_context tool to load memory for this project.
```
Expected: Claude calls `get_context`, gets back JSON from StateCore, reports on memory state.

- [ ] **Step 6: Commit**

```bash
git add package.json .claude/settings.json
git commit -m "feat(adapter-mcp): wire into monorepo and add Claude Code config"
```
