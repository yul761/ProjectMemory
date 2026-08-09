---
"@statecore/contracts": minor
"@statecore/api": minor
---

Bring three already-live `/v1` endpoints under the frozen contract

`POST /v1/memory/notes`, `GET /v1/memory/relationship-context/:scopeId`, and
`DELETE /v1/scopes/:id` were dual-mounted at `/v1` but absent from
`PublicV1Contracts`, so the snapshot guard never saw them. The path advertised a
compatibility promise the surface did not make, and no caller could tell from
the outside. All three carry production traffic — check-ins read the whole
relationship context, and account deletion is the erasure path.

`relationship-context` is frozen narrowed, like `RetrieveOutput`: `personaPrompt`
keeps being returned but stays outside the promise. It is a statement about how a
client should speak, sourced from the scope's domain template — a product concern
that does not belong in a memory engine's contract.

Also fixes the OpenAPI success code, which was derived from "is this a GET" and
so gave `DELETE` a 201; and adds a test pinning the `docs/api.md` table to the
registry, which had silently disagreed with it since the `1.1.0` endpoints landed.

Contract `info.version` 1.3.0 -> 1.4.0. Purely additive: across both regenerated
snapshots the only removed line is the version string itself.
