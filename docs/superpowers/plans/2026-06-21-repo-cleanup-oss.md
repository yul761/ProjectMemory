# Repo Cleanup (Standard OSS Memory Runtime) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trim StateCore to a focused, standard open-source self-hosted memory runtime — remove the 4 peripheral apps, the demo-coupled core code, and historical/demo docs; rename the misnamed rate-limit config; move internal process docs out; rewrite the README.

**Architecture:** Pure subtraction + light renames. The core (`apps/api`, `apps/worker`, `packages/*`) and the frozen `/v1` contract are unchanged in behavior. Deletions are verified by tests staying green, `tsc` clean, and grep finding zero dangling references.

**Tech Stack:** pnpm workspace, NestJS, Prisma, vitest. No new deps.

## Global Constraints

- Do NOT change core memory behavior, the `/v1` contract, or the OpenAPI/`PublicV1Contracts` surface. `AgentScenarioRunOutput` is NOT in `PublicV1Contracts` (verified) — removing it must not change `apps/api/src/__snapshots__/public-v1-contract.snapshot.test.ts.snap` or `openapi.test.ts.snap`.
- The rate limiter stays; only its `DEMO_*` names change to `RATE_LIMIT_*` / `TURN_RATE_LIMIT_*`. Behavior identical.
- No `any`.
- Keep tests green at every task: `pnpm --filter @statecore/core test`, `@statecore/api test`, `@statecore/worker test`; `pnpm --filter @statecore/api exec tsc --noEmit`. (Integration tests need Postgres at 5434 — already up.)
- Conventional-commit messages, each ending with exactly:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Removed names that must NOT appear anywhere in `apps/`, `packages/`, root config, or kept `docs/` afterward: `demo-web`, `adapter-telegram`, `adapter-mcp`, `@statecore/cli`, `agent-scenarios`, `DemoWebContracts`, `AgentScenarioRunOutput`, `DEMO_RATE_LIMIT`, `DEMO_TURN_RATE_LIMIT`.

## File Structure (what changes)

- Delete dirs: `apps/demo-web`, `apps/adapter-telegram`, `apps/cli`, `apps/adapter-mcp` (T1).
- Edit: `Dockerfile`, `docker-compose.prod.yml`, `package.json`, CI workflows; delete `Caddyfile` + 3 scripts (T1).
- Edit: `apps/api/src/memory.controller.ts`, `apps/api/src/main.ts`, `apps/api/src/env.ts`, `packages/contracts/src/index.ts`, `.env.example`, `.env.production.example` (T2).
- Delete docs + rewrite `README.md`/`docs/repo-map.md`/`docs/start-here.md` (T3).
- Move `docs/superpowers/` out; final verify (T4).

---

### Task 1: Remove the 4 peripheral apps + build/deploy/config references

**Files:** delete `apps/demo-web/`, `apps/adapter-telegram/`, `apps/cli/`, `apps/adapter-mcp/`; delete `Caddyfile`, `scripts/smoke-demo-web.sh`, `scripts/cleanup-demo-guests.ts`, `scripts/dev-demo-stack.sh`; edit `package.json`, `Dockerfile`, `docker-compose.prod.yml`, `.github/workflows/*`.

- [ ] **Step 1: Delete the app directories and obsolete scripts**

```bash
git rm -r apps/demo-web apps/adapter-telegram apps/cli apps/adapter-mcp
git rm Caddyfile scripts/smoke-demo-web.sh scripts/cleanup-demo-guests.ts scripts/dev-demo-stack.sh
```

- [ ] **Step 2: Remove the obsolete root `package.json` scripts**

In `package.json`, delete these script lines: `dev:telegram`, `dev:demo`, `dev:demo-stack`, `dev:cli`, `dev:mcp`, `smoke:demo-web`, `cleanup:demo-guests`. Leave everything else (incl. `dev:api`, `dev:worker`, `dev:lite`, the benchmark/smoke/db scripts). After editing, the `smoke` aggregate script (`smoke:no-llm && smoke:llm && smoke:runtime && smoke:reminders`) is unaffected.

- [ ] **Step 3: Clean the Dockerfile**

In `Dockerfile`, remove the `COPY` lines for `apps/demo-web`, `apps/adapter-telegram`, `apps/adapter-mcp`, and `apps/cli` (the `package.json` copies near the top), and remove the entire `FROM runtime-base AS demo-web-runtime` stage (through its `CMD`). Leave the api/worker build + runtime stages intact.

- [ ] **Step 4: Clean docker-compose.prod.yml**

