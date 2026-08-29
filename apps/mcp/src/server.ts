import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools";
import type { MemoryBackend } from "./backend";

/**
 * Injected into the host's system prompt via the MCP initialize response
 * (`instructions`). This is the only always-present prompt surface a bare
 * `mcp add` install has: tool descriptions are consulted per-call, but
 * instructions are read before the session starts — so the WHEN of
 * remember/recall lives here, and the HOW of each tool stays in its
 * description. Keep it compact (checked by tests/instructions.test.ts): every
 * session pays for these tokens.
 */
export const SERVER_INSTRUCTIONS = [
  "StateCore is this project's persistent memory across sessions.",
  "At the start of a session — and before relying on past context — call `recall` to load what is already known.",
  "Call `remember` proactively, without being asked, whenever one of these happens:",
  "- the user states a durable preference, or corrects you on one;",
  "- a decision is made (architecture, tooling, approach), including reversals of earlier decisions;",
  "- a non-obvious constraint, gotcha, or environment fact is discovered the hard way;",
  "- work ends in a state the next session must know about — for that, call `handoff` (summary, open questions, next steps) instead; `recall` hands it to the next session, so continue from a handoff when one appears.",
  "Store one self-contained fact per call, under 500 characters; pass consolidate: true for longer conversational context.",
  "When a fact changes, simply remember the corrected version — the engine detects revisions and keeps the old version on an auditable chain (`why` shows a fact's evidence and history; `forget` retires without deleting).",
  "Never store secrets, credentials, or tokens."
].join("\n");

/** The one place the MCP server is assembled — main.ts serves exactly this. */
export function createServer(backend: MemoryBackend, version: string): McpServer {
  const server = new McpServer({ name: "statecore", version }, { instructions: SERVER_INSTRUCTIONS });
  registerTools(server, backend);
  return server;
}
