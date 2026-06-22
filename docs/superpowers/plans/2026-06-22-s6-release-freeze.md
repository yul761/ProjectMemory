# S6 Release & Freeze (v1.1.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the freeze release: a runnable worked example, a stability policy, a rewritten CHANGELOG, and a version bump to 1.1.0 — leaving the `/v1` runtime/contract untouched. (The `v1.1.0` git tag is created post-merge by the controller, not in these tasks.)

**Architecture:** Docs + examples + version metadata only. No runtime/contract code changes. `examples/quickstart.sh` (curl, against `/v1`) doubles as functional cold-start validation; `STABILITY.md` declares the freeze policy; CHANGELOG `[1.1.0]` records the actual cleanup + S1–S5 + patch work (the existing `[Unreleased]` is stale — it lists removed apps).

**Tech Stack:** bash + curl + jq (example); markdown (docs); pnpm workspace package.json versions.

## Global Constraints

- NO runtime/contract change. `/v1` controllers, contracts, OpenAPI snapshots MUST be untouched (this is docs/examples/version only). Suites (`pnpm --filter @statecore/{api,worker,core} test`) stay green.
- Version is **v1.1.0** (NOT v1.0.0 — that tag already exists at 2026-03-18, predating this work; do not move it). minor bump: additive features + internal hardening, `/v1` contract unchanged.
- `/v1` endpoints (auth header `x-user-id`): `POST /v1/scopes` (returns `{id,...}`), `POST /v1/memory/events`, `POST /v1/memory/digest`, `POST /v1/memory/retrieve`, `GET /v1/memory/stable-state`. Local defaults: URL `http://localhost:3002`, user `local-dev-user` (per CLAUDE.md / README).
- CHANGELOG is hand-maintained (loosely Keep a Changelog); do NOT introduce a changeset workflow.
- Do NOT push or create the tag in these tasks (the controller tags `v1.1.0` on main after merge).

---

### Task 1: Worked example — examples/quickstart.sh + examples/README.md

**Files:**
- Create: `examples/quickstart.sh`
- Create: `examples/README.md`

**Interfaces:** none (standalone example).

- [ ] **Step 1: Verify the exact request/response shapes against the code**

Run: `grep -n "MemoryEventInput\|DigestRequestInput\|MemoryRetrieveInput\|RetrieveQuery\|stable-state" packages/contracts/src/index.ts apps/api/src/memory.controller.ts | head -30`
Confirm: events body fields (`scopeId`, `type` = `"document"|"stream"`, `source`, `key`, `content`), digest body (`scopeId`), retrieve body (`scopeId`, `query`, `limit`), and how `GET /v1/memory/stable-state` takes its scope (query param `?scopeId=` vs header). Adjust the script in Step 2 to match the ACTUAL shapes if they differ from the draft below; note any correction in the report.

- [ ] **Step 2: Write `examples/quickstart.sh`**