In `docker-compose.prod.yml`, remove the `demo-web:` service and the `cleanup-demo-guests:` service blocks entirely, and any `depends_on: [demo-web]` references. (If `caddy` only existed to front `demo-web`, remove the `caddy` service too — the public entrypoint is now the separate cloud gateway. Inspect and decide; if `caddy` serves nothing else, remove it.)

- [ ] **Step 5: Drop the leftover FEATURE_TELEGRAM env in CI**

In `.github/workflows/runtime-readiness.yml`, `integration-smoke.yml`, `runtime-smoke.yml`, remove the `FEATURE_TELEGRAM: "false"` env lines (telegram is gone).

- [ ] **Step 6: Verify the workspace still resolves + no dangling app refs**

```bash
pnpm install
grep -rniE "demo-web|adapter-telegram|adapter-mcp|@statecore/cli|smoke-demo-web|cleanup-demo-guests|dev-demo-stack" \
  package.json Dockerfile docker-compose.prod.yml docker-compose.local.yml .github scripts
```
Expected: `pnpm install` succeeds (lockfile updates to drop the removed workspace packages); the grep returns nothing.

- [ ] **Step 7: Run core tests (sanity — nothing core changed yet)**

Run: `pnpm --filter @statecore/api test && pnpm --filter @statecore/core test`
Expected: green (this task removed only peripherals + config).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
chore: remove peripheral apps (demo-web, telegram, cli, mcp) + their build/deploy refs

Drops the 4 peripheral apps and their references in package.json scripts, the
Dockerfile (demo-web stage), prod compose (demo-web/cleanup services), Caddyfile,
obsolete smoke/cleanup scripts, and the FEATURE_TELEGRAM CI env. Core untouched.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Remove demo-coupled core code + rate-limit rename

**Files:** `apps/api/src/memory.controller.ts`, `apps/api/src/main.ts`, `apps/api/src/env.ts`, `packages/contracts/src/index.ts`, `.env.example`, `.env.production.example`.

**Interfaces:** the rate-limit `apiEnv` fields are renamed `demoRateLimitWindowMs→rateLimitWindowMs`, `demoRateLimitMax→rateLimitMax`, `demoTurnRateLimitWindowMs→turnRateLimitWindowMs`, `demoTurnRateLimitMax→turnRateLimitMax`. Env keys `DEMO_RATE_LIMIT_WINDOW_MS→RATE_LIMIT_WINDOW_MS`, `DEMO_RATE_LIMIT_MAX→RATE_LIMIT_MAX`, `DEMO_TURN_RATE_LIMIT_WINDOW_MS→TURN_RATE_LIMIT_WINDOW_MS`, `DEMO_TURN_RATE_LIMIT_MAX→TURN_RATE_LIMIT_MAX`.

- [ ] **Step 1: Delete the demo agent-scenarios endpoint**

In `apps/api/src/memory.controller.ts`, delete the entire handler beginning at `@Post("/demo/agent-scenarios/:id/run")` (currently ~line 898) through the end of that method (its closing `}`). After deleting, check whether any import or helper became unused **only** by that method (e.g. a demo-only import); if so, remove it too. Verify: `grep -n "agent-scenario\|demoKind\|/demo/" apps/api/src/memory.controller.ts` returns nothing.

- [ ] **Step 2: Remove the demo branch + rename rate-limit fields in main.ts**

In `apps/api/src/main.ts`, replace the rate-limit route-classification + config block:

```ts
  const isTurnRoute = req.method === "POST" && req.path === "/memory/runtime/turn";
  const isScopeCreateRoute = req.method === "POST" && req.path === "/scopes";
  const isAgentScenarioRunRoute = req.method === "POST" && req.path.startsWith("/demo/agent-scenarios/");

  const isWriteRoute = isTurnRoute || isScopeCreateRoute || isAgentScenarioRunRoute;
  const windowMs = isWriteRoute ? apiEnv.demoTurnRateLimitWindowMs : apiEnv.demoRateLimitWindowMs;
  const maxRequests = isWriteRoute ? apiEnv.demoTurnRateLimitMax : apiEnv.demoRateLimitMax;
```

with:

```ts
  const isTurnRoute = req.method === "POST" && req.path === "/memory/runtime/turn";
  const isScopeCreateRoute = req.method === "POST" && req.path === "/scopes";

  const isWriteRoute = isTurnRoute || isScopeCreateRoute;
  const windowMs = isWriteRoute ? apiEnv.turnRateLimitWindowMs : apiEnv.rateLimitWindowMs;
  const maxRequests = isWriteRoute ? apiEnv.turnRateLimitMax : apiEnv.rateLimitMax;
```

