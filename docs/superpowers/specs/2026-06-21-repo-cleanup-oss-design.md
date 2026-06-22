# Repo Cleanup — Standard Open-Source Memory Runtime — Design

Date: 2026-06-21
Status: Approved (brainstorming) → ready for implementation planning

## Context

The project direction changed: the hosted product + integrations now live in the
separate `statecore-cloud` repo (see the layered model in
`docs/vision-and-roadmap.md`). The `StateCore` repo accumulated peripheral apps,
demo-coupled code, and historical/demo docs that are no longer needed. Clean it
into a focused, standard open-source **self-hosted memory runtime**.

Verified before planning: the core (`apps/api`, `apps/worker`, `packages/*`) does
NOT import any peripheral app — removal is safe. There are no demo/agent-scenario
test files. `docker-compose.local.yml` is already clean (postgres/redis/migrate/
api/worker). `Caddyfile` only reverse-proxies `demo-web`. The rate limiter is
configured solely via `DEMO_*` env vars but functions as the API's general
read/write limiter (the "demo" name is now a misnomer).

## Target state

The repo contains: `apps/api` + `apps/worker` + `packages/{core,contracts,db,prompts}`,
OpenAPI + Scalar `/docs`, a focused `docs/`, and standard OSS files (README,
LICENSE, CONTRIBUTING, etc.). No demo app, no adapters, no CLI. Tests green,
`tsc` clean, no dangling references to removed code.

## Decisions (from brainstorming)

- Remove all four peripheral apps: `demo-web`, `adapter-telegram`, `cli`,
  `adapter-mcp`. (MCP removed now for a clean core; it can return later as a
  polished, tested, standalone integration — git history preserves it.)
- Remove the demo-coupled code inside the core.
- Keep the rate limiter; rename its misleading `DEMO_*` config to `RATE_LIMIT_*`.
- Move `docs/superpowers/` (internal brainstorm/design/plan artifacts) out of the
  repo to the owner's Obsidian vault (`~/Quatium/StateCore/`); remove from repo.

## Scope

### 1. Remove peripheral apps
Delete: `apps/demo-web`, `apps/adapter-telegram`, `apps/cli`, `apps/adapter-mcp`.

### 2. Remove demo-coupled code from the core
- `apps/api/src/memory.controller.ts`: delete the `@Post("/demo/agent-scenarios/:id/run")`
  handler.
- `apps/api/src/main.ts`: remove the `isAgentScenarioRunRoute` branch from the
  rate-limit middleware (keep the limiter; the `/demo/*` special-case goes).
- `packages/contracts/src/index.ts`: remove `AgentScenarioRunOutput` and the
  `DemoWebContracts` group, and drop `AgentScenarioRunOutput` from
  `PublicRuntimeContracts`. (Confirmed NOT in `PublicV1Contracts`, so the `/v1`
  contract + OpenAPI snapshot are unaffected.)
- **Rate-limit rename:** `DEMO_RATE_LIMIT_*` / `DEMO_TURN_RATE_LIMIT_*` env →
  `RATE_LIMIT_*` / `TURN_RATE_LIMIT_*`; `apiEnv.demoRateLimit*` /
  `demoTurnRateLimit*` fields → `rateLimit*` / `turnRateLimit*`. Update `env.ts`,
  `main.ts`, `.env.example`, `.env.production.example`, and any doc references.
  Behavior unchanged; only names.

### 3. Build / deploy cleanup
- `Dockerfile`: remove the `demo-web` / `adapter-telegram` / `adapter-mcp` /
  `cli` `COPY` lines and the `demo-web-runtime` stage.
- `docker-compose.prod.yml`: remove the `demo-web` and `cleanup-demo-guests`
  services. (Public ingress is now the separate cloud gateway.)
- `Caddyfile`: delete (it only proxied `demo-web`).
- `docker-compose.local.yml`: no change (already clean).
- root `package.json` scripts: remove `dev:telegram`, `dev:demo`, `dev:mcp`,
  `dev:cli` (whichever exist), `smoke:demo-web`, `cleanup:demo-guests`.
