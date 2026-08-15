# statecore-mcp

## 0.2.0

> Housekeeping note: 0.1.0–0.1.2 were versioned by hand before Changesets
> took over this package, so their pending changesets were consumed here.
> The entries below marked "initial release", "shebang", and "registry
> metadata" actually shipped in 0.1.0, 0.1.1, and 0.1.2 respectively; the
> genuinely-new 0.2.0 changes are the `statecore-mcp/lib` library entry and
> the stderr logging fix.

### Minor Changes

- [`a7910e1`](https://github.com/yul761/StateCore/commit/a7910e10522cb8c272c8a1804ba8786d9e7e204a) Thanks [@yul761](https://github.com/yul761)! - Add a public library entry, `statecore-mcp/lib`, exposing the embedded and HTTP
  memory backends, scope-name resolution, and an injectable-LLM digest runner
  (`runScopeDigest`), for the dsh-statecore native plugin to reuse as a
  dependency instead of talking to the MCP server over stdio. Bin behavior is
  unchanged.

- [`7b9bfb1`](https://github.com/yul761/StateCore/commit/7b9bfb1626e9005ad72277bd13f613d12174de9a) Thanks [@yul761](https://github.com/yul761)! - Initial release of the zero-deploy MCP memory server

  `statecore-mcp` exposes the StateCore engine as a five-tool MCP server
  (`remember`, `recall`, `facts`, `why`, `forget`) that a host can install and run
  with no separate deployment: an embedded backend opens a single shared SQLite
  database at `~/.statecore/statecore.db`, scoped per project by git toplevel (or
  `STATECORE_SCOPE`). `remember`/`facts`/`why`/`forget` all work keylessly end to
  end; recall and distillation into keyed facts activate once a model key is
  configured, using DeepSeek's "one key, two uses" reasoning-effort control.

  An `--url` mode targets a self-hosted StateCore gateway instead of the embedded
  backend, sharing the same tool surface and evidence-chain guarantees.

### Patch Changes

- [`de0a02e`](https://github.com/yul761/StateCore/commit/de0a02ee0d16d766bb6fe12088bc5f21e2d0758d) Thanks [@yul761](https://github.com/yul761)! - Library logs go to stderr, never stdout

  `@statecore/core`'s logger wrote to fd 1 with no destination set. `core` is
  workspace-private and ships only inlined into `statecore-mcp`'s bundle, so
  every host that talks to `statecore-mcp` over stdio (MCP stdio, dsh's ACP or
  JSON-RPC transports) had log lines corrupting its protocol stream on every
  `recall()`. The logger now binds to fd 2 explicitly.

- [`415bba4`](https://github.com/yul761/StateCore/commit/415bba445bf77532c50ec222f3bc95fa245531e1) Thanks [@yul761](https://github.com/yul761)! - MCP Registry metadata: `mcpName` ownership field and a `server.json`

  The official registry validates that an npm package claims its server name, via
  an `mcpName` property in `package.json` — absent from 0.1.1, so the registry
  would refuse the listing. No behavior change.

- [`071c37f`](https://github.com/yul761/StateCore/commit/071c37fce2fb6ef2bfe99a41896a3c9870bd498e) Thanks [@yul761](https://github.com/yul761)! - Ship the bin with a shebang

  0.1.0's `dist/main.js` had none, so npm's `.bin` shim handed JavaScript to the
  shell and every `npx statecore-mcp` invocation died on
  `use strict: command not found`. Every test had launched the file via
  `node dist/main.js`, which is exactly why nothing caught it; the e2e now execs
  the built file directly, the way the shim does, and pins the shebang line.
