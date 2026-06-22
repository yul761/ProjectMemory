# W4 — Cleanup & Positioning — Design

Date: 2026-06-21
Status: Approved (brainstorming) → ready for implementation planning
Parent: `docs/superpowers/specs/2026-06-21-statecore-core-readiness-design.md` (W4)

## Context

W4 is the final workstream of StateCore Core Readiness — low-risk cleanup and
documentation reconciliation, so a new contributor sees consistent boundaries.

Investigation narrowed the original W4 list:
- The "one-off scripts" item is mostly moot: `scripts/cleanup-demo-guests.ts` is a
  wired `package.json` script, not stray cruft. No script changes.
- The P2b-inferred spec already carries a data-gate note; it only needs a
  one-line explicit `Status`.
- Archiving completed plans/specs: per decision, NOT physically moved (dated
  filenames + git history are the timeline); a short index suffices.

## Goals

1. The positioning docs reflect the **layered model** (OSS runtime core + a
   commercial product stack on top) and no longer contradict themselves.
2. Stale/dated content is refreshed (CLAUDE.md known-scopes).
3. Paper-only features are explicitly marked (SQLite-lite shelved; P2b-inferred
   designed-not-built).
4. A short index points to the readiness specs as the current canonical set.

## Decisions (from brainstorming)

- **Positioning: surgical edit.** Add a "Layered Model / Product Stack" section
  to `vision-and-roadmap.md` and fix the contradicting non-goals lines — do not
  rewrite the whole doc.
- **No physical archiving.** Keep dated plans/specs in place; add a short
  `docs/superpowers/README.md` index instead.

## Components

### 1. `docs/vision-and-roadmap.md` (+ `ROADMAP.md`)

- Add a **"Layered Model / Product Stack"** section near the top: the open-source
  runtime core keeps its current positioning; the hosted version → GPT-API
  integration layer → frontend app form a commercial stack built **on top** of
  the core via its frozen `/v1` API. They are layers, not competitors.
- Edit the non-goals that now read as contradictions — "centralized hosted
  platform", "broad consumer chat UI competition", "model deployment platform" —
  to clarify they are **not goals of the open-source core**, and that the
  hosted/app stack lives above it (rather than flatly "not a goal of the
  project"). Preserve the document's existing structure.
- `ROADMAP.md`: add one line pointing to the layered model in
  `vision-and-roadmap.md`.

### 2. `CLAUDE.md` — refresh stale known-scopes

- Replace the `## Known scopes (as of 2026-05)` section (DEMS-specific, dated)
  with a short, non-dating note: scopes are per-user and dynamic; list them via
  `GET /scopes` (auth `x-user-id`). This stops the section from going stale.

### 3. Paper-only feature status notes

- `docs/superpowers/specs/2026-05-13-sqlite-lite-mode-design.md`: change/annotate
  the `Status` to **"Shelved — out of terminal scope (production path is
  Postgres + pgvector); see core-readiness W4."**
- `docs/superpowers/specs/2026-06-20-style-learning-inferred-p2b2-design.md`: add
  an explicit `Status: Designed, not implemented (awaiting real usage data)` line
  (the body already explains the data gate).

### 4. `docs/superpowers/README.md` (new)

- A short index: the StateCore Core Readiness program
  (`2026-06-21-statecore-core-readiness-design.md` + W1–W4 specs/plans) is the
  current canonical set. Older dated specs/plans are historical development
  artifacts, kept in place (not archived). One or two sentences + a list of the
  readiness docs.

## Out of scope

- Moving/deleting any plans, specs, or scripts.
- Any code change (W4 is docs-only).
- Re-litigating the OSS vs commercial split beyond reflecting the agreed layered
  model.

## Verification

- `grep -rn "as of 2026-05" CLAUDE.md` returns nothing.
- `vision-and-roadmap.md` contains the layered-model section and the non-goals
  lines no longer flatly forbid the hosted/app stack.
- The SQLite-lite and P2b-inferred specs show the new status lines.
- `docs/superpowers/README.md` exists and lists the readiness docs.
- Docs read cleanly with no internal contradictions. Docs-only — no tests.

## Next step

Decompose into ~2 tasks (positioning docs; housekeeping notes + index) via
writing-plans. This is the last workstream — after it, the Definition-of-Ready
gate is fully met.
