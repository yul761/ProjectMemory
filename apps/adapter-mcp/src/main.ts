// apps/adapter-mcp/src/main.ts
/* eslint-disable @typescript-eslint/no-explicit-any */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { appendFileSync, mkdirSync } from "fs";
import path from "path";
import { z } from "zod";
import { apiFetch } from "./api-client";
import { mcpEnv } from "./env";
import { ScopeManager } from "./scope-manager";

const scopeManager = new ScopeManager();
const server = new McpServer({ name: "statecore", version: "1.0.0" });

// JSONL usage log — written to mcp-usage-log/ at repo root, gitignored
const logDir = path.resolve(__dirname, "../../../mcp-usage-log");
const logFile = path.join(logDir, `usage-${new Date().toISOString().slice(0, 10)}.jsonl`);

function logEvent(entry: Record<string, unknown>) {
  try {
    mkdirSync(logDir, { recursive: true });
    appendFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  } catch {
    // logging failure must never break tool execution
  }
}

function fetch_(path: string, options?: RequestInit) {
  return apiFetch(path, mcpEnv.token, mcpEnv.apiBaseUrl, options);
}

// Cast inputSchema to any to avoid deep type instantiation error (TS2589)
// caused by MCP SDK supporting both Zod v3 and v4 types simultaneously.
const tool = (
  name: string,
  description: string,
  inputSchema: Record<string, any>,
  handler: (args: any) => Promise<any>
) => server.registerTool(name, { description, inputSchema } as any, handler);

tool(
  "get_context",
  "Load compressed memory state for the current project into context.",
  { message: z.string().optional().describe("Optional hint about what you need context for") },
  async ({ message }: { message?: string }) => {
    const scopeId = await scopeManager.getScopeId();
    const params = new URLSearchParams({ scopeId });
    if (message) params.set("message", message);
    const data = await fetch_(`/memory/fast-view?${params}`);
    const text = JSON.stringify(data, null, 2);
    logEvent({ tool: "get_context", scopeId, message: message ?? null, resultBytes: text.length });
    return { content: [{ type: "text" as const, text }] };
  }
);

tool(
  "save_turn",
  "Persist a summary of this conversation turn to project memory.",
  { content: z.string().describe("Summary of what was discussed or decided") },
  async ({ content }: { content: string }) => {
    const scopeId = await scopeManager.getScopeId();
    await fetch_("/memory/runtime/turn", {
      method: "POST",
      body: JSON.stringify({ scopeId, message: content, source: "api", digestMode: "auto" })
    });
    logEvent({ tool: "save_turn", scopeId, contentLength: content.length, preview: content.slice(0, 120) });
    return { content: [{ type: "text" as const, text: "Saved." }] };
  }
);

tool(
  "list_scopes",
  "List all available memory scopes with their names and goals. Use this to discover which scope to query before calling recall with a specific scopeId.",
  {},
  async () => {
    const data = await fetch_("/scopes") as { items?: Array<{ id: string; name: string; goal: string | null; stage: string }> };
    const scopes = (data.items ?? []).map(s => ({ id: s.id, name: s.name, goal: s.goal ?? "(no goal set)", stage: s.stage }));
    const text = scopes.map(s => `${s.name} (${s.id})\n  goal: ${s.goal}\n  stage: ${s.stage}`).join("\n\n");
    logEvent({ tool: "list_scopes", count: scopes.length });
    return { content: [{ type: "text" as const, text: text || "No scopes found." }] };
  }
);

tool(
  "recall",
  "Answer a specific question grounded in stored memory. By default queries the current project scope. Pass scopeId to query a different scope (use list_scopes first to find the right one).",
  {
    question: z.string().describe("Question to answer from memory"),
    scopeId: z.string().optional().describe("Scope ID to query. Omit to use current project scope. Use list_scopes to discover available scopes.")
  },
  async ({ question, scopeId: explicitScopeId }: { question: string; scopeId?: string }) => {
    const scopeId = explicitScopeId ?? await scopeManager.getScopeId();
    const data = await fetch_("/memory/answer", {
      method: "POST",
      body: JSON.stringify({ scopeId, question })
    }) as { answer?: string; error?: string };
    const text = data.answer ?? data.error ?? JSON.stringify(data);
    logEvent({ tool: "recall", scopeId, explicitScope: !!explicitScopeId, question, answered: !!data.answer, answerLength: text.length });
    return { content: [{ type: "text" as const, text }] };
  }
);

tool(
  "get_working_state",
  "Get the current structured working memory: active tasks, open issues, recent decisions.",
  {},
  async () => {
    const scopeId = await scopeManager.getScopeId();
    const data = await fetch_(`/memory/working-state?scopeId=${scopeId}`);
    const text = JSON.stringify(data, null, 2);
    logEvent({ tool: "get_working_state", scopeId, resultBytes: text.length });
    return { content: [{ type: "text" as const, text }] };
  }
);

tool(
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
    logEvent({ tool: "force_digest", scopeId, jobId: data.jobId ?? null, error: data.error ?? null });
    return { content: [{ type: "text" as const, text }] };
  }
);

logEvent({ tool: "server_start", scopeName: path.basename(process.cwd()) });

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