```bash
#!/usr/bin/env bash
# StateCore quickstart: ingest -> digest -> retrieve against the frozen /v1 API.
# Requires: a running StateCore stack (see examples/README.md), curl, jq.
#
#   STATECORE_URL   API base URL   (default http://localhost:3002)
#   STATECORE_USER  x-user-id      (default local-dev-user)
set -euo pipefail

URL="${STATECORE_URL:-http://localhost:3002}"
USER_ID="${STATECORE_USER:-local-dev-user}"
H_AUTH=(-H "x-user-id: ${USER_ID}")
H_JSON=(-H "content-type: application/json")

say() { printf '\n=== %s ===\n' "$1"; }

say "health"
curl -fsS "${URL}/health" | jq .

say "create scope"
SCOPE_ID=$(curl -fsS "${H_AUTH[@]}" "${H_JSON[@]}" -X POST "${URL}/v1/scopes" \
  -d '{"name":"quickstart-demo","goal":"ship the beta","template":"project"}' | jq -r .id)
echo "scopeId=${SCOPE_ID}"

say "ingest a document"
curl -fsS "${H_AUTH[@]}" "${H_JSON[@]}" -X POST "${URL}/v1/memory/events" \
  -d "{\"scopeId\":\"${SCOPE_ID}\",\"type\":\"document\",\"source\":\"api\",\"key\":\"plan\",\"content\":\"goal: ship the beta. decision: use postgres for storage. todo: write integration tests.\"}" | jq .

say "ingest a stream event"
curl -fsS "${H_AUTH[@]}" "${H_JSON[@]}" -X POST "${URL}/v1/memory/events" \
  -d "{\"scopeId\":\"${SCOPE_ID}\",\"type\":\"stream\",\"source\":\"api\",\"content\":\"we decided to use redis for the job queue\"}" | jq .

say "trigger a digest (async job)"
curl -fsS "${H_AUTH[@]}" "${H_JSON[@]}" -X POST "${URL}/v1/memory/digest" \
  -d "{\"scopeId\":\"${SCOPE_ID}\"}" | jq .
echo "waiting for the digest worker..."; sleep 8

say "retrieve grounded evidence"
curl -fsS "${H_AUTH[@]}" "${H_JSON[@]}" -X POST "${URL}/v1/memory/retrieve" \
  -d "{\"scopeId\":\"${SCOPE_ID}\",\"query\":\"what storage did we choose?\",\"limit\":10}" | jq .

say "current stable state"
curl -fsS "${H_AUTH[@]}" "${URL}/v1/memory/stable-state?scopeId=${SCOPE_ID}" | jq .

say "done"
```
(If Step 1 showed `GET /v1/memory/stable-state` takes the scope differently — e.g. a header or a different param name — fix the last curl accordingly. Same for any event/retrieve field-name differences.)

- [ ] **Step 3: Write `examples/README.md`**

```markdown
# StateCore quickstart example

`quickstart.sh` walks the core memory loop against the frozen `/v1` API:
create a scope → ingest a document + a stream event → trigger a digest →
retrieve grounded evidence → read the stable state.

## Prerequisites (cold start)

1. Start the stack (Postgres + Redis + API + worker):
   ```bash
   docker compose -f docker-compose.local.yml up -d
   ```
   (or run `pnpm start` per the root README, with your `.env` configured).
2. Apply migrations if not auto-applied (see deploy.md).
3. Confirm health: `curl http://localhost:3002/health` returns ok.
4. Digest/retrieve quality needs LLM features enabled (`FEATURE_LLM=true` + a
   model key in `.env`); without them the digest step is a no-op and retrieve
   falls back to heuristic ranking.

## Run

```bash
STATECORE_URL=http://localhost:3002 STATECORE_USER=local-dev-user \
  bash examples/quickstart.sh
```

Requires `curl` and `jq`. The script exits on the first error (`set -euo pipefail`),
so a clean run end-to-end is itself a functional cold-start check.

For deeper smoke checks see `scripts/smoke-*.sh`.
```

- [ ] **Step 4: Validate the script (no live stack required)**

Run: `bash -n examples/quickstart.sh` (syntax check) and, if available, `shellcheck examples/quickstart.sh`.
Expected: no syntax errors / no shellcheck errors. (Do NOT claim a live run unless a stack is actually up — the README documents the manual run.)

- [ ] **Step 5: Commit**

```bash
chmod +x examples/quickstart.sh
git add examples/quickstart.sh examples/README.md
git commit -m "docs(examples): add /v1 quickstart worked example + cold-start guide"
```

---

### Task 2: STABILITY.md + README link

**Files:**
- Create: `STABILITY.md`
- Modify: `README.md` (one link near the top / API section)

**Interfaces:** none.

- [ ] **Step 1: Write `STABILITY.md`**

```markdown
# Stability Policy

As of **v1.1.0**, StateCore's `/v1` HTTP API is **frozen**.

## What "frozen" means

