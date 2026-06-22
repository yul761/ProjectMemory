# StateCore superpowers specs & plans

This directory holds dated design specs (`specs/`) and implementation plans
(`plans/`) produced via the brainstorm → plan → execute workflow.

## Current canonical: Core Readiness (2026-06-21)

The **StateCore Core Readiness** program is the current canonical direction for
getting the core to a release-ready ("terminal") state so the commercial stack
(hosted version → GPT-API layer → app) can be built on top additively:

- Umbrella: `specs/2026-06-21-statecore-core-readiness-design.md`
- W1 Tenant isolation — umbrella spec (W1), `plans/2026-06-21-w1-tenant-isolation.md`
- W2 Public API `/v1` freeze — `specs/2026-06-21-w2-public-api-contract-freeze-design.md`, `plans/2026-06-21-w2-public-api-contract-freeze.md`
- W3 Quality & observability — `specs/2026-06-21-w3-quality-observability-design.md`, `plans/2026-06-21-w3-quality-observability.md`
- W4 Cleanup & positioning — `specs/2026-06-21-w4-cleanup-positioning-design.md`, `plans/2026-06-21-w4-cleanup-positioning.md`

## Older docs

Earlier dated specs/plans are historical development artifacts, kept in place
(not archived) — the dated filenames and git history are the timeline. Where a
designed-but-unbuilt feature could be mistaken for a gap, its spec carries a
`Status` note (e.g. SQLite-lite mode is shelved; P2b-inferred is designed,
awaiting data).
