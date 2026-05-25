# MCP Adapter

`apps/adapter-mcp` is an MCP server that exposes StateCore memory tools to any MCP client (Claude Code, Claude Desktop, etc.).

## Tools

| Tool | Description |
|------|-------------|
| `save_turn` | Save a conversation summary to the current project scope |
| `recall` | Answer a question from stored memory. Defaults to current project scope; pass `scopeId` to query any scope |
| `list_scopes` | List all available scopes with name, goal, and stage. Use before `recall` to find a scope ID |

## Scope Resolution

The adapter resolves which scope to write/read using this priority order:

1. `STATECORE_SCOPE_NAME` environment variable
2. `.statecore` file in the project root — `{ "scope": "scope-name" }`
3. Directory name fallback — `project:<dirname>`

To pin a project to a specific scope, add a `.statecore` file:

```json
{ "scope": "my-project-scope-name" }
```

The `recall` tool also accepts an explicit `scopeId` parameter to query any scope regardless of the current project context. Use `list_scopes` first to find the right ID.

## Configuration

Environment variables (set in `.env` at repo root):

| Variable | Default | Description |
|----------|---------|-------------|
| `STATECORE_API_URL` | `http://localhost:3000` | StateCore API base URL |
| `STATECORE_TOKEN` | `local-dev-user` | Auth token (`x-user-id` header) |
| `STATECORE_USER_ID` | `mcp-user` | User identity for memory writes |
| `STATECORE_SCOPE_NAME` | _(optional)_ | Override scope name for all tools |

## Usage Logging

Every tool call is appended to `mcp-usage-log/usage-YYYY-MM-DD.jsonl` (relative to the API working directory). Fields: `ts`, `tool`, `scopeId`, and tool-specific metadata.

The API exposes today's aggregated counts at `GET /diagnostics/mcp-usage`.

## Running

```bash
# Development
pnpm --filter @statecore/adapter-mcp dev

# Build
pnpm --filter @statecore/adapter-mcp build
```

Claude Code config (`.claude/settings.json` or global):

```json
{
  "mcpServers": {
    "statecore": {
      "command": "node",
      "args": ["<repo>/apps/adapter-mcp/dist/main.js"]
    }
  }
}
```
