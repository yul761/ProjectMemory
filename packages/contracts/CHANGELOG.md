# @statecore/contracts

## 1.4.0

### Minor Changes

- [`7447532`](https://github.com/yul761/StateCore/commit/7447532c2cb46a2e55d18790d4a7b3a892198873) Thanks [@yul761](https://github.com/yul761)! - Bring the three audit readers under the frozen contract

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

- [`0c4aa21`](https://github.com/yul761/StateCore/commit/0c4aa21f6dec834a05855659c45f5f8823e79ec3) Thanks [@yul761](https://github.com/yul761)! - Bring three already-live `/v1` endpoints under the frozen contract

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

## 1.3.0

### Minor Changes

- `POST /v1/memory/retrieve` accepts an optional context budget.

  The endpoint took an item count (`limit`) and could not take a budget, so the
  "a few large items or many small ones" tradeoff — the one that decides what a
  caller actually gets at a tight budget — was a decision only the engine could
  make and had no way to hear about. Callers filled the gap themselves: one
  reimplemented it in eighty lines, another simply took the first forty facts.

  Pass `maxChars` and the engine packs within it and reports what it refused, in a
  new top-level optional `budget` field. Ordering is digest, then facts, then
  events. The digest is atomic. Facts take at most `FACT_BUDGET_SHARE` (40%) of
  the budget so raw evidence always has room, and are ranked by relevance to the
  query when one is given — by confidence and recency when it is not. Items are
  included whole or skipped; an item that does not fit never ends the fill, since
  a smaller one ranked below it may still belong.

  Everything refused is recorded with a reason and a score. Exact counts are never
  truncated; the itemised list is bounded at 100 and says how many it omitted. A
  budget means dropping things, and a response that quietly holds less than the
  caller asked for is the defect class this engine exists to remove.

  Additive and optional throughout: a request without `maxChars` gets byte-identical
  behaviour, and the frozen `/v1` surface gains only optional fields.

## 1.2.0

### Minor Changes

- Make the auditability guarantee real, and make the ontology the tenant's.

  This release came out of investigating a LongMemEval comparison whose numbers
  turned out to be an artifact. The investigation found that several of the
  engine's stated guarantees did not hold in the code, so the work is mostly
  repair.

  **Auditability**

  - Fact history survives. `normalizeDigestState` rebuilt the registry as
    `.filter(e => !e.supersededBy).slice(-100)`, and the previous state is
    normalised on every run, so each digest deleted the supersession history it
    inherited — a fact's chain existed only until the next digest. Active facts
    are now never dropped on load, and history is kept to a bounded most-recent
    500 entries.
  - Capacity eviction and facet consolidation retire records instead of deleting
    them. Consolidation runs on every digest that touches a facet, so this was
    breaking the chain on the common path, not a rare one.
  - Every discard is recorded with a reason and persisted to `Digest.selectionLog`.
    Eight places could previously drop information with no trace.
  - New: `GET /v1/memory/facts/:factId/provenance` returns a fact's evidence and
    its full version chain from any version in it.
  - New: `GET /v1/memory/digests/:digestId/selection` returns what a digest kept
    and what it discarded.

  **Drift**

  - Write protection now applies on the path that runs every digest. It existed
    only on the classifier-driven path, so a 0.6-authority sentence from chat could
    supersede a 0.85-authority fact taken from an uploaded document.
  - A document-authority facet with no document in the run no longer writes a fact
    the registry has no record of.
  - The protected-fact contradiction check was dead: key tokens were taken from a
    list that puts ASCII first, so dates ("2019-2022") crowded out the terms that
    identify the fact and the check never fired. Protected facts are full of dates.
  - `checkContradiction` now sees write-protected profile facts, not just
    `stableFacts`.
  - Drift metrics observe the fact registry, where user facts actually live.

  **Ontology**

  - The seven personal-life facets are no longer wired into the engine. They lived
    in eight places that could drift apart; they are now one replaceable pack, and
    the core stores, protects, supersedes and retrieves without knowing what a
    facet means.
  - Packs resolve per tenant from `User.facetPack`, not per process. A cloud
    account maps 1:1 onto a core user, so one deployment can serve customers with
    different ontologies.
  - Facets declare their own stage-1 routing, display group, capacity, protection
    and document authority.

  **Retention**

  - New: `pinned` on an ingested event means it must not lose a budget
    competition. Documents already outranked chat, but they competed with each
    other by recency, so the oldest — typically a durable one like a resume,
    uploaded once — was dropped first.
  - Updated documents re-trigger the digest. The "anything new" check compared
    `createdAt` only, and an upsert keeps it, so re-uploading a corrected document
    changed the stored document and nothing else.
  - Per-facet capacity is configurable via `DIGEST_FACET_CAPS`.

  **Behaviour change worth knowing**

  Conversation can no longer add facts to a document-authority facet (`identity`
  in the default pack) when the run has no document. Previously such facts were
  written to the profile with no registry entry behind them — visible but
  unciteable and impossible to supersede. Updating a document by re-uploading it
  remains the supported path and works. Rejections appear in the selection log as
  `no_document_evidence`.
