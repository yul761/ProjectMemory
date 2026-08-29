---
"statecore-mcp": minor
---

New `handoff` tool: cross-client session handoff on the audit chain.

`handoff({ summary, openQuestions?, nextSteps? })` records where a session
stopped; the next session — in the same client or any other MCP client
pointing at the same project — receives the active handoff at the top of its
`recall` result and continues from it. A handoff is a registry fact under a
reserved facet, so each one supersedes the previous through the same chain
every other fact uses: `why` can walk every stop-point the project has
recorded. The server instructions now tell agents to prefer `handoff` when
work ends in a state the next session must know about. Embedded mode only;
`--url` mode reports `unsupported` until `/v1` grows a handoff operation.
