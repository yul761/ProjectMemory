// The MCP initialize response carries an `instructions` string that hosts
// (Claude Code among them) inject into the model's system prompt for every
// session. That field is the only always-present surface a bare `mcp add`
// install has for teaching the model WHEN to call remember/recall — tool
// descriptions are consulted per-call, instructions are read up front. This
// suite pins that the server actually ships them and that the text keeps its
// load-bearing content.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createEmbeddedBackend } from "../src/embedded";
import { createServer, SERVER_INSTRUCTIONS } from "../src/server";

describe("server instructions over the protocol", () => {
  const dir = mkdtempSync(join(tmpdir(), "sc-mcp-instructions-"));
  const backend = createEmbeddedBackend({ dataDir: dir, scopeName: "/tmp/fake-mcp-project", env: {} as any });
  const client = new Client({ name: "test-client", version: "0.0.0-test" });
  let server: ReturnType<typeof createServer>;

  beforeAll(async () => {
    await backend.init();
    server = createServer(backend, "0.0.0-test");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  });

  afterAll(async () => {
    await client.close();
    await server.close();
    await backend.close();
  });

  it("initialize returns the instructions verbatim", () => {
    expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
  });

  it("createServer registers the six tools (main.ts builds through it)", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["facts", "forget", "handoff", "recall", "remember", "why"]);
  });

  it("instructions carry the trigger moments, not just a description", () => {
    const text = SERVER_INSTRUCTIONS;
    // The read side: recall at session start / before relying on past context.
    expect(text).toMatch(/recall/);
    // The write side: remember proactively, with named trigger moments.
    expect(text).toMatch(/remember/);
    expect(text).toMatch(/decision|preference/i);
    // Revisions are handled by the engine — the model should not hedge.
    expect(text).toMatch(/why|chain|revision/i);
    // Safety line.
    expect(text).toMatch(/secret|credential/i);
    // System-prompt budget: instructions are injected into every session, so
    // they must stay compact. Cap well under a screenful.
    expect(text.length).toBeLessThan(1200);
  });
});
