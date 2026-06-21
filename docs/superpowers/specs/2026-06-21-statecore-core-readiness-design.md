# StateCore Core Readiness — Design

Date: 2026-06-21
Status: Approved (brainstorming) → ready for implementation planning

## Context

StateCore today is an open-source, self-hosted long-term memory runtime. The
owner's forward plan layers additional products **on top** of this core, in this
order:

1. **StateCore core** (this repo) — get to a "terminal" / release-ready state.
2. **Hosted/managed version** — adds auth, validation, multi-tenant operations.
3. **GPT-API integration layer** — connects the runtime to an LLM API surface.
4. **Frontend app** — the consumer-facing product.

This design covers **step 1 only**: getting the StateCore core into a state where
the layers above it can be built **purely additively** — i.e. the hosted layer
should only need to *add* auth/validation/operations, never go back and *change*
StateCore's core capabilities.

### Positioning note (supersedes the old roadmap)

The existing `docs/vision-and-roadmap.md` lists "centralized hosted platform",
"model deployment platform", and "broad consumer chat UI" as **non-goals**. Per
the 2026-06-21 discussion, **this discussion is authoritative**; that roadmap was
simply not updated. The correct mental model is **layered**:

- **Open-source runtime core** (StateCore) — unchanged positioning, the
  reusable, self-hosted, low-drift memory layer.
- **A commercial product stack built on top** (hosted version → GPT-API layer →
  app) — a separate concern that consumes the core via its frozen public API.

These are not in conflict; they are two layers. Updating the positioning doc to
reflect this is in scope (W4).

## Definition of Ready (acceptance gate)

The core is "ready" when all four hold:

1. **Tenant isolation is correct.** On every known path, user A cannot read user
   B's data (including vector search). A regression test guards this.
2. **Public contract is frozen.** A `/v1` public subset is defined; contract and
   implementation agree; a snapshot test prevents accidental breaking changes;
   internal/debug endpoints are clearly partitioned.
3. **Core quality holds.** Core-scope critical paths are tested, CI is green, the
   benchmark/drift suite stays at current levels (94/100, drift = 0), and errors
   are observable (no silent swallowing).
4. **Clean.** Stale docs/scripts/paper-only features are reconciled; a new
   contributor can read the boundaries.

### Scope boundary

In scope (core): `packages/*`, `apps/api`, `apps/worker`.

Out of scope (reference integrations — keep them running, no test hardening):
`apps/cli`, `apps/adapter-telegram`, `apps/adapter-mcp`, `apps/demo-web`. The
real product surfaces are the future hosted version and app, so these stay at
"reference" quality.

## Approach

A single **readiness umbrella spec** (this document) decomposing into four
workstreams, each of which gets its own spec/plan/implementation cycle. The
umbrella provides one shared Definition of Ready gate; each workstream is
independently mergeable and verifiable.

(Considered and rejected: brainstorming each workstream with no umbrella — loses
the shared gate; one big-bang readiness PR — mixes security, interface, and
cleanup into an unreviewable change.)

## Workstreams

### W1 — Tenant isolation correctness (security) — **P0**

The core is genuinely multi-tenant (a `User` model; `ProjectScope`,
`MemoryEvent`, `Reminder` carry `userId`; all API endpoints and worker jobs
verify scope ownership). The hosted-layer assumption ("only add auth") is
therefore basically valid — but there is one real cross-tenant defect plus two
defense-in-depth gaps that are **core bugs the hosted layer cannot paper over**.

Tasks:
- **Fix `vectorSearchFn`** (`apps/api/src/domain.service.ts:243`): the raw SQL
  over `MemoryEventEmbedding` orders by vector distance with **no scope/user
  filter**, so with `RETRIEVE_USE_VECTOR_SEARCH=true` another tenant's events can
  leak into results. Filter by `scopeId` (and `userId`) in the query, or
  validate every returned event belongs to the target scope before merging.
- **Defense-in-depth composite keys**: `backfillEmbeddings`
  (`apps/api/src/memory.controller.ts:555`) raw SQL filters by `scopeId` only;
  `setWebhook` (`apps/api/src/scopes.controller.ts:50`) updates by `id` only.
  Both verify ownership first, so not currently exploitable, but should use
  `(id, userId)` / include `userId` in the `WHERE` so isolation is enforced at
  the DB layer.
- **Regression test**: an explicit multi-tenant test where user B attempts to
  read user A's scope/events/vector results and fails. This is the durable guard
  for DoR #1.

### W2 — Public API contract freeze (`/v1` + public subset) — **P0/P1**

