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
- `DELETE /scopes/:id`
  - cascade-delete a scope and all its data; erasure is frozen because it is the
    one operation a caller cannot verify by asking again later
- `GET /state`
  - returns the currently active scope id for the current identity

### Facts, Provenance And Ontology

The audit surface — the endpoints that make the memory checkable rather than
merely stored. All are frozen under `/v1`.

- `GET /memory/facts?scopeId=`
  - grouped, displayable, forgotten-filtered facts for a scope
- `GET /memory/facts/:factId/provenance?scopeId=`
  - a fact's evidence plus its full version chain, walkable from any version in
    it — the id from a retrieve response works directly
- `POST /memory/facts/forget`
  - body: `{ scopeId, factKey }`
  - suppresses the fact and soft-suppresses its evidence event; the registry
    entry is retired, not deleted, and the fact is pruned before the next digest
    generates so a reworded version cannot resurface
- `POST /memory/notes`
  - body: `{ scopeId, text }` (max 500 chars)
  - deterministic durable note writer with exact-match dedup
- `POST /memory/handoff`
  - body: `{ scopeId, summary, openQuestions?, nextSteps? }`
  - records where a session stopped as a supersession-tracked registry fact;
    the next session (any client against the same scope) receives the active
    handoff in retrieve's `handoff` field and can walk earlier stop-points via
    provenance
- `GET /memory/digests/:digestId/selection`
  - what that digest kept, and what it discarded with reasons; `null`-era digests
    predate the log and return empty arrays
- `GET /facet-pack?scopeId=`
  - the active facet ontology. Resolved per scope from its template, overridden
    by an account-level pack; without `scopeId` it answers for the account
- `GET /memory/relationship-context/:scopeId`
  - what a caller needs to open a conversation that sounds like it remembers the
    person; `personaPrompt` in the live response is deliberately outside the
    frozen contract

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
StateCore 会在预算内装填并在响应顶层的 `budget` 字段里交代砍掉了什么;不传则
行为与本字段引入前完全一致。`budget` 是顶层字段而非嵌套在 `retrieval` 里 ——
它描述的是整个响应是否装得下,而不是某个排序诊断,而 `retrieval` 在无 `query`
时本就不存在,预算字段不能依赖一个可能不存在的容器。

装填顺序是 digest → 事实 → events。digest 是原子的(装不下就整个不装)。事实
最多占 `maxChars` 的 40%,以保证原始证据总有位置;这个比例是常数,不可通过请求
调整。条目一律整条装入,装不下的会被跳过,但装填不会就此停止 —— 排在后面的较小
条目仍有机会进入。

事实的排序只在传了 `maxChars` 时发生:有 `query` 时按相关性,无 `query` 时按
confidence 再按新近度。

`budget.droppedCounts` 永远是精确计数;`budget.dropped`
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

The subset is **22 operations across 20 paths** — `/v1/scopes` and
`/v1/reminders` each carry both a `GET` and a `POST`. Count operations when
checking against `PublicV1Contracts`, and paths when checking against
`openapi.json`; both tests pin both numbers.

> **Serving a path under `/v1` is not the same as freezing it.** This has now
> happened twice: three endpoints joined the subset in `1.4.0` after months under
> the prefix without being in `PublicV1Contracts`, and three more — the audit
> readers — in `1.5.0`. The snapshot guard sees only what the registry declares,
> so an unregistered handler at `/v1` advertises a promise the surface does not
> make, and no caller can tell from the outside. If you dual-mount a handler at
> `/v1`, either register it here or say plainly why it is exempt.
>
> "Free to evolve while the design is young" is the reasoning that produced both
> rounds, and it expires quietly: by the time a consumer ships against the
> endpoint the shape is load-bearing whether or not anything says so. Freezing
> late costs a version bump; freezing never costs a caller a silent break.

### Frozen public subset

