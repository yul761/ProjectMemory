import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createEmbeddedBackend } from "../src/embedded";
import { registerTools } from "../src/tools";

describe("MCP tool surface, keyless via InMemoryTransport", () => {
  const dir = mkdtempSync(join(tmpdir(), "sc-mcp-tools-"));
  const backend = createEmbeddedBackend({ dataDir: dir, scopeName: "/tmp/fake-mcp-project", env: {} as any });
  const server = new McpServer({ name: "statecore", version: "0.0.0-test" });
  const client = new Client({ name: "test-client", version: "0.0.0-test" });

  beforeAll(async () => {
    await backend.init();
    registerTools(server, backend);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  });

  afterAll(async () => {
    await client.close();
    await server.close();
    await backend.close();
  });

  it("lists exactly the five memory tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["facts", "forget", "recall", "remember", "why"]);
  });

  it("remember → facts → why walks a real evidence chain over the protocol", async () => {
    const rememberResult = await client.callTool({ name: "remember", arguments: { text: "We use pnpm, not npm" } });
    const remembered = JSON.parse((rememberResult.content as Array<{ type: string; text: string }>)[0].text);
    expect(remembered).toEqual({ ok: true, mode: "note" });

    const factsResult = await client.callTool({ name: "facts", arguments: {} });
    const groups = JSON.parse((factsResult.content as Array<{ type: string; text: string }>)[0].text) as Array<{
      items: Array<{ factId: string; text: string }>;
    }>;
    const match = groups.flatMap((g) => g.items).find((f) => f.text.includes("pnpm"));
    expect(match).toBeTruthy();

    const whyResult = await client.callTool({ name: "why", arguments: { factId: match!.factId } });
    const prov = JSON.parse((whyResult.content as Array<{ type: string; text: string }>)[0].text);
    expect(prov.fact.content).toContain("pnpm");
    expect(prov.chain.length).toBeGreaterThanOrEqual(1);
  });
});
