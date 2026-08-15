---
"statecore-mcp": patch
---

MCP Registry metadata: `mcpName` ownership field and a `server.json`

The official registry validates that an npm package claims its server name, via
an `mcpName` property in `package.json` — absent from 0.1.1, so the registry
would refuse the listing. No behavior change.