| Method | `/v1` path |
|---|---|
| POST | `/v1/scopes` |
| GET | `/v1/scopes` |
| DELETE | `/v1/scopes/:id` |
| POST | `/v1/scopes/:id/active` |
| GET | `/v1/state` |
| POST | `/v1/memory/events` |
| POST | `/v1/memory/retrieve` |
| POST | `/v1/memory/answer` |
| POST | `/v1/memory/digest` |
| GET | `/v1/memory/digests/:digestId/selection` |
| POST | `/v1/memory/runtime/turn` |
| GET | `/v1/memory/facts` |
| GET | `/v1/memory/facts/:factId/provenance` |
| POST | `/v1/memory/facts/forget` |
| GET | `/v1/facet-pack` |
| POST | `/v1/memory/notes` |
| POST | `/v1/memory/handoff` |
| GET | `/v1/memory/relationship-context/:scopeId` |
| POST | `/v1/reminders` |
| GET | `/v1/reminders` |
| POST | `/v1/reminders/:id/cancel` |
| GET | `/v1/health` |

The source of truth is `PublicV1Contracts` in `@statecore/contracts`, guarded by
the snapshot test `apps/api/src/public-v1-contract.snapshot.test.ts`. This table
is guarded too — `docs-frozen-subset.test.ts` parses it and fails if it drifts
from the registry, which it silently did for three months after the `1.1.0`
endpoints landed.

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

### Versioning the contract

Three different version numbers describe this repository and they answer
different questions. Conflating them is the usual source of confusion:

| number | where | what it answers |
|---|---|---|
| package versions | `packages/*/package.json` | which build of this package is installed |
| release tag | `git tag`, e.g. `v1.5.0` | what shipped, and when |
| **`info.version`** | the generated OpenAPI document | **how current is the contract you are holding** |

`info.version` follows the contract, not the code:

1. **MINOR on every additive change** — a new endpoint, a new optional field.
   Bump it in `apps/api/src/openapi.ts` in the same commit that regenerates the
   snapshots.
2. **PATCH for a documentation-only correction** — a clarified description, a
   fixed example, with no change to the shape.
3. **MAJOR never.** A breaking change gets a new path prefix (`/v2`), which is
   the entire meaning of `/v1`. If you find yourself wanting `2.0.0` here, what
   you actually want is a new prefix.

Narrowing what is *declared* frozen — moving a diagnostic field out of
`PublicV1Contracts` — is not a version-bearing change: it changes the promise's
scope, not the runtime. Note it in the changeset instead.

History: `1.0.0` at the freeze, `1.1.0` for `GET /v1/memory/facts` and
`POST /v1/memory/facts/forget`, `1.2.0` for the optional `pinned` field on event
input, `1.3.0` for `maxChars` and the top-level `budget` on retrieve, `1.4.0` for
`POST /v1/memory/notes`, `GET /v1/memory/relationship-context/:scopeId`, and
`DELETE /v1/scopes/:id` — three endpoints already live under `/v1` and already
depended on in production, brought under the guard. `1.5.0` brings in the three
audit readers on the same grounds: `GET /v1/memory/facts/:factId/provenance`,
`GET /v1/memory/digests/:digestId/selection`, and `GET /v1/facet-pack`. The
number sat at `1.0.0` through the first three before this rule existed, which
meant a reader could not tell a three-month-old spec from a current one.

> **Diagnostic fields are not frozen.** `POST /v1/memory/retrieve`,
> `/v1/memory/answer`, and `/v1/memory/runtime/turn` return additional
> diagnostic/ranking fields (e.g. `retrieval`, `evidence`, `layerAlignment`,
> `retrievalPlan`) that are **not** part of the frozen contract and may change
> without notice. Only the stable top-level fields of these endpoints are frozen.

### Not part of `/v1`

All other endpoints (diagnostics, `fast-view`, `layer-status`, `working-state`,
`stable-state`, `state/history`, `check-contradiction`, `embed/backfill`,
`digest/rebuild`, the `GET /memory/digests` list, the `GET /memory/events` list,
`scopes/:id/webhook`, demo, metrics) are **internal**: unversioned, legacy-path
only, and may change without notice.

Note that `GET /memory/digests` is internal while
`GET /v1/memory/digests/:digestId/selection` is frozen. Listing digests is a
diagnostic view of pipeline history; asking one digest what it discarded is the
auditability claim, and a caller has to be able to rely on the answer.
