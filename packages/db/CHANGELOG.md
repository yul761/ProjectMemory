# @statecore/db

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
