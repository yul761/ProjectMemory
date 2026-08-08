# API Surface

All endpoints require an identity header:

- `x-user-id` for developer/self-host use

This API is easiest to understand if you group it into three layers:

- public runtime surface
- debug surface
- internal control surface

If you are building an integration or operator tool, stay on the public runtime
surface unless you are explicitly building an inspector or operator tool.

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
  - log file: `mcp-usage-log/usage-YYYY-MM-DD.jsonl`
  - returns `{ today, counts: { tool_name: count } }`

### Retrieval And Answer Inspection

- `POST /memory/retrieve`
  - body: `{ scopeId, query, limit?, maxChars? }`
  - returns last digest plus recent events
  - `retrieval` metadata includes:
    - `mode`
    - `embeddingRequested`
    - `embeddingConfigured`
    - `candidateCount`
    - `returnedCount`
    - `matches[]` with source type, scores, and `rankingReason`

`maxChars`(可选,正整数)声明本次调用愿意在记忆上花费的字符预算。传了它,
StateCore 会在预算内装填并在 `retrieval.budget` 里交代砍掉了什么;不传则行为
与本字段引入前完全一致。

装填顺序是 digest → 事实 → events。digest 是原子的(装不下就整个不装)。事实
最多占 `maxChars` 的 40%,以保证原始证据总有位置;这个比例是常数,不可通过请求
调整。条目一律整条装入,装不下的会被跳过,但装填不会就此停止 —— 排在后面的较小
条目仍有机会进入。

事实的排序只在传了 `maxChars` 时发生:有 `query` 时按相关性,无 `query` 时按
confidence 再按新近度。

`retrieval.budget.droppedCounts` 永远是精确计数;`retrieval.budget.dropped`
是上限 100 条的明细,被略去的条数写在 `itemsOmitted`。

预算以**字符**而非 token 计:token 数是模型特定的,StateCore 不假装知道调用方
用的是哪个 tokenizer。

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

## Layer Diagnostics

`GET /memory/layer-status` provides aggregated three-layer diagnostics that
includes `layerAlignment`, which reports:

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

A clean diagnostic state requires:

- the API is healthy
- `FEATURE_LLM` is enabled
- `layerAlignment.goalAligned` is true
- `layerAlignment.fastPathReady` is true
- Working Memory is caught up
- Stable State is caught up
- no layer warnings are present
- runtime probe returns no warnings and complete answer metadata

The manual `Runtime Smoke` GitHub workflow uploads diagnostics as an artifact.

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

## API versioning (/v1)

StateCore exposes a **frozen public API subset** under the `/v1` prefix. External
layers (the hosted version, the GPT-API integration layer) should depend ONLY on
`/v1`. Every `/v1` endpoint is also served at its legacy unversioned path for
backward compatibility; existing integrations continue to use the legacy paths.

### Frozen public subset

| Method | `/v1` path |
|---|---|
| POST | `/v1/scopes` |
| GET | `/v1/scopes` |
| POST | `/v1/scopes/:id/active` |
| GET | `/v1/state` |
| POST | `/v1/memory/events` |
| POST | `/v1/memory/retrieve` |
| POST | `/v1/memory/answer` |
| POST | `/v1/memory/digest` |
| POST | `/v1/memory/runtime/turn` |
| POST | `/v1/reminders` |
| GET | `/v1/reminders` |
| POST | `/v1/reminders/:id/cancel` |
| GET | `/v1/health` |

The source of truth is `PublicV1Contracts` in `@statecore/contracts`, guarded by
the snapshot test `apps/api/src/public-v1-contract.snapshot.test.ts`.

### Compatibility rules (additively-compatible freeze)

For the public subset:

1. Existing fields are never removed, renamed, or retyped.
2. New fields are always optional — never newly required.
3. Enums are open sets; clients must tolerate unknown values.

The snapshot test fails on any change to the surface. An intentional,
additive-only change is accepted by regenerating the snapshot
(`pnpm --filter @statecore/api test -- public-v1-contract -u`). A
removal/rename/retype/required-addition is a breaking change — do not ship it
under `/v1`.

> **Diagnostic fields are not frozen.** `POST /v1/memory/retrieve`,
> `/v1/memory/answer`, and `/v1/memory/runtime/turn` return additional
> diagnostic/ranking fields (e.g. `retrieval`, `evidence`, `layerAlignment`,
> `retrievalPlan`) that are **not** part of the frozen contract and may change
> without notice. Only the stable top-level fields of these endpoints are frozen.

### Not part of `/v1`

All other endpoints (diagnostics, `fast-view`, `layer-status`, `working-state`,
`stable-state`, `state/history`, `relationship-context`, `check-contradiction`,
`embed/backfill`, `digest/rebuild`, `digests`, the `GET /memory/events` list,
`scopes/:id/webhook`, demo, metrics) are **internal**: unversioned, legacy-path
only, and may change without notice.
