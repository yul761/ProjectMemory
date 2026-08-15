---
"statecore-mcp": minor
---

Initial release of the zero-deploy MCP memory server

`statecore-mcp` exposes the StateCore engine as a five-tool MCP server
(`remember`, `recall`, `facts`, `why`, `forget`) that a host can install and run
with no separate deployment: an embedded backend opens a single shared SQLite
database at `~/.statecore/statecore.db`, scoped per project by git toplevel (or
`STATECORE_SCOPE`). `remember`/`facts`/`why`/`forget` all work keylessly end to
end; recall and distillation into keyed facts activate once a model key is
configured, using DeepSeek's "one key, two uses" reasoning-effort control.

An `--url` mode targets a self-hosted StateCore gateway instead of the embedded
backend, sharing the same tool surface and evidence-chain guarantees.