- **The `/v1` contract is additive-only.** New endpoints and new *optional*
  response fields may be added. Existing endpoints, request/response shapes,
  semantics, and the error model will not change or be removed within `/v1`.
- **Only patch-level fixes break this**, and only for bugs or security issues —
  never as a feature-driven contract change.
- A future incompatible contract becomes a new version namespace (e.g. `/v2`),
  never a silent change to `/v1`.

## What is explicitly NOT frozen

The **digest / drift algorithm** (how the State Layer summarizes events into
stable state, the merge/novelty/consistency heuristics) is an internal
implementation detail, **not** part of the `/v1` contract. It will keep
improving — driven by real usage data — via minor/patch releases. These
improvements may change the *content* of digests/state for the better while
keeping the `/v1` request/response contract unchanged.

This is the single intended surface of ongoing change: real-data-driven
improvements to the core algorithm that remain non-breaking to `/v1`.

## Versioning

Semantic versioning. Additive features → minor; bug/security/algorithm-quality
fixes → patch; an incompatible `/v1` change would require a major + a new API
version namespace.
```

- [ ] **Step 2: Link it from README.md**

Add a line in `README.md` near the `/v1` API section (the endpoint table around line 105) or the top:
```markdown
> **API stability:** the `/v1` API is frozen as of v1.1.0 — see [STABILITY.md](STABILITY.md).
```

- [ ] **Step 3: Verify links**

Run: `grep -n "STABILITY.md" README.md` (link present) and confirm `STABILITY.md` exists.
Expected: both present; no other doc references a non-existent path introduced here.

- [ ] **Step 4: Commit**

```bash
git add STABILITY.md README.md
git commit -m "docs: add STABILITY.md (/v1 frozen at v1.1.0, algorithm evolvable) + README link"
```

---

### Task 3: CHANGELOG rewrite + version bump to 1.1.0

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `package.json`, `apps/api/package.json`, `apps/worker/package.json`, `packages/core/package.json`, `packages/db/package.json`, `packages/contracts/package.json`, `packages/prompts/package.json` (every `"version": "1.0.0"` → `"1.1.0"`)

**Interfaces:** none.

- [ ] **Step 1: Replace the stale `[Unreleased]` block in CHANGELOG.md**

The current `## [Unreleased]` section lists features for REMOVED apps (`apps/adapter-mcp`, cli, demo-web, etc.) and is wrong. Replace the entire `## [Unreleased]` section (everything from `## [Unreleased]` down to — but NOT including — `## [1.0.0] - 2026-03-18`) with:

