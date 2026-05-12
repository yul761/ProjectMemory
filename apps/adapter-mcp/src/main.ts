// apps/adapter-mcp/src/main.ts
/* eslint-disable @typescript-eslint/no-explicit-any */
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
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

tool(
  "save_turn",
  "Persist a summary of this conversation turn to project memory.",
  { content: z.string().describe("Summary of what was discussed or decided") },
  async ({ content }: { content: string }) => {
    const scopeId = await scopeManager.getScopeId();
    await fetch_("/memory/events", {
      method: "POST",
      body: JSON.stringify({ scopeId, type: "stream", source: "claude-code", content })
    });
    return { content: [{ type: "text" as const, text: "Saved." }] };
  }
);

tool(
  "recall",
  "Answer a specific question grounded in stored project memory.",
  { question: z.string().describe("Question to answer from memory") },
  async ({ question }: { question: string }) => {
    const scopeId = await scopeManager.getScopeId();
    const data = await fetch_("/memory/answer", {
      method: "POST",
      body: JSON.stringify({ scopeId, question })
    }) as { answer?: string; error?: string };
    const text = data.answer ?? data.error ?? JSON.stringify(data);
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
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
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
    return { content: [{ type: "text" as const, text }] };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
