---
"statecore-mcp": minor
---

Add a public library entry, `statecore-mcp/lib`, exposing the embedded and HTTP
memory backends, scope-name resolution, and an injectable-LLM digest runner
(`runScopeDigest`), for the dsh-statecore native plugin to reuse as a
dependency instead of talking to the MCP server over stdio. Bin behavior is
unchanged.