- [ ] **Step 3: Rename the env keys + apiEnv fields in env.ts**

In `apps/api/src/env.ts`, change the schema keys:
```ts
  RATE_LIMIT_WINDOW_MS: z.string().optional(),
  RATE_LIMIT_MAX: z.string().optional(),
  TURN_RATE_LIMIT_WINDOW_MS: z.string().optional(),
  TURN_RATE_LIMIT_MAX: z.string().optional(),
```
and the apiEnv mapping:
```ts
  rateLimitWindowMs: Number(env.RATE_LIMIT_WINDOW_MS || 60000),
  rateLimitMax: Number(env.RATE_LIMIT_MAX || 120),
  turnRateLimitWindowMs: Number(env.TURN_RATE_LIMIT_WINDOW_MS || 60000),
  turnRateLimitMax: Number(env.TURN_RATE_LIMIT_MAX || 24)
```

- [ ] **Step 4: Rename the keys in the example env files**

In `.env.example` and `.env.production.example`, rename any `DEMO_RATE_LIMIT_WINDOW_MS`/`DEMO_RATE_LIMIT_MAX`/`DEMO_TURN_RATE_LIMIT_WINDOW_MS`/`DEMO_TURN_RATE_LIMIT_MAX` keys to `RATE_LIMIT_WINDOW_MS`/`RATE_LIMIT_MAX`/`TURN_RATE_LIMIT_WINDOW_MS`/`TURN_RATE_LIMIT_MAX` (keep their values/comments). Run `grep -rn "DEMO_RATE_LIMIT\|DEMO_TURN_RATE_LIMIT" .env.example .env.production.example` first to find them; if none exist, skip.

- [ ] **Step 5: Remove the demo contracts**

In `packages/contracts/src/index.ts`:
- Delete the `export const AgentScenarioRunOutput = z.object({ ... });` definition (~line 583, through its closing `});`).
- Remove the `AgentScenarioRunOutput` entry from the `PublicRuntimeContracts` object (~line 608).
- Delete the entire `export const DemoWebContracts = { ... } as const;` block (~line 670) and the `export const DemoWebRoutes = { ... } as const;` block (~line 711).
Verify: `grep -n "AgentScenarioRunOutput\|DemoWeb" packages/contracts/src/index.ts` returns nothing.

- [ ] **Step 6: Build contracts + run tests + typecheck**

