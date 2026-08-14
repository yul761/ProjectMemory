---
"@statecore/contracts": minor
"@statecore/api": minor
---

Bring the three audit readers under the frozen contract

`GET /v1/memory/facts/:factId/provenance`, `GET /v1/memory/digests/:digestId/selection`
and `GET /v1/facet-pack` were dual-mounted at `/v1` but absent from
`PublicV1Contracts` — the same drift the previous release closed for `notes`,
`relationship-context` and `DELETE /scopes/:id`, in the endpoints that answer the
question this engine is built to answer. An auditability guarantee whose only
external interface can be renamed without a guard firing is not one a caller can
rely on.

All three carry production traffic: the statecore-cloud gateway proxies them and
the console Inspector reads them. The console parses the fact shape with every
field beyond `content` optional, on the stated grounds that it is not in the
frozen contract — a consumer coding defensively around a promise that was never
made. `provenance` reuses `FactRegistryEntrySchema`, which `RetrieveOutput`
already froze, so that shape has in fact been guaranteed for a while.

`facet-pack` was deliberately held out at contract `1.3.0` to keep a young pack
model free to move. It has since gained `scopeId`, `source` and `template` and
shipped to a consumer; the shape is load-bearing whether or not it is declared,
so it is now declared. `docs/api.md` records why that reasoning expires.

`selection` is frozen at its two top-level arrays only. Drop records carry an
open `reason` set and a free-form `detail`, and the handler normalises the arrays
without validating their items — freezing a record shape would promise validation
the endpoint does not perform.

Contract `info.version` 1.4.0 -> 1.5.0; the surface goes from 18 operations
across 16 paths to 21 across 19. Purely additive: across both regenerated
snapshots the only removed line is the version string itself.
