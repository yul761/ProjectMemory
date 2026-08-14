import { homedir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import pkg from "../package.json";
import { createEmbeddedBackend } from "./embedded";
import { createHttpBackend } from "./http-backend";
import { resolveScopeName } from "./scope";
import { registerTools } from "./tools";
import type { MemoryBackend } from "./backend";

/** `--data <dir>` and `--url <base>` from `argv` (already sliced past node/script). Missing flags resolve to defaults, not this parser. */
export function parseArgs(argv: string[]): { dataDir?: string; url?: string } {
  const out: { dataDir?: string; url?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--data") out.dataDir = argv[++i];
    else if (argv[i] === "--url") out.url = argv[++i];
  }
  return out;
}

function resolveBackend(args: { dataDir?: string; url?: string }, env: NodeJS.ProcessEnv): MemoryBackend {
  if (args.url) return createHttpBackend({ baseUrl: args.url, env });
  return createEmbeddedBackend({
    dataDir: args.dataDir ?? join(homedir(), ".statecore"),
    scopeName: resolveScopeName(process.cwd(), env),
    env
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const backend = resolveBackend(args, process.env);
  await backend.init();

  const server = new McpServer({ name: "statecore", version: pkg.version });
  registerTools(server, backend);

  await server.connect(new StdioServerTransport());
  console.error(`[statecore-mcp] ready over stdio (${args.url ? `remote ${args.url}` : `embedded ${args.dataDir ?? join(homedir(), ".statecore")}`})`);
}

main().catch((error) => {
  console.error("[statecore-mcp] fatal error", error);
  process.exitCode = 1;
});
