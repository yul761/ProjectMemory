// asciinema demo driver for statecore-mcp.
// Types a scripted narration, but every tool result shown is the REAL output
// of a live statecore-mcp server spawned over stdio (embedded SQLite, no key).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = process.stdout;

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

async function typeLine(text, cps = 28) {
  for (const ch of text) {
    out.write(ch);
    await sleep(1000 / cps + Math.random() * 18);
  }
  out.write("\n");
}

async function prompt(cmd, comment) {
  await sleep(500);
  out.write(`${GREEN}$ ${RESET}`);
  await typeLine(comment ? `${cmd}  ${DIM}# ${comment}${RESET}` : cmd);
  await sleep(250);
}

function show(text) {
  out.write(text.endsWith("\n") ? text : text + "\n");
}

const dataDir = mkdtempSync(join(tmpdir(), "statecore-demo-"));

show(`${BOLD}StateCore — auditable memory for AI agents${RESET}`);
show(`${DIM}every fact carries evidence; forgetting is a logged act, not a delete${RESET}\n`);

await prompt("npx statecore-mcp", "zero config: embedded SQLite, no API key");

const transport = new StdioClientTransport({
  command: "npx",
  args: ["-y", "statecore-mcp", "--data", dataDir],
  cwd: dataDir,
  stderr: "pipe"
});
const client = new Client({ name: "demo", version: "1.0.0" });
await client.connect(transport);
const tools = (await client.listTools()).tools.map((t) => t.name);
show(`${CYAN}[statecore-mcp] ready over stdio (embedded ${dataDir.replace(/^.*statecore-demo.*$/, "~/.statecore")})${RESET}`);
show(`${CYAN}5 tools: ${tools.join("  ")}${RESET}\n`);

async function call(name, args) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// -- remember two facts ------------------------------------------------------
await prompt('remember "Deploy window is Friday afternoons."');
const r1 = await call("remember", { text: "Deploy window is Friday afternoons." });
show(`${DIM}${JSON.stringify(r1)}${RESET}\n`);

await prompt('remember "Postgres 16 is the only supported database."');
const r2 = await call("remember", { text: "Postgres 16 is the only supported database." });
show(`${DIM}${JSON.stringify(r2)}${RESET}\n`);

// -- list facts --------------------------------------------------------------
await prompt("facts");
const groups = await call("facts", {});
let deployFact, deployKey;
for (const g of groups) {
  show(`${BOLD}${g.group}${RESET}`);
  for (const f of g.items) {
    show(`  • ${f.text}  ${DIM}factId=${f.factId.slice(0, 8)}…${RESET}`);
    if (f.text.includes("Friday")) {
      deployFact = f.factId;
      deployKey = f.factKey;
    }
  }
}
show("");

// -- why: provenance ---------------------------------------------------------
await prompt(`why ${deployFact.slice(0, 8)}…`, "where did this belief come from?");
const why = await call("why", { factId: deployFact });
show(`${DIM}${JSON.stringify(why, null, 1)}${RESET}\n`);
await sleep(1200);

// -- forget: audited retirement ---------------------------------------------
show(`${YELLOW}Friday deploys were a mistake. Forget it — with an audit trail.${RESET}`);
await prompt(`forget ${deployKey}`);
const fg = await call("forget", { factKey: deployKey });
show(`${DIM}${JSON.stringify(fg)}  ${RESET}${DIM}# retired, not deleted — snapshot retained${RESET}\n`);

await prompt("facts");
const groups2 = await call("facts", {});
for (const g of groups2) {
  show(`${BOLD}${g.group}${RESET}`);
  for (const f of g.items) show(`  • ${f.text}`);
}
show("");
await sleep(600);
show(`${BOLD}Same store, three surfaces:${RESET}`);
show(`  MCP (any client) · ${CYAN}dsh-statecore${RESET} (DeepSeek Harness plugin) · self-hosted API`);
show(`${DIM}github.com/yul761/StateCore${RESET}`);
await sleep(2000);

await client.close();
process.exit(0);
