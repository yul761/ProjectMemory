import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MemoryBackend } from "./backend";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

/**
 * `McpServer.registerTool`'s generic overload combines the SDK's dual zod v3/v4 compatibility
 * union (`AnySchema`) with a mapped type over the input shape; instantiating it for a raw shape
 * with 2+ keys exceeds TypeScript's recursion budget (TS2589) under this repo's `strict` compiler
 * options. Declaring `server`'s tool-registration surface with this narrower, non-generic shape
 * — checked once via the cast below — asserts the same runtime contract without re-triggering that
 * instantiation at each call site; the zod schemas still enforce their constraints at the protocol
 * boundary, and each handler below re-asserts its own argument type from the schema it declared.
 */
interface ToolRegistrar {
  registerTool(
    name: string,
    config: { description: string; inputSchema?: Record<string, z.ZodTypeAny> },
    cb: (args: Record<string, unknown>) => Promise<ToolResult>
  ): unknown;
}

/** Registers the five memory verbs — remember/recall/facts/why/forget — as MCP tools backed by `backend`. */
export function registerTools(server: McpServer, backend: MemoryBackend): void {
  const registrar = server as unknown as ToolRegistrar;

  registrar.registerTool(
    "remember",
    {
      description:
        "Store a durable fact about this project or user. Use for preferences, decisions, constraints, and anything worth knowing next session. Deterministic and audit-tracked; set consolidate=true only for long conversational context that should be distilled in the background.",
      inputSchema: { text: z.string().min(1).max(2000), consolidate: z.boolean().optional() }
    },
    async (args) => json(await backend.remember(args as { text: string; consolidate?: boolean }))
  );
  registrar.registerTool(
    "recall",
    {
      description:
        "Retrieve project memory relevant to a query, packed into a character budget. Returns the distilled digest, believed facts, recent events, and a budget report of what was left out. Call at the start of a session or before relying on past context.",
      inputSchema: { query: z.string().optional(), maxChars: z.number().int().positive().max(32000).optional() }
    },
    async (args) => {
      const a = args as { query?: string; maxChars?: number };
      return json(await backend.recall({ query: a.query, maxChars: a.maxChars ?? 4000 }));
    }
  );
  registrar.registerTool(
    "facts",
    { description: "List everything currently believed about this project, grouped, with fact ids. Use to review or audit the memory." },
    async () => json(await backend.facts())
  );
  registrar.registerTool(
    "why",
    {
      description:
        "Explain why a fact is believed: its source evidence and the full version chain, including superseded and retired versions. Pass a factId from facts or recall.",
      inputSchema: { factId: z.string().min(1) }
    },
    async (args) => json(await backend.why(args as { factId: string }))
  );
  registrar.registerTool(
    "forget",
    {
      description: "Suppress a fact by factKey. The record is retired, not deleted — the audit chain is preserved.",
      inputSchema: { factKey: z.string().min(1) }
    },
    async (args) => json(await backend.forget(args as { factKey: string }))
  );
}

const json = (v: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(v, null, 2) }] });
