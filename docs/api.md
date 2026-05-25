# API Surface

All endpoints require an identity header:

- `x-user-id` for developer/self-host use
- `x-telegram-user-id` for adapter usage

Server stores a normalized `identity` per user (for example `user:...`,
`local:...`, `telegram:...`), while `telegramUserId` is reserved for raw
Telegram IDs used by reminder delivery.

This API is easiest to understand if you group it into three layers:

- public runtime surface
- debug surface
- internal control surface

If you are building a demo app or future web UI, stay on the public runtime
surface unless you are explicitly building an inspector or operator tool.

For the intended boundary, see `docs/product-surface.md`.
For code-level reuse, `packages/contracts/src/index.ts` now also exports grouped
route constants:

- `PublicRuntimeRoutes`
- `DebugSurfaceRoutes`
- `InternalControlRoutes`

## Public Runtime Surface

These are the endpoints a chat UI, agent runtime, or external integration should
prefer.

### Health And Scopes

- `GET /health`
  - returns `status`
  - also exposes active model-role names and runtime config used by local smoke
    and benchmark tooling
- `POST /scopes`
  - create a scope
- `GET /scopes`
  - list scopes
- `POST /scopes/:id/active`
  - mark a scope as active for the current identity
- `GET /state`
  - returns the currently active scope id for the current identity

### Runtime And Layer Inspection

- `POST /memory/runtime/turn`
  - body:
    `{ scopeId, message, source?, policyProfile?, policyOverrides?, writeTier?, documentKey?, digestMode?, metadata? }`
  - runs the assistant runtime session flow
  - returns:
    `{ answer, answerMode, writeTier, digestTriggered, workingMemoryVersion?, stableStateVersion?, usedFastLayerContextSummary?, retrievalPlan?, layerAlignment?, warnings?, notes?, evidence }`
  - `answerMode` is:
    - `direct_state_fast_path`
    - `llm_fast_path`
  - `retrievalPlan.mode` is:
    - `none`
    - `light`
    - `full`
- `GET /memory/working-state?scopeId=`
  - returns latest Working Memory snapshot plus compiled Working Memory view
- `GET /memory/stable-state?scopeId=`
  - returns latest authoritative State Layer snapshot plus compiled State Layer
    view
- `GET /memory/fast-view?scopeId=&message=`
  - returns compiled Fast Layer context for the current message
  - also returns `retrievalPlan`
- `GET /memory/layer-status?scopeId=&message=`
  - returns aggregated three-layer diagnostics
  - includes:
    - `workingMemoryVersion`
    - `stableStateVersion`
    - `workingMemoryView`
    - `stableStateView`
    - `fastLayerSummary`
    - `retrievalPlan`
    - `layerAlignment`
    - `freshness`
    - `warnings`

## Debug Surface

These endpoints are useful for diagnosis, operator tooling, and inspector views.
They are valid to expose in a developer console, but they should not be the main
dependency of a product demo.

### Queue And Usage Diagnostics

- `GET /diagnostics/queues`
  - returns active, waiting, and failed job counts for `digest` and `workingMemory` queues
  - works in both full mode (BullMQ/Redis) and lite mode (in-memory, always returns zeros)
- `GET /diagnostics/mcp-usage`
  - returns today's MCP tool call counts aggregated from the JSONL usage log
  - log file: `mcp-usage-log/usage-YYYY-MM-DD.jsonl` (written by `adapter-mcp`)
  - returns `{ today, counts: { tool_name: count } }`

### Retrieval And Answer Inspection

- `POST /memory/retrieve`
  - body: `{ scopeId, query, limit? }`
  - returns last digest plus recent events
  - `retrieval` metadata includes:
    - `mode`
    - `embeddingRequested`
    - `embeddingConfigured`
    - `candidateCount`
    - `returnedCount`
    - `matches[]` with source type, scores, and `rankingReason`
- `POST /memory/answer`
  - body: `{ scopeId, question }`
  - requires `FEATURE_LLM=true`
  - returns `{ answer, evidence? }`
  - `evidence` mirrors runtime grounding structure

### Raw Memory And State Inspection

- `GET /memory/events?scopeId=&limit=&cursor=`
  - returns raw ingested events
- `GET /memory/digests?scopeId=&limit=&cursor=&rebuildGroupId=`
  - returns digest jobs and outputs
- `GET /memory/state?scopeId=`
  - returns latest `DigestStateSnapshot` for replay and audit use
- `GET /memory/state/history?scopeId=&limit=&rebuildGroupId=`
  - returns recent `DigestStateSnapshot` items for replay and audit use

### Reminders