```markdown
## [1.1.0] - 2026-06-22

Freeze-readiness release. The `/v1` API is now frozen — see STABILITY.md. This
release is additive + internal hardening only; the `/v1` contract is unchanged
since 1.0.0.

### Changed / Removed
- Trimmed the runtime to `apps/api` + `apps/worker` + `packages/*`. Removed the
  peripheral apps (demo-web, adapter-telegram, cli, adapter-mcp) and demo-only
  code paths.
- Removed the in-process rate limiter — rate limiting now belongs to the hosting
  gateway/reverse proxy (the open core no longer rate-limits in-process). `429`
  was never part of the `/v1` contract.

### Added
- Drift-control robustness: property-based (fast-check) + adversarial regression
  tests over the digest-control pure functions; deterministic `idFactory`/`nowFactory`.
- Multi-instance safety: `rebuild_digest_chain` now runs under the distributed
  digest-lock; the periodic maintenance tasks run as cluster-safe BullMQ repeatable
  jobs; the runtime recall caches are bounded (`BoundedTtlCache`).
- pgvector **HNSW index** on embeddings, with the vector query aligned to the
  cosine operator so the index is used at scale.
- Per-stage latency logs for retrieve and digest (`retrieveTimings`/`digestTimings`).
- Request body size limit (`MAX_REQUEST_BODY_BYTES`, default 1 MB) with clean
  413 (too large) / 400 (malformed JSON) responses.
- Daily data-lifecycle GC (`data_gc`): prunes old digest/snapshot history (always
  keeping the latest per scope), old job logs, and terminal reminders.
- `examples/quickstart.sh` — a runnable `/v1` worked example.
- `STABILITY.md` — the `/v1` freeze + stability policy.

### Fixed
- `consistencyCheck` no longer false-flags `goal_contradiction` when a summary
  appends prose after the goal.
- digest + state snapshot are now written atomically in a transaction.
```

(Keep the `## [1.0.0] - 2026-03-18` section and everything below it exactly as-is.)

- [ ] **Step 2: Confirm no stale removed-app references remain in the new content**

Run: `grep -n "adapter-mcp\|demo-web\|adapter-telegram\|\bcli\b" CHANGELOG.md`
Expected: matches only inside the historical `[1.0.0]` section (or the one factual "Removed ... adapter-mcp" line in [1.1.0]) — NOT as current/unreleased features.

- [ ] **Step 3: Bump all package.json versions to 1.1.0**

In each of the 7 files, change `"version": "1.0.0"` to `"version": "1.1.0"`:
`package.json`, `apps/api/package.json`, `apps/worker/package.json`, `packages/core/package.json`, `packages/db/package.json`, `packages/contracts/package.json`, `packages/prompts/package.json`.
Run: `grep -rn "\"version\": \"1" package.json apps/*/package.json packages/*/package.json` to confirm all are `1.1.0`.

- [ ] **Step 4: Verify nothing runtime changed + suites green**

Run: `git diff --stat` — confirm only CHANGELOG.md + the 7 package.json changed in this task (no src/contract/snapshot).
Run: `pnpm --filter @statecore/api test` (snapshot tests must stay green — version bumps don't touch the OpenAPI doc body; confirm).
Expected: green, snapshots unchanged.

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md package.json apps/api/package.json apps/worker/package.json packages/core/package.json packages/db/package.json packages/contracts/package.json packages/prompts/package.json
git commit -m "release: v1.1.0 — rewrite CHANGELOG for the trimmed/hardened runtime, bump versions"
```

---

## Post-merge (controller, NOT a subagent task)

After all tasks pass review and the branch merges to `main`, the controller creates the local annotated tag (not pushed):
```bash
git tag -a v1.1.0 -m "StateCore v1.1.0 — /v1 frozen (additive-only); digest/drift algorithm stays evolvable. Freeze-readiness S1–S5 complete."
```

---

## Self-Review

**Spec coverage:**
- Spec §1 (quickstart.sh + examples/README, env-configurable, doubles as cold-start) → Task 1. ✓
- Spec §2 (cold-start documented, honest scope: syntax/shellcheck only, no false live-run claim) → Task 1 Steps 3–4. ✓
- Spec §3 (CHANGELOG rewrite, real [1.1.0], keep [1.0.0]) → Task 3 Steps 1–2. ✓
- Spec §4 (STABILITY.md + README link, /v1 frozen + algorithm evolvable) → Task 2. ✓
- Spec §5 (version bump 1.1.0 across 7 package.json; local tag, post-merge, not pushed) → Task 3 Step 3 + Post-merge section. ✓
- Spec "no runtime/contract change, snapshots unchanged" → Global Constraints + Task 3 Step 4 verifies. ✓

**Placeholder scan:** No TBD. Task 1 Step 1 is a verify-and-adapt instruction (confirm the exact /v1 shapes, fix the draft if they differ) with the concrete draft given — not a placeholder. All doc/script content is shown in full.

**Type consistency:** Endpoint paths/methods/headers in quickstart.sh (`POST /v1/scopes`/`events`/`digest`/`retrieve`, `GET /v1/memory/stable-state`, `x-user-id`) match the controllers cited in Global Constraints. Version string `1.1.0` consistent across CHANGELOG header, STABILITY.md, package.json bumps, and the post-merge tag. The CHANGELOG [1.1.0] bullets match the S1–S5 + patch work as merged.
