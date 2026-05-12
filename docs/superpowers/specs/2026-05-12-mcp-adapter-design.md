# MCP Adapter Design

**Date:** 2026-05-12
**Status:** Approved

## Overview

Add `apps/adapter-mcp/` — a Model Context Protocol server that exposes StateCore memory to Claude Code. Follows existing `apps/adapter-telegram/` pattern. Runs as a local Node process spawned by Claude Code via stdio transport.

## Problem

Claude Code loses all context between sessions. Context window fills on long projects. LLM hallucinates past decisions. Company token budget is finite.

StateCore solves all three but needs an MCP adapter to connect to Claude Code.

## Architecture

```
Claude Code
  └── spawns adapter-mcp (stdio)
        └── HTTP → StateCore API (localhost:3000)
              └── PostgreSQL + Redis
```

The adapter is a thin MCP server. No business logic — all memory logic stays in StateCore.

## Directory Structure

```
apps/adapter-mcp/
├── package.json          # @statecore/adapter-mcp
├── tsconfig.json         # extends ../../tsconfig.base.json
└── src/
    ├── main.ts           # MCP server entry, registers all tools
    ├── env.ts            # Env var parsing (API_URL, TOKEN, USER_ID)
    ├── api-client.ts     # apiFetch with retry (port from adapter-telegram)
    └── scope-manager.ts  # Per-cwd scope resolution
```

## Scope Management

On startup, `scope-manager.ts`:

1. Reads `process.cwd()` — the directory Claude Code is running in
2. Derives scope name: `project:<basename-of-cwd>` (e.g. `project:StateCore`)
3. Calls `GET /scopes` to find existing scope with that name
4. If not found: `POST /scopes` to create it, then `POST /scopes/:id/active`
5. Caches `scopeId` in memory for the process lifetime

This gives each git repo its own isolated memory namespace automatically.

## Tools (5)

### `get_context`
- **API:** `GET /memory/fast-view`
- **Purpose:** Load compressed memory state into Claude's context at start of session
- **When Claude calls it:** Beginning of conversation, or when it needs project background
- **Returns:** Goals, constraints, decisions, open work from StateCore Fast Layer

### `save_turn`
- **API:** `POST /memory/events`
- **Purpose:** Persist conversation content to StateCore memory stream
- **When Claude calls it:** After meaningful exchanges — decisions made, problems solved, context established
- **Payload:** `{ scopeId, type: "stream", source: "claude-code", content: "<summary>" }`

### `recall`
- **API:** `POST /memory/answer`
- **Purpose:** Answer a specific question grounded in stored memory
- **When Claude calls it:** "How did we implement X?", "What was the decision on Y?"
- **Payload:** `{ scopeId, question: "..." }`

### `get_working_state`
- **API:** `GET /memory/working-state`
- **Purpose:** Inspect current structured working memory (active tasks, open issues)
- **When Claude calls it:** When user asks about current work status

### `force_digest`
- **API:** `POST /memory/digest`
- **Purpose:** Manually trigger State Layer consolidation
- **When Claude calls it:** When context is getting large, or user asks to "compress memory"
- **Payload:** `{ scopeId }`

## Environment Variables

| Var | Default | Description |
|-----|---------|-------------|
| `STATECORE_API_URL` | `http://localhost:3000` | StateCore API base URL |
| `STATECORE_TOKEN` | `local-dev-user` | Auth token (x-local-user-token header) |
| `STATECORE_USER_ID` | `mcp-user` | User identity for memory scoping |

## Claude Code Integration

```json
// .claude/settings.json
{
  "mcpServers": {
    "statecore": {
      "command": "node",
      "args": ["C:/StateCore/StateCore/apps/adapter-mcp/dist/main.js"],
      "env": {
        "STATECORE_API_URL": "http://localhost:3000",
        "STATECORE_TOKEN": "local-dev-user"
      }
    }
  }
}
```

For dev: use `tsx` instead of `node dist/main.js`.

## Error Handling

- API unreachable → tool returns error message, does not crash MCP server
- Scope creation fails → surface error to Claude, let it decide how to proceed
- Retry logic: 3 attempts with exponential backoff (port from adapter-telegram)

## Out of Scope

- Telegram feature flags — not needed here
- Embedding/semantic search — uses StateCore's default retrieval
- Multi-user — single local user only
- Publishing to npm — stays in monorepo for now
