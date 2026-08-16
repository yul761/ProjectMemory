# Team memory

One self-hosted StateCore deployment as the shared, auditable project brain for every agent your team runs — DeepSeek Harness sessions, Claude Code, Cursor, CI jobs, and anything else that speaks MCP or HTTP. A fact one teammate's agent learns is recalled by everyone else's, and `why` answers "who taught the team this, and what replaced what" with evidence ids either way.

## The shape

```
teammate A: dsh + dsh-statecore ─┐
teammate B: Claude Code + statecore-mcp ─┤──► your reverse proxy ──► StateCore /v1 (api)
CI job: statecore-mcp --url ─┘                                    ├─ postgres (pgvector)
                                                                  ├─ redis
                                                                  └─ worker (digest scheduling)
```

Every front end resolves the same project scope from its workspace path, so "the same repo" means "the same memory" across machines — the scope key is the scope *name* (the git root path string), which matches when teammates keep a common checkout layout, and can be pinned per project when they don't.

Compared to each machine's embedded SQLite store, the full stack adds semantic retrieval (pgvector), server-side digest scheduling (the `worker` — clients need no model key at all), and one durable audit trail for the whole team.

## 1. Deploy the stack

Follow [deploy.md](../deploy.md) — `docker-compose.prod.yml` brings up `postgres` + `redis` + `migrate` + `api` + `worker`. Set `FEATURE_LLM=true` and a `MODEL_API_KEY` in `.env.production` so the worker distills the team's raw events into stable facts server-side.

**Authentication is yours to add.** The API identifies callers by the plain `x-user-id` header and ships no credential check of its own. Run it on a private network (VPN/tailnet) or put your own authenticating reverse proxy in front; do not expose the bare `api` port to the public internet.

## 2. Point DeepSeek Harness at it

[`dsh-statecore`](https://github.com/yul761/dsh-statecore) talks to the deployment instead of its embedded store when `url` is set:

```yaml
# the plugin's config: block (statecore.cordis.yml / profile patch)
- id: statecore-memory
  name: dsh-statecore
  config:
    url: https://statecore.internal.example
    httpUserId: alice        # who this machine's writes are attributed to
```

Auto-ingest, auto-inject, compaction-triggered distillation, and the five tools all route to the server unchanged. (`digestNow` on compaction reports `unsupported` in this mode — the server's worker owns digest scheduling, so nothing is lost; it is just not client-triggered.)

## 3. Point every MCP host at it

[`statecore-mcp`](https://www.npmjs.com/package/statecore-mcp) serves the same deployment to Claude Code, Cursor, and any other MCP client:

```jsonc
// e.g. Claude Code: .mcp.json
{
  "mcpServers": {
    "statecore": {
      "command": "npx",
      "args": ["-y", "statecore-mcp", "--url", "https://statecore.internal.example"],
      "env": { "STATECORE_USER_ID": "alice" }
    }
  }
}
```

## 4. Prove the loop

From machine A (dsh session): ask the agent to `remember` a decision. From machine B (Claude Code): `facts` lists it; `why` walks its version chain with evidence ids, and each evidence event in the store carries the `x-user-id` that wrote it — who taught the team what stays answerable at the data level. That round trip is the whole feature.

## Scope discipline

- Same repo, same relative layout → scopes match automatically (git-root path).
- Different checkout paths per teammate → keep checkouts consistent, or pin one canonical scope per machine with `STATECORE_SCOPE` for `statecore-mcp` processes (single-project by nature). `dsh-statecore` deliberately ignores that override for per-session scopes — a dsh web process serves several workspaces at once, and a global override would collapse them into one scope — so on dsh the workspace path itself is the scope key.
- `httpUserId`/`STATECORE_USER_ID` is attribution, not authorization — the audit trail records who wrote what; your proxy decides who may connect at all.