- `POST /reminders`
- `GET /reminders?status=&limit=&cursor=`
- `POST /reminders/:id/cancel`

## Internal Control Surface

These endpoints drive the memory system itself and are best treated as internal
or operator-only operations.

- `POST /memory/events`
  - body: `{ scopeId, type: 'stream'|'document', source?, key?, content }`
  - `document` requires `key`
- `POST /memory/digest`
  - body: `{ scopeId }`
  - enqueues a State Layer digest job
  - requires `FEATURE_LLM=true`
- `POST /memory/digest/rebuild`
  - body: `{ scopeId, from?, to?, strategy?: 'full'|'since_last_good' }`
  - enqueues `rebuild_digest_chain`
  - returns `{ jobId, rebuildGroupId }`

These are the right tools for:

- importing events
- forcing digests in local smoke tests
- replaying or rebuilding history
- benchmark and CI workflows

They are not the ideal main path for a public web demo.

## Product Smoke

For a quick end-to-end runtime validation with inspectable layer metadata:

```bash
pnpm smoke:runtime
```

That smoke checks:

- `POST /memory/digest`
- `GET /memory/working-state`
- `GET /memory/stable-state`
- `GET /memory/layer-status`
- scope creation
- event ingestion
- `POST /memory/runtime/turn`
- presence of `retrievalPlan` and `answerMode`
- runtime `layerAlignment.goalAligned`
- `freshness.workingMemoryCaughtUp`
- `freshness.stableStateCaughtUp`
- empty runtime `warnings` for a clean smoke scope
- empty diagnostic `warnings` for a clean smoke scope

For a broader local product verification pass:

```bash
pnpm smoke
```

For GitHub-hosted LLM runtime verification, the repository also includes a
manual `Runtime Smoke` workflow under `.github/workflows/runtime-smoke.yml`.

For a quick local diagnosis of runtime configuration, active scope, layer
versions, and fast-view retrieval planning:

```bash
pnpm dev:cli -- layer-status
pnpm dev:cli -- doctor
```

For the same diagnosis plus a real runtime probe with latency, `answerMode`, and
`retrievalPlan`:

```bash
pnpm dev:cli -- doctor --probe-turn
```

For a pass/fail assertion over the same diagnostics:

```bash
pnpm dev:cli -- doctor --probe-turn --assert-clean
```

For CI or automation, pin the CLI to a known user id so it reads the intended
scope:

```bash
STATECORE_CLI_USER_ID=runtime-ci-user pnpm dev:cli -- doctor --probe-turn --assert-clean
```

To persist the diagnosis as a JSON artifact:

```bash
STATECORE_CLI_USER_ID=runtime-ci-user pnpm dev:cli -- doctor --probe-turn --assert-clean --output-file runtime-doctor.json
```

When you run that command from the repo root, `runtime-doctor.json` is written
relative to the invocation directory, so local smoke and CI can pick it up
directly from the repository root.

## Layer Diagnostics

The `doctor` summary now reads from `GET /memory/layer-status` and includes
`layerAlignment`, which reports:

- whether Working Memory and Stable State agree on the current goal
- how many constraints overlap
- how many decisions overlap
- whether the scope looks ready for direct-state fast-path reads
- whether diagnostics see suspicious issues such as structured-field leakage in
  the goal

`layer-status.freshness` reports:

- the timestamp of the latest ingested event
- the latest Working Memory update time
- the latest Stable State creation time
- lag in milliseconds from the event stream to each layer
- whether each layer is currently considered caught up

`doctor --assert-clean` exits non-zero when:

- the API is not healthy
- `FEATURE_LLM` is off
- there is no diagnosed scope
- `layerAlignment.goalAligned` is false
- `layerAlignment.fastPathReady` is false
- Working Memory is not caught up
- Stable State is not caught up
- layer warnings are present
- the runtime probe returns warnings or missing answer metadata

The manual `Runtime Smoke` GitHub workflow uploads `runtime-doctor.json` as an
artifact.

## Example

```bash
curl -X POST "$API_BASE_URL/scopes" \
  -H 'x-user-id: dev-user' \
  -H 'Content-Type: application/json' \
  -d '{"name":"Demo"}'

curl -X POST "$API_BASE_URL/memory/runtime/turn" \
  -H 'x-user-id: dev-user' \
  -H 'Content-Type: application/json' \
  -d '{"scopeId":"SCOPE_ID","message":"What is the current goal?"}'

curl "$API_BASE_URL/memory/layer-status?scopeId=SCOPE_ID&message=What%20is%20the%20current%20goal%3F" \
  -H 'x-user-id: dev-user'
```