Today there is no API versioning, the surface is ~70% stable / 30% in-flux, and
there is one contract/implementation mismatch.

Tasks:
- **Define the `/v1` public subset** — the contract the hosted + GPT layers will
  depend on. Candidate members: `scopes`, `memory/events`, `memory/digest`,
  `memory/retrieve`, `memory/answer`, the state views, and `memory/runtime/turn`.
  Everything else (diagnostics, `fast-view`, `layer-status`, backfill, demo
  endpoints) is **internal/debug**, partitioned and free to evolve.
- **Fix `RetrieveInput.query` mismatch**: the contract requires
  `query: z.string().min(1)` but `RetrieveService.retrieve(scopeId, limit,
  query?)` treats it as optional. Resolve by making the contract field optional
  (matches implementation and enables "recent events, no filter" use).
- **`runtime/turn` enters `/v1` under an "additively-compatible freeze"** rather
  than being deferred to internal. The contract (`contracts/src/index.ts:213`)
  keeps growing — `policyProfile` enum, the `policyOverrides` object, the open
  `metadata: Record<string, unknown>`, and the `StateLayerView` profile facets
  (`identity/relationships/ongoing/goals/followUps/style`) that are added as the
  profile system expands. Freezing it does **not** mean "no field ever added".
  The freeze discipline is:
  1. Never remove, rename, or retype an existing field.
  2. Never add a **required** field (new fields are always optional).
  3. Enums are declared **open sets**; consumers must tolerate unknown values
     (no crash-on-unknown).
  Additive optional fields (e.g. future profile facets) remain backward
  compatible and are allowed.
- **Document `metadata`'s purpose/boundary** so it does not become an invisible,
  unversioned side-channel API.
- **Public contract snapshot test**: removing/renaming/retyping a public field or
  making a new field required → CI fails; pure additive optional change → passes.

### W3 — Quality & observability hardening (core scope only) — **P1**

Core internals are well tested (34 test files; digest-control, retrieve, runtime
covered) and CI runs tests + benchmark + drift. Gaps are at the edges of the core
scope and in observability.

Tasks:
- **Add tests** for `packages/core/src/model-provider.ts` (model
  initialization/switching, currently untested) and
  `packages/core/src/working-memory.service.ts` (coordination layer, untested).
- **Make errors observable**: `GlobalErrorFilter` (`apps/api/src/error.filter.ts`)
  currently returns 500 without logging — log the exception. Background queue
  failures are silently swallowed (`memory.controller.ts:523`,
  `embedQueue/classifyQueue .catch(() => {})`) — log/emit a metric instead of
  dropping silently (keep them non-blocking for ingest).
- **Close loose ends**: audit `fact-registry` (partial) and the API integration
  test provisioning (partial) — either finish or explicitly document the boundary.

### W4 — Cleanup / de-cruft — **P2**

Low severity; can run last or rolling.

Tasks:
- **Update positioning docs**: revise `docs/vision-and-roadmap.md` (and
  `ROADMAP.md` as needed) to the layered model above — drop the now-incorrect
  "hosted platform / consumer app" non-goals, framing them as the commercial
  stack on top of the OSS core.
- **Refresh `CLAUDE.md`** "Known scopes (as of 2026-05)" stale section.
- **Archive completed** `docs/superpowers/plans/*` and `specs/*` development
  artifacts; consolidate/remove one-off scripts (e.g. `cleanup-demo-guests.ts`).
- **Mark paper-only features explicitly**:
  - **SQLite lite mode** — spec-only, no code. Declare **out of terminal scope /
    shelved** (YAGNI; production path is Postgres + pgvector).
  - **P2b-inferred style learning** — keep as designed-but-not-built; annotate
    "awaiting real usage data" so it is not mistaken for a gap.

## Sequencing

```
W1 (security, P0, small)  →  W2 (contract freeze, P0/P1)  →  W3 ∥ W4
```

W1 first: it is the security gate, blocks the hosted layer, and is small. W2
next: the earlier the contract is fixed, the less rework the layers above incur.
W3 and W4 can proceed in parallel afterward.

## Out of scope (this readiness effort)

- Any hosted-layer functionality (auth providers, billing, multi-tenant ops UI).
- The GPT-API integration layer and the frontend app.
- Test hardening for `cli` / `adapter-telegram` / `adapter-mcp` / `demo-web`.
- New core memory capabilities beyond closing the gaps above.
- Implementing P2b-inferred (stays theoretical until data exists).

## Next step

Each workstream (W1–W4) becomes its own implementation plan via the writing-plans
flow, executed in the sequence above.
