# W4 — Cleanup & Positioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reconcile the positioning docs to the layered model and refresh stale/paper-only doc content, so StateCore's boundaries read consistently.

**Architecture:** Docs-only. A surgical "Layered Model" section + a clarifying note on each non-goal block reframes the OSS-core scope without rewriting it; housekeeping refreshes CLAUDE.md, marks two paper-only specs' status, and adds a `docs/superpowers/` index. No code, no archiving, no script changes.

**Tech Stack:** Markdown only.

## Global Constraints

- W4 is **docs-only**. Do not change any code, test, script, or `package.json`; do not move/delete any file.
- Surgical edits to `vision-and-roadmap.md` — add the layered-model section and clarifying notes; do NOT rewrite the document or delete the non-goal lists.
- The layered model: open-source runtime core (this repo, keeps its positioning) + a commercial product stack on top (hosted version → GPT-API integration layer → frontend app) built on the frozen `/v1` API. Layers, not competitors.
- Conventional-commit messages, each ending with exactly:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Verification is by reading + grep (no test suite for docs).

## File Structure

- `docs/vision-and-roadmap.md` — add Layered Model section + non-goal clarifying notes (Task 1). (Modify)
- `ROADMAP.md` — one-line pointer to the layered model (Task 1). (Modify)
- `CLAUDE.md` — refresh the stale known-scopes section (Task 2). (Modify)
- `docs/superpowers/specs/2026-05-13-sqlite-lite-mode-design.md` — Shelved status (Task 2). (Modify)
- `docs/superpowers/specs/2026-06-20-style-learning-inferred-p2b2-design.md` — designed-not-built status (Task 2). (Modify)
- `docs/superpowers/README.md` — readiness index (Task 2). (Create)

---

### Task 1: Layered-model positioning

**Files:**
- Modify: `docs/vision-and-roadmap.md`
- Modify: `ROADMAP.md`

- [ ] **Step 1: Read the target file**

Run: `sed -n '1,15p;83,90p;153,161p' docs/vision-and-roadmap.md`
Expected: see the `## Project Definition` block (ends ~line 11), the `StateCore is not:` list (83-90), and the `### Non-goals for the Near and Mid Term` block (153-161). Confirms insertion points.

- [ ] **Step 2: Insert the Layered Model section after Project Definition**

In `docs/vision-and-roadmap.md`, immediately AFTER the Project Definition paragraph that ends with "...local models, remote models, or OpenAI-compatible endpoints." and BEFORE the next `##` heading, insert:

```markdown

## Layered Model: Open Core and Product Stack

StateCore ships as two layers:

- **Open-source runtime core** (this repository): the reusable, self-hosted,
  low-drift memory layer described throughout this document. The Positioning and
  Non-goals sections below scope THIS core.
- **Commercial product stack on top**: a hosted/managed version, a GPT-API
  integration layer, and a frontend app — built on the core through its frozen
  `/v1` API (see `docs/api.md`). These are distinct products layered above the
  open core, not a redefinition of it.

The non-goals below describe the open-source core. They do not forbid the
commercial stack above it; that stack is a separate, additive layer.
```

- [ ] **Step 3: Add a clarifying note to the "StateCore is not" block**

In `docs/vision-and-roadmap.md`, replace this exact block:

```markdown
StateCore is not:

- a model deployment platform
- a general chat UI
- a local model manager
- a generic multi-agent orchestration framework
- a pure RAG knowledge base product
- a centralized hosted memory service
```

with:

```markdown
The open-source core is not (these scope the core; the commercial product stack
above it — hosted version, GPT-API layer, app — is a separate layer, see Layered
Model above):

- a model deployment platform
- a general chat UI
- a local model manager
- a generic multi-agent orchestration framework
- a pure RAG knowledge base product
- a centralized hosted memory service
```

- [ ] **Step 4: Add a clarifying note to the Non-goals heading**

In `docs/vision-and-roadmap.md`, replace this exact line:

```markdown
### Non-goals for the Near and Mid Term
```

with:

```markdown
### Non-goals for the Near and Mid Term

These scope the open-source core. The commercial product stack (hosted version,
GPT-API layer, app) lives above the core and is out of scope for this list — see
Layered Model above.
```

- [ ] **Step 5: Add the ROADMAP.md pointer**

In `ROADMAP.md`, replace this exact line:

```markdown
The canonical product direction now lives in [`docs/vision-and-roadmap.md`](docs/vision-and-roadmap.md).
```

with:

```markdown
The canonical product direction now lives in [`docs/vision-and-roadmap.md`](docs/vision-and-roadmap.md).

StateCore is an open-source runtime core; a commercial product stack (hosted
version, GPT-API layer, app) is built on top via the frozen `/v1` API — see the
"Layered Model" section in `docs/vision-and-roadmap.md`.
```

- [ ] **Step 6: Verify consistency**

Run: `grep -n "Layered Model" docs/vision-and-roadmap.md ROADMAP.md`
Expected: the section in `vision-and-roadmap.md` and the pointer in `ROADMAP.md` both appear.

Run: `grep -n "The open-source core is not\|scope the open-source core\|scope the core" docs/vision-and-roadmap.md`
Expected: the two clarifying notes are present, so the non-goal lists no longer read as flat project-wide prohibitions.