Run:
```bash
pnpm --filter @statecore/contracts build
pnpm --filter @statecore/api test
pnpm --filter @statecore/core test
pnpm --filter @statecore/api exec tsc --noEmit
```
Expected: all green. In particular the `public-v1-contract` and `openapi` snapshot tests still pass UNCHANGED (proving the `/v1` surface didn't move). If a snapshot changed, STOP — that means something in `/v1` was wrongly affected; do not `-u` it.

- [ ] **Step 7: Verify no demo refs remain in source**

Run: `grep -rniE "agent-scenario|DemoWeb|AgentScenarioRunOutput|DEMO_RATE_LIMIT|demoRateLimit|demoTurnRateLimit" apps packages | grep -v node_modules`
Expected: nothing.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(api): remove demo-coupled code; rename rate-limit config

Deletes the /demo/agent-scenarios endpoint, the demo rate-limit branch, and the
DemoWebContracts/AgentScenarioRunOutput contracts (none on the frozen /v1
surface). Renames the misnamed DEMO_* rate-limit env/fields to RATE_LIMIT_* /
TURN_RATE_LIMIT_* — the limiter is unchanged, just no longer "demo".

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Prune docs + rewrite README & entry docs

**Files:** delete the obsolete `docs/*` files below; rewrite `README.md`, `docs/repo-map.md`, `docs/start-here.md`.

- [ ] **Step 1: Delete the obsolete docs**

```bash
git rm docs/demo-web-surface.md docs/demo-quickstart.md docs/frontend-options.md \
  docs/observable-comparison.md docs/mcp-adapter.md docs/product-surface.md \
  docs/release-v0.1.0.md docs/release-v1.0.0.md docs/release-v1.0.0-summary.md \
  docs/release.md docs/ablation-results-2026-02-08.md docs/research-article-draft.md \
  docs/research-report-template.md
```

- [ ] **Step 2: Rewrite README.md to a standard OSS README**

Replace `README.md` with a focused doc covering, in order: a one-paragraph "what is StateCore" (self-hosted, low-drift, long-term memory runtime for local/BYO models); Features (event store, digest pipeline, protected state, retrieval, reminders, benchmarks); Quickstart (`pnpm install`; `.env` with `PORT`, `LOCAL_USER_TOKEN`, model vars; `docker compose -f docker-compose.local.yml up -d`; `pnpm dev:api` + `pnpm dev:worker`); the API (`x-user-id` auth, the `/v1` public subset, `GET /openapi.json` + Scalar `/docs`, pointer to `docs/api.md`); Architecture (`apps/api`, `apps/worker`, `packages/core|contracts|db|prompts`); Testing/benchmarks (`pnpm --filter ... test`, `pnpm benchmark`); Layered model pointer (`docs/vision-and-roadmap.md`); Contributing + License. Remove ALL demo-web / telegram / adapter / CLI mentions. Keep it accurate to the trimmed repo.

- [ ] **Step 3: Update repo-map.md and start-here.md**

In `docs/repo-map.md` and `docs/start-here.md`, remove references to the deleted apps (`demo-web`, `adapter-telegram`, `adapter-mcp`, `cli`) and deleted docs, and reflect the current structure (`apps/api`, `apps/worker`, `packages/*`, `/v1`+OpenAPI). Keep them short and accurate.

- [ ] **Step 4: Verify no broken references to deleted docs/apps**

Run:
```bash
grep -rniE "demo-web|adapter-telegram|adapter-mcp|telegram|demo-quickstart|frontend-options|observable-comparison|mcp-adapter|product-surface|release-v" README.md docs --include=*.md | grep -v "docs/superpowers"
```
Expected: nothing (kept docs no longer link to removed files/apps; `docs/superpowers/` excluded since it's moved out in Task 4).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
docs: prune demo/historical docs + rewrite README for the trimmed runtime

Removes demo/release/research-draft docs; rewrites README, repo-map, and
start-here to describe the focused memory runtime (apps/api + apps/worker +
packages/*, /v1 + OpenAPI/docs). No demo/adapter/CLI references remain.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Move `docs/superpowers/` out of the repo + final verify

**Files:** move `docs/superpowers/` → `~/Quatium/StateCore/`; whole-repo verification.

- [ ] **Step 1: Copy the internal process docs to the Obsidian vault, then remove from the repo**

```bash
mkdir -p ~/Quatium/StateCore/statecore-superpowers-archive
cp -R docs/superpowers/. ~/Quatium/StateCore/statecore-superpowers-archive/
git rm -r docs/superpowers
```
(This includes this cleanup's own spec/plan — intended. The task briefs live in `.superpowers/sdd/`, which is git-ignored and unaffected.)

- [ ] **Step 2: Whole-repo dangling-reference sweep**

Run:
```bash
grep -rniE "demo-web|adapter-telegram|adapter-mcp|@statecore/cli|agent-scenarios|DemoWebContracts|AgentScenarioRunOutput|DEMO_RATE_LIMIT|DEMO_TURN_RATE_LIMIT|docs/superpowers" \
  apps packages docs README.md package.json Dockerfile docker-compose.prod.yml docker-compose.local.yml .github scripts 2>/dev/null | grep -v node_modules
```
Expected: nothing. (If `docs/api.md` or another kept doc links to `docs/superpowers/...`, fix that link to drop it.)

- [ ] **Step 3: Full test + typecheck sweep**

Run:
```bash
pnpm --filter @statecore/core test
pnpm --filter @statecore/api test
pnpm --filter @statecore/worker test
pnpm --filter @statecore/api exec tsc --noEmit
```
Expected: all green; `tsc` clean.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
docs: move internal superpowers specs/plans out of the repo

Relocates the internal brainstorm/design/plan artifacts to the owner's notes
vault; they are development process history, not standard OSS docs. Git history
preserves them in-repo. Final sweep: no dangling references; tests green.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- Remove 4 apps → T1. ✓
- Build/deploy/config refs (Dockerfile, prod compose, Caddyfile, package.json, scripts, CI) → T1. ✓
- Demo core code (controller endpoint, main.ts branch, contracts) + rate-limit rename → T2. ✓
- Docs prune + README/entry rewrite → T3. ✓
- Move docs/superpowers out → T4. ✓
- Final verify (install, tests, tsc, grep) → T1 Step 6-7, T2 Step 6-7, T4 Step 2-3. ✓

**Placeholder scan:** Deletions specify exact paths/markers + verification greps; the one judgment call (whether `caddy` serves only demo-web) is given an explicit inspect-and-decide instruction, not a vague TODO. README rewrite specifies the exact section list. No TBD.

**Type consistency:** rate-limit field renames are listed once (Interfaces block) and used identically in env.ts (def) + main.ts (use): `rateLimitWindowMs`, `rateLimitMax`, `turnRateLimitWindowMs`, `turnRateLimitMax`. ✓
