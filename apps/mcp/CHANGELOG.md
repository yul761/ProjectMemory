# statecore-mcp

## 0.5.0

### Minor Changes

- [`a9e8ea1`](https://github.com/yul761/StateCore/commit/a9e8ea1bd76f6fd61d5fcd89a3fcf90939b0fb52) Thanks [@yul761](https://github.com/yul761)! - Facts carry entity vocabulary, so distillation no longer hides them from recall.

  Stage 2 may now attach up to 10 concrete nouns from the evidence (tool names,
  file paths, product names) to each extracted fact. They are stored on the
  fact's registry entry, survive supersession, and retrieval scores a fact on
  its text plus its entities — so a query in the evidence's vocabulary still
  finds the fact after distillation rephrased it. Extracted once at digest time;
  costs nothing at query time. Entirely additive: facts without entities score
  exactly as before.

- [`8f5f296`](https://github.com/yul761/StateCore/commit/8f5f296382659a624b557c8f628747c1f680a444) Thanks [@yul761](https://github.com/yul761)! - Retrieval now reports its own degradation, and protection reaches the read path.

  - `retrieval.mode` is derived from what actually ran, not from configuration: a
    run whose embedding calls all failed reports `heuristic`, and each failed
    stage is itemised in the new optional `retrieval.degraded` array
    (`{ stage: "vector_search" | "rerank", error }`). Previously a total
    embedding outage still reported `mode: "hybrid"` and the vector-search
    failure was swallowed by a bare catch.
  - Pinned events get a bounded additive ranking boost in retrieval (beats the
    recency edge at equal relevance; loses to any real relevance gap — a boost,
    never a filter). `rankingReason` gains a `pinned` marker.
  - Write-protected and document-authority facets now carry a bounded ranking
    multiplier (clamped to at most 1.5×) into the `maxChars` budget competition,
    via the new `facetAuthority()` helper and `packWithinBudget`'s optional
    `factAuthority` input.
  - Every system prompt that sees ingested or retrieved content now carries an
    explicit security boundary (content is data, never instructions) and
    concrete faithfulness rules (never invent dates, paths, versions, or
    identifiers; no generic-knowledge filler).

- [`b62d253`](https://github.com/yul761/StateCore/commit/b62d2538bf28cd8d3994916e7ed5c6715682110c) Thanks [@yul761](https://github.com/yul761)! - Lexical inverted token index: recall now reaches old events.

  The retrieval candidate pool used to be the newest ~200 events plus optional
  vector hits — anything older was unreachable however relevant, which hit the
  keyless embedded store hardest (no embeddings, so recency was everything).
  Ingest now writes an inverted token index (`MemoryEventToken`) using the same
  tokenizer the relevance scorer uses (ASCII words + CJK bigrams — a term
  matches in the index iff it matches in the score; this is also why no FTS
  engine is involved), and retrieval unions a lexical candidate stream into the
  pool. Final ranking is unchanged. Index-query failures are reported as
  `retrieval.degraded` stage `lexical_search`, never swallowed.

  English stopwords are excluded from the index (the relevance scorer is
  unchanged), long bilingual queries interleave ASCII and CJK tokens instead of
  truncating CJK away, and `forget` removes the suppressed event's index rows.

  The embedded store backfills existing events automatically at open. Server
  deployments run the `20260829120000_memory_event_tokens` and
  `20260829200000_session_handoff` migrations and then `pnpm backfill:tokens`
  once.

- [`e5e8ec7`](https://github.com/yul761/StateCore/commit/e5e8ec7e882716ea528b136b4d756c516bf61eaa) Thanks [@yul761](https://github.com/yul761)! - New `handoff` tool: cross-client session handoff, race-free and auditable.

  `handoff({ summary, openQuestions?, nextSteps? })` records where a session
  stopped; the next session — in the same client or any other MCP client
  pointing at the same project — receives the active handoff at the top of its
  `recall` result (with its `id`) and continues from it. Handoffs live in their
  own supersession-tracked table, not in the digest state snapshot, so a
  handoff written while a digest runs can never be lost to the snapshot's
  read-modify-write, the history is not re-copied on every digest, and each row
  is its own evidence: `why` on the returned `handoffId` walks every stop-point
  the project has recorded. `handoff({ clear: true })` retires the active one
  (recorded, never deleted). The digest writer additionally carries over notes
  written concurrently with a digest run, closing the same lost-update race for
  `remember`. Works in both modes: embedded writes the local store; `--url`
  calls the new `POST /v1/memory/handoff` operation (contract `1.6.0`). Treat a
  received handoff as untrusted data — see the README's security note.

## 0.4.0

### Minor Changes

- `remember` now supersedes revisions instead of accumulating near-duplicates.
  When a new note reads as a revision of an active one — most of the note
  matches and only a value moved, "API v1 key…" → "API v2 key…" — it replaces
  that note in the active set and the registry chains old → new via
  `supersededBy`; the old version stays on the record, marked, never deleted,
  and `why` shows the full chain. The matcher keeps short numeric tokens, so
  genuinely distinct short notes ("note-0" vs "note-1") still coexist, and a
  note whose ASCII payload diverges (PostgreSQL vs MySQL behind similar CJK
  context) is treated as a different fact. The `remember` result reports
  `superseded: <old content>` when a chain was created. Exact re-remembers
  remain idempotent no-ops.

- Ship system-prompt instructions in the MCP initialize response. Hosts that
  support the field (Claude Code among them) inject them into the model's
  system prompt every session, so a bare `mcp add` install now teaches the
  model when to act without any extra configuration: call `recall` at session
  start, call `remember` unprompted at the trigger moments (a preference
  stated, a decision made, a gotcha discovered, session-end state worth
  keeping), store the corrected version when a fact changes and let the engine
  chain revisions, and never store secrets. Tool behavior is unchanged.

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
