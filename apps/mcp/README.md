# statecore-mcp

Auditable memory for coding agents, over the [Model Context Protocol](https://modelcontextprotocol.io). One process, one SQLite file, no infrastructure, no API key required — `remember` a fact and `why` will show you the evidence and the full version chain, including what it superseded.

`statecore-mcp` is the MCP front end for [StateCore](../../README.md), a self-hosted long-term memory runtime. This package runs the engine embedded (SQLite, in-process) by default, or as a thin client against a full StateCore deployment via `--url`.

## 30-second keyless demo

![statecore-mcp demo: remember, facts, why, forget — all keyless](https://raw.githubusercontent.com/yul761/StateCore/main/apps/mcp/demo/statecore-demo.gif)

Every result in the recording is live tool output — [demo/driver.mjs](demo/driver.mjs) drives a real server over stdio, and `demo/statecore-demo.cast` is the asciinema source.

```bash
npx -y statecore-mcp --data /tmp/statecore-demo
```

That starts the server over stdio with no configuration and no model key. Point any MCP client at it (see host configs below), or drive it directly with the SDK's client for a smoke test. It exposes five tools:

| Tool | Does |
|---|---|
| `remember` | Store a fact. Default path is deterministic (no LLM) and immediate; `consolidate: true` queues it as a conversational event for background distillation |
| `recall` | Retrieve memory relevant to a query, packed into a character budget |
| `facts` | List everything currently believed, grouped, with fact ids |
| `why` | A fact's evidence and its full version chain — the differentiator: not just what is believed, but why, and what it replaced |
| `forget` | Retire a fact by key. The record is kept and marked retired, not deleted |

`remember` → `facts` → `why` → `forget` is the whole loop, and every step of it works with no model key configured.

## Keyless vs. keyed

| Capability | No key | With key (`FEATURE_LLM=true` + `MODEL_API_KEY`) |
|---|---|---|
| `remember` (note path), `facts`, `why`, `forget` | Full — deterministic write, evidence id, audit chain | Same |
| Conversational memory (`remember` with `consolidate: true`) | Event is stored; background distillation into stable facts never runs | Distilled into facts automatically once pending events cross a threshold (default 20), or on startup catch-up |
| Retrieval quality | Keyword matching, plus CJK bigram matching for Chinese/Japanese/Korean text — no semantic search | Same in embedded/lite mode — semantic (pgvector) search is a full-stack capability, only reachable via `--url` against a keyed StateCore deployment, not by holding a key alone |

Nothing behind a key is required for the audit trail to work. A key only turns on distillation of raw conversational events into stable facts, and it does that in the background — it is never on the critical path of a tool call.

## Modes

**Embedded (default).** One SQLite file, one process, all five tools run in-process against `@statecore/core`. No infrastructure. Data lives at `~/.statecore/statecore.db`, or wherever `--data <dir>` points.

**Remote (`--url <base>`).** Talks to a running StateCore deployment's frozen `/v1` HTTP surface instead of an embedded database — see the [API reference](../../docs/api.md). Use this when several agents or machines need to share one memory store, or you already run the full stack (Postgres + pgvector + Redis) and want its retrieval quality. `STATECORE_USER_ID` sets the `x-user-id` sent on every request (default `local`).

Both modes resolve **scope** — the memory partition a project's facts live in — the same way: `git rev-parse --show-toplevel` if the working directory is a git repo, else the working directory itself; `STATECORE_SCOPE` overrides either.

## Host configs

### dsh

dsh starts a configured command; it does not download or install MCP servers. Install the pinned executable first:

```sh
npm install --global statecore-mcp@<version>
```

<!-- Pin <version> to the tested release once published, and add its npm
     tarball SHA (or a source commit SHA) here, matching the per-server pin
     style of deepseek-harness's examples/mcp-memory README. -->

```yaml
# statecore.cordis.yml — a dsh --patch overlay, applied via:
#   dsh web --patch "$PWD/statecore.cordis.yml"
- insert:
    - id: memory-statecore
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: statecore
        transport: stdio
        command: statecore-mcp
        args: []
        cwd: !!js process.cwd()
        env:
          FEATURE_LLM: 'true'
          # dsh strips ambient credential-shaped vars from the CHILD's
          # environment before spawning it; config.env with !!js reads dsh's
          # own process env explicitly instead, so this forwards the key
          # without the child-env stripping ever seeing it and without
          # writing the secret into this YAML file.
          MODEL_API_KEY: !!js process.env.MODEL_API_KEY
          MODEL_BASE_URL: 'https://api.deepseek.com/v1'
          MODEL_NAME: 'deepseek-chat'
```

Omitting `MODEL_API_KEY` (running dsh with it unset in its own environment) silently keeps the server keyless — note-path memory still works; distillation does not. The digest path never sends `reasoning_effort` unless `MODEL_STRUCTURED_OUTPUT_REASONING_EFFORT` is set explicitly, so a DeepSeek key (or any OpenAI-compatible endpoint that rejects the parameter) works with this config as written.

### Claude Code

```bash
claude mcp add statecore -- npx -y statecore-mcp
```

Add a model key for automatic distillation by passing `--env`:

```bash
claude mcp add statecore --env FEATURE_LLM=true --env MODEL_API_KEY=<your-key> --env MODEL_BASE_URL=https://api.deepseek.com/v1 --env MODEL_NAME=deepseek-chat -- npx -y statecore-mcp
```

### Cursor

Add to `.cursor/mcp.json` (project) or your global MCP settings:

```json
{
  "mcpServers": {
    "statecore": {
      "command": "npx",
      "args": ["-y", "statecore-mcp"],
      "env": {
        "FEATURE_LLM": "true",
        "MODEL_API_KEY": "<your-key>",
        "MODEL_BASE_URL": "https://api.deepseek.com/v1",
        "MODEL_NAME": "deepseek-chat"
      }
    }
  }
}
```

Drop the `env` block entirely to run keyless.

## Library entry (`statecore-mcp/lib`)

For embedding the engine in-process instead of talking MCP over stdio — the surface [dsh-statecore](https://github.com/yul761/dsh-statecore) is built on:

- `createEmbeddedBackend` / `createHttpBackend` — the two `MemoryBackend` implementations, with an injectable `digestLlm` (a `DigestChatModel`) replacing the env-derived model on the embedded path
- `resolveScopeName` — the git-root/cwd project-scope rule, shared so co-installed front ends land in the same scope
- `runScopeDigest` — one locked digest pass against an injected chat model
- `MemoryBackend.digestNow()` — a caller-demanded, threshold-1 digest pass with an honest outcome (`{ ran: true }` or `{ ran: false, reason }`), for moments when raw context is about to leave a model's view (a host compacting its conversation). Embedded mode waits out startup catch-up first; `--url` mode reports `unsupported` because the server deployment's worker owns digest scheduling.

## Limitations

- **Lite retrieval is keyword + CJK bigram, not semantic.** The embedded backend runs on SQLite and has no pgvector. `recall` still returns a budgeted digest, believed facts, and matching events, but it will not find a paraphrase with no matching tokens the way the full stack's semantic search can.
- **Distillation needs a key.** Without one, `remember` with `consolidate: true` stores the raw event, but it is never folded into stable facts — `facts`/`why` will not see it until a key is configured and the digest runs (threshold trigger, or startup catch-up).
- **One shared SQLite file per `--data` directory, not per project.** Multiple projects on one machine share `~/.statecore/statecore.db` by default, partitioned by scope; only concurrent writes to the *same* scope from multiple processes are guarded (WAL + a busy timeout + an in-database digest lock for concurrent distillation).
- **`--url` mode's `facts()` output carries no fact-registry id per item** (the frozen `/v1` `MemoryFactsOutput` contract doesn't have one) — `why()` in that mode needs a `factId` sourced from a prior `recall()`'s `factRegistry` or a previous provenance response, not invented from `facts()` alone.

## More

- [StateCore](../../README.md) — the engine this server is a front end for
- [`docs/api.md`](../../docs/api.md) — the frozen `/v1` HTTP contract `--url` mode speaks
- [`STABILITY.md`](../../STABILITY.md) — what "frozen" means for the `/v1` surface