- `scripts/`: remove `smoke-demo-web.sh`, `cleanup-demo-guests.ts`,
  `dev-demo-stack.sh`. Keep core smokes (`smoke-llm.sh`, `smoke-no-llm.sh`,
  `smoke-runtime.sh`, `smoke-reminders.sh`); update `smoke-prod-compose.sh` if it
  references removed services.
- CI (`.github/workflows/*`): drop the leftover `FEATURE_TELEGRAM` env lines.

### 4. Docs cleanup (`docs/`)
- **Remove:** `demo-web-surface.md`, `demo-quickstart.md`, `frontend-options.md`,
  `observable-comparison.md`, `mcp-adapter.md`, `product-surface.md`,
  `release-v0.1.0.md`, `release-v1.0.0.md`, `release-v1.0.0-summary.md`,
  `release.md`, `ablation-results-2026-02-08.md`, `research-article-draft.md`,
  `research-report-template.md`.
- **Keep:** `api.md`, `technical-overview.md`, `vision-and-roadmap.md`,
  `benchmarking.md`, `evaluation-metrics.md`, `evaluation-protocol.md`,
  `drift-definition.md`, `digest-state.md`, `protected-state-merge.md`,
  `assistant-runtime.md`, `provider-abstraction.md`, `glossary.md`,
  `philosophy.md`, `repo-map.md` (update), `start-here.md` (update),
  `research-overview.md`, `research-questions.md`,
  `runtime-profile-ablation-guide.md`, `llm-context.md`.
- **Move out of repo:** the entire `docs/superpowers/` (specs + plans, including
  this cleanup's own spec/plan) → copy to `~/Quatium/StateCore/`, then `git rm`
  from the repo. Do this LAST so plan/brief files remain available during
  execution.

### 5. README + entry docs rewrite
- Rewrite `README.md` to a standard OSS README: what StateCore is (a self-hosted,
  low-drift long-term memory runtime), quickstart, the `/v1` API + OpenAPI
  (`/openapi.json`) + Scalar `/docs`, architecture (`apps/api`, `apps/worker`,
  `packages/*`), how to run/test, contributing, license. Remove all demo-web /
  telegram / adapter / CLI references.
- Update `docs/repo-map.md` and `docs/start-here.md` to match the trimmed repo.

### 6. Verify
- `pnpm install` resolves the workspace after app removal.
- `pnpm --filter @statecore/core test`, `@statecore/api test`,
  `@statecore/worker test` green; `pnpm --filter @statecore/api exec tsc --noEmit`
  clean.
- `grep` confirms no remaining references to removed names (`demo-web`,
  `adapter-telegram`, `adapter-mcp`, `@statecore/cli`, `agent-scenarios`,
  `DemoWebContracts`, `AgentScenarioRunOutput`, `DEMO_RATE_LIMIT`) in source,
  config, or kept docs.

## Out of scope

- Any change to core memory behavior, the `/v1` contract, or the OpenAPI surface.
- The `statecore-cloud` repo.
- Re-homing MCP/CLI as new standalone projects (future, separate).

## Risks & mitigations

- **Rate-limit rename** is the only behavior-adjacent change — mitigated by
  keeping logic identical and renaming consistently across env + code + example
  envs; api tests must stay green.
- **Contracts removal** could ripple — mitigated by confirming
  `AgentScenarioRunOutput` is not in `PublicV1Contracts`; run the contract/openapi
  snapshot tests after.
- **Moving docs/superpowers mid-run** — mitigated by doing it as the final task
  and extracting all task briefs to `.superpowers/sdd/` (outside docs/) first.

## Next step

Decompose into ~4 tasks via writing-plans: (1) remove apps + build/deploy/config
references; (2) remove demo code from core + rate-limit rename; (3) docs prune +
move `docs/superpowers/` out; (4) README/entry-docs rewrite. Final verify folded
into the relevant tasks.
