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

  it("lists exactly the six memory tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["facts", "forget", "handoff", "recall", "remember", "why"]);
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

  // The `ToolRegistrar` cast in tools.ts narrows registerTool's *compile-time* view
  // to sidestep a TS2589 blowup (see tools.ts's doc comment); these cases prove the
  // real zod schemas registered underneath still enforce their constraints at the
  // wire boundary. The SDK (mcp.js#validateToolInput) never throws a JSON-RPC error
  // for a schema failure — it catches the McpError and returns a normal
  // `CallToolResult` with `isError: true`, so `client.callTool` resolves rather
  // than rejects; assert that exact shape instead of a generic "was rejected".
  it("rejects remember with empty text over the protocol (min(1) violation)", async () => {
    const result = await client.callTool({ name: "remember", arguments: { text: "" } });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("Invalid arguments for tool remember");
  });

  it("rejects remember with text over 2000 chars over the protocol (max(2000) violation)", async () => {
    const result = await client.callTool({ name: "remember", arguments: { text: "x".repeat(2001) } });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("Invalid arguments for tool remember");
  });

  it("rejects why with a missing factId over the protocol (required field)", async () => {
    const result = await client.callTool({ name: "why", arguments: {} });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("Invalid arguments for tool why");
  });

  // Uniformity fix: HTTP mode's server enforces a 500-char cap on the note path
  // (AddNoteInput.max(500), packages/contracts/src/index.ts) that the embedded
  // note path had no equivalent for, so the same `remember` call used to behave
  // differently per backend. `rememberSchema`'s `superRefine` in tools.ts now
  // rejects it uniformly, before either backend is ever called.
  it("rejects remember with 600-char text and no consolidate flag: note path is capped at 500", async () => {
    const result = await client.callTool({ name: "remember", arguments: { text: "n".repeat(600) } });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("notes are capped at 500 characters; pass consolidate: true for longer conversational content");
  });

  it("accepts remember with 600-char text when consolidate: true (event path has no 500-char cap)", async () => {
    const result = await client.callTool({ name: "remember", arguments: { text: "n".repeat(600), consolidate: true } });
    expect(result.isError).toBeFalsy();
    const remembered = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text);
    expect(remembered).toEqual({ ok: true, mode: "event" });
  });
});
