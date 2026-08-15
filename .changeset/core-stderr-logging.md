---
"statecore-mcp": patch
---

Library logs go to stderr, never stdout

`@statecore/core`'s logger wrote to fd 1 with no destination set. `core` is
workspace-private and ships only inlined into `statecore-mcp`'s bundle, so
every host that talks to `statecore-mcp` over stdio (MCP stdio, dsh's ACP or
JSON-RPC transports) had log lines corrupting its protocol stream on every
`recall()`. The logger now binds to fd 2 explicitly.
