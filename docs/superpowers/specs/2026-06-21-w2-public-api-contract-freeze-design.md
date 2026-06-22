# W2 — Public API Contract Freeze (`/v1`) — Design

Date: 2026-06-21
Status: Approved (brainstorming) → ready for implementation planning
Parent: `docs/superpowers/specs/2026-06-21-statecore-core-readiness-design.md` (W2)

## Context

W2 of StateCore Core Readiness. The hosted version and the GPT-API integration
layer will be built on top of StateCore's HTTP API. They need a **frozen public
contract** they can depend on without churn. Today there is no API versioning,
controllers mount absolute unversioned paths (`/memory/events`,
`/memory/runtime/turn`, …), the peripheral apps (`cli`, `adapter-mcp`,
`adapter-telegram`) hardcode those unversioned paths, there is one
contract/implementation mismatch (`RetrieveInput.query`), and there is no swagger
/ OpenAPI.

The `packages/contracts` schemas are already grouped (`PublicRuntimeContracts` /
`DebugSurfaceContracts` / `InternalControlContracts` / `DemoWebContracts`), but
that taxonomy is "runtime vs debug vs control", **not** "external public
surface" — e.g. ingest (`MemoryEventInput`) sits in `InternalControlContracts`
yet is a core public operation. So the `/v1` public subset is defined fresh here.

## Goals

1. A designated `/v1` public subset that external layers depend on.
2. Introducing `/v1` must NOT break the unversioned peripheral apps (they must
   keep running untouched — they are reference integrations, out of W2 scope).
3. Contract and implementation agree (fix `RetrieveInput.query`).
4. A snapshot test prevents accidental breaking changes to the public subset.
5. The freeze rules and the subset are documented.

## Decisions (from brainstorming)

- **Mechanism: path-array dual-mount.** No NestJS global versioning. Each public
  handler is mounted at BOTH its legacy path and a `/v1`-prefixed path using the
  route decorator's array form: `@Post(["/memory/events", "/v1/memory/events"])`.
  One handler, two paths, no logic duplication, zero impact on other routes.
  External layers use `/v1/*`; peripherals keep using `/*`. Internal/debug
  endpoints stay single-mounted (legacy only) and free to evolve.
- **Subset: the core operating set** (13 handlers, below).
- **Snapshot: JSON-schema snapshot with conscious update.** Serialize the public
  contract schemas via `zod-to-json-schema` and assert with vitest
  `toMatchSnapshot()`. Any diff → CI red with the diff shown; an intentional,
  additive-only change is accepted by regenerating the snapshot (`vitest -u`); a
  removal/rename/retype/required-addition is the signal to stop.

## Public `/v1` subset (the frozen surface)

Dual-mounted at `/v1/*` AND legacy `/*`:

| Controller | Handler | Path |
|---|---|---|
| scopes | create scope | `POST /scopes` |
| scopes | list scopes | `GET /scopes` |
| scopes | set active scope | `POST /scopes/:id/active` |
| scopes | get active-scope state | `GET /state` |
| memory | ingest event | `POST /memory/events` |
| memory | retrieve | `POST /memory/retrieve` |
| memory | answer | `POST /memory/answer` |
| memory | trigger digest | `POST /memory/digest` |
| memory | runtime turn | `POST /memory/runtime/turn` |
| reminders | create reminder | `POST /reminders` |
| reminders | list reminders | `GET /reminders` |
| reminders | cancel reminder | `POST /reminders/:id/cancel` |
| health | health | `GET /health` |

**Explicitly excluded (internal, legacy-path only, may change without notice):**
`PATCH /scopes/:id/webhook`, `GET /memory/events` (list), `GET /memory/state`,
`/memory/stable-state`, `/memory/working-state`, `/memory/fast-view`,
`/memory/layer-status`, `/memory/state/history`,
`/memory/relationship-context/:scopeId`, `/memory/check-contradiction`,
`/memory/embed/backfill`, `/memory/digest/rebuild`, `/memory/digests`,
`/diagnostics/*`, `/demo/*`, metrics.

## Freeze discipline (additively-compatible)

For everything in the public subset:
1. Never remove, rename, or retype an existing field.
2. Never add a **required** field (new fields are always optional).
3. Enums are **open sets**; consumers must tolerate unknown values.

Additive optional fields (e.g. future `DigestState.profile` facets surfaced via
`runtime/turn`) remain backward compatible and are allowed. `runtime/turn`'s
`metadata: Record<string, unknown>` is documented as a deliberate open
pass-through, not an unversioned side-channel API.

## Components

- **`packages/contracts/src/public-v1.ts`** (new) — exports `PublicV1Contracts`,
  an object mapping each public endpoint to its request/response Zod schemas
  (re-exported from the existing schema definitions; no schema is redefined).
  This is the single source of truth for "what is frozen".
- **`packages/contracts/src/public-v1.snapshot.test.ts`** (new) — serializes
  every schema in `PublicV1Contracts` via `zod-to-json-schema` into one object
  and asserts `toMatchSnapshot()`. The committed snapshot lives under
  `packages/contracts/src/__snapshots__/`.
- **`packages/contracts`** — add `zod-to-json-schema` as a dependency.
- **`packages/contracts/src/index.ts`** — `RetrieveInput.query` becomes
  `z.string().min(1).optional()`.
- **API controllers** (`scopes`, `memory`, `reminders`, `health`) — the 13
  handlers above gain the `/v1`-prefixed path in their route decorator's array.
- **`apps/api/src/test/`** — an integration test asserting representative public
  endpoints answer at both `/v1/*` and `/*`, and that an excluded endpoint is
  NOT reachable under `/v1`.
- **`docs/api.md`** — a `/v1` section: the subset list, the freeze rules, and the
  "internal endpoints are unversioned and may change" statement.

## Testing

- **Dual-mount:** integration test (existing supertest harness) hits a sample of
  public endpoints at `/v1/...` and `/...` (both succeed), and confirms an
  excluded endpoint (e.g. `/v1/memory/fast-view`) 404s while its legacy path
  works.
- **Snapshot:** `PublicV1Contracts` JSON-schema snapshot test.
- **query fix:** retrieve without `query` passes contract parsing and returns
  recent events (unit/integration as appropriate).

## Out of scope

- NestJS global versioning machinery, OpenAPI/swagger generation.
- A semantic additive-vs-breaking auto-classifier (the snapshot + human review of
  the diff is the chosen mechanism; the classifier is a possible future upgrade).
- Changing peripheral app clients (they keep using legacy paths).
- Adding new endpoints or capabilities.

## Next step

Decompose into ~5 tasks (query fix; contract source-of-truth + snapshot test;
dual-mount routing + routing test; docs) via writing-plans.
