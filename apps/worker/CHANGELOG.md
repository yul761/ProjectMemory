# @statecore/worker

## 1.2.1

### Patch Changes

- Close the three gaps 1.2.0 left open.

  **Contradiction accumulation now has a defence.** Two incompatible facts could
  sit in the same protected facet indefinitely; nothing looked at the resulting
  state, only at the digest's prose. Consolidation — which already runs on every
  digest that touches a facet — now receives each item's provenance and is
  instructed to resolve contradictions by keeping the document-sourced side. The
  losing side is retired as `consolidation_dropped`, so the rejected belief stays
  on the record. No additional model call.

  **A tenant's pack can now drive the classifier.** A pack could declare
  `routesFrom: ["case_event"]`, but nothing ever emitted `case_event`: the four
  built-in DomainConfigs are the only classification vocabularies, and each names
  its own. When a tenant has installed a custom pack, the classification prompt is
  now derived from the types that pack routes from. Tenants on the default pack
  keep their DomainConfig prompt unchanged.

  **Grounding evidence reports its own truncation.** `eventSnippets` shows the
  first five events behind an answer; it now also carries `eventSnippetsTotal`.
  Answering "here is why I said that" with 5 of 30 and no indication is the same
  silent truncation this engine exists to avoid.

  Audit note: the retrieval layer was reviewed for silent loss and none was found
  — every limit there is either the caller's requested `limit` or already reported
  in the `retrieval` metadata.

- Updated dependencies []:
  - @statecore/core@1.2.1
  - @statecore/prompts@1.2.1

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

### Patch Changes

- Updated dependencies []:
  - @statecore/core@1.2.0
  - @statecore/prompts@1.2.0
  - @statecore/db@1.2.0