- [ ] **Step 7: Commit**

```bash
git add docs/vision-and-roadmap.md ROADMAP.md
git commit -m "$(cat <<'EOF'
docs(roadmap): reflect the layered model (open core + product stack on top)

Adds a Layered Model section to vision-and-roadmap.md and reframes the non-goals
as scoping the open-source core, so the hosted version / GPT-API layer / app
(built on the frozen /v1 API) no longer read as project-wide non-goals. Adds a
pointer from ROADMAP.md.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Housekeeping — stale content, paper-only status notes, readiness index

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/superpowers/specs/2026-05-13-sqlite-lite-mode-design.md`
- Modify: `docs/superpowers/specs/2026-06-20-style-learning-inferred-p2b2-design.md`
- Create: `docs/superpowers/README.md`

- [ ] **Step 1: Refresh CLAUDE.md known-scopes**

In `CLAUDE.md`, replace this exact block:

```markdown
## Known scopes (as of 2026-05)
- `dems-product` — DEMS product design docs (capability gates, redaction V1)
- `project:dems-ui` — DEMS UI project context
- `project:dems` — DEMS backend project context
```

with:

```markdown
## Scopes
Scopes are per-user and dynamic — do not hardcode a list here. List the current
user's scopes via `GET /scopes` (auth header `x-user-id`).
```

- [ ] **Step 2: Mark SQLite-lite as shelved**

In `docs/superpowers/specs/2026-05-13-sqlite-lite-mode-design.md`, replace this exact line:

```markdown
**Status:** Approved
```

with:

```markdown
**Status:** Shelved — out of terminal scope (production path is Postgres + pgvector); see core-readiness W4 (2026-06-21).
```

- [ ] **Step 3: Mark P2b-inferred as designed-not-built**

In `docs/superpowers/specs/2026-06-20-style-learning-inferred-p2b2-design.md`, find the header blockquote line that begins `> ★ **数据门（§8.4）**` and insert a new blockquote line immediately AFTER it:

```markdown
> Status: Designed, not implemented — awaiting real usage data (core-readiness W4 confirms this is intentional, not a gap).
```

- [ ] **Step 4: Create the readiness index**

Create `docs/superpowers/README.md`:

```markdown
# StateCore superpowers specs & plans

This directory holds dated design specs (`specs/`) and implementation plans
(`plans/`) produced via the brainstorm → plan → execute workflow.

## Current canonical: Core Readiness (2026-06-21)

The **StateCore Core Readiness** program is the current canonical direction for
getting the core to a release-ready ("terminal") state so the commercial stack
(hosted version → GPT-API layer → app) can be built on top additively:

- Umbrella: `specs/2026-06-21-statecore-core-readiness-design.md`
- W1 Tenant isolation — `specs/2026-06-21-statecore-core-readiness-design.md` (W1), `plans/2026-06-21-w1-tenant-isolation.md`
- W2 Public API `/v1` freeze — `specs/2026-06-21-w2-public-api-contract-freeze-design.md`, `plans/2026-06-21-w2-public-api-contract-freeze.md`
- W3 Quality & observability — `specs/2026-06-21-w3-quality-observability-design.md`, `plans/2026-06-21-w3-quality-observability.md`
- W4 Cleanup & positioning — `specs/2026-06-21-w4-cleanup-positioning-design.md`, `plans/2026-06-21-w4-cleanup-positioning.md`

## Older docs

Earlier dated specs/plans are historical development artifacts, kept in place
(not archived) — the dated filenames and git history are the timeline. Where a
designed-but-unbuilt feature could be mistaken for a gap, its spec carries a
`Status` note (e.g. SQLite-lite mode is shelved; P2b-inferred is designed,
awaiting data).
```

- [ ] **Step 5: Verify**

Run: `grep -rn "as of 2026-05" CLAUDE.md`
Expected: no output (stale dated section gone).

Run: `grep -n "Shelved" docs/superpowers/specs/2026-05-13-sqlite-lite-mode-design.md && grep -n "Designed, not implemented" docs/superpowers/specs/2026-06-20-style-learning-inferred-p2b2-design.md && ls docs/superpowers/README.md`
Expected: each status line present; README exists.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-05-13-sqlite-lite-mode-design.md \
  docs/superpowers/specs/2026-06-20-style-learning-inferred-p2b2-design.md \
  docs/superpowers/README.md
git commit -m "$(cat <<'EOF'
docs: refresh stale CLAUDE.md scopes, mark paper-only specs, add readiness index

Replaces the dated DEMS known-scopes block with a dynamic note; marks SQLite-lite
mode shelved and P2b-inferred designed-not-built; adds docs/superpowers/README.md
pointing to the Core Readiness program as canonical.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- Layered-model section + non-goal reconciliation + ROADMAP pointer → Task 1. ✓
- CLAUDE.md stale known-scopes refresh → Task 2 Step 1. ✓
- SQLite-lite shelved status → Task 2 Step 2. ✓
- P2b-inferred designed-not-built status → Task 2 Step 3. ✓
- docs/superpowers index → Task 2 Step 4. ✓

**Placeholder scan:** No TBD/TODO; every edit shows exact old/new text. ✓

**Type consistency:** N/A (docs). Exact-string replacements match the confirmed current file contents. ✓
