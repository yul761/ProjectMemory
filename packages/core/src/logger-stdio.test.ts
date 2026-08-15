// Regression test for the stdout-pollution defect: a library `logger.info` call
// must never write bytes to stdout, because dsh's ACP/JSON-RPC transports and MCP
// stdio treat stdout as the protocol channel. Spawns a real child process (pino's
// `destination(fd)` opens the raw OS fd, bypassing any in-process `process.stdout`
// monkeypatch), so this proves the actual bytes landing on fd 1 and fd 2.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const probeScript = join(__dirname, "fixtures", "logger-stdio-probe.ts");
const tsxCli = require.resolve("tsx/cli");

describe("logger", () => {
  it("emits info logs to stderr and never to stdout", () => {
    const result = spawnSync(process.execPath, [tsxCli, probeScript], {
      cwd: __dirname
    });

    expect(result.status).toBe(0);
    expect(result.stdout.toString("utf8")).toBe("");
    expect(result.stderr.toString("utf8")).toContain("logger-stdio-probe");
  });
});
