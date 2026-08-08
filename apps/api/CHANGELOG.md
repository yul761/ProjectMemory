# @statecore/api

## 1.5.0

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

### Patch Changes

- Updated dependencies [[`8317037`](https://github.com/yul761/StateCore/commit/8317037e34aae3eb2933f8db8676c3a7dc77b35f), [`0d6d75d`](https://github.com/yul761/StateCore/commit/0d6d75d0e2c4a0758149b6f5be99a1bdce97ea4a)]:
  - @statecore/core@1.4.0
  - @statecore/contracts@1.3.0

## 1.4.2

### Patch Changes

- Updated dependencies []:
  - @statecore/db@1.3.0
  - @statecore/core@1.3.1

## 1.4.1

### Patch Changes

- `GET /v1/facet-pack` accepts a `scopeId`.

  Ontology is resolved per scope — a scope's template selects it — so answering
  only at the account level told a caller with a health scope and a personal scope
  about neither. The response now also reports which layer decided: the scope's
  `template`, an `account` override, or the `deployment-default`.

## 1.4.0

### Minor Changes

- Give every domain the facets its classifier vocabulary routes into.

  Scope templates and facet packs were two extensibility mechanisms at two
  granularities, and only `personal` happened to line up. `health` classified
  events as `medical_fact`, `learning` as `knowledge_claim`, `project` as
  `decision` — and the account-level pack routed from none of them, so for three
  of the four templates (including the default) stage-1 classification produced
  labels that landed nowhere.

  A domain now carries both halves. `project`, `health` and `learning` gain facet
  packs whose `routesFrom` names their own entity types, and a scope's pack is
  resolved from its template — one choice, already in the public contract and
  already self-service, settling both the input and the state vocabulary.

  An account-level `User.facetPack` still wins when set, for a tenant whose domain
  none of the built-ins describe.

  This means one account can run several scopes with different ontologies, which
  is what a customer building more than one product needs. Note that API keys do
  not scope: every key on an account can reach all of its scopes, so keys are a
  rotation mechanism, not an isolation boundary.

### Patch Changes

- Updated dependencies []:
  - @statecore/core@1.3.0

## 1.3.1

### Patch Changes

- Stop a single transient failure from making an event invisible to search.

  Jobs were enqueued with no options, so BullMQ's default of one attempt applied.
  For `embed_event` that meant one rate limit or timeout left the event
  permanently absent from semantic search — stored, retrievable by keyword, and
  silently missing from every vector query, with only a log line to say so. Jobs
  now retry three times with exponential backoff.

  `GET /metrics/digest/:scopeId` gains an `embeddings` block reporting how many of
  a scope's events have no embedding, so a gap that survives the retries can be
  found rather than guessed at.

## 1.3.0

### Minor Changes

- Expose the tenant's facet ontology.

  New: `GET /v1/facet-pack` returns the account's active pack — its facets, their
  capacity, whether conversation may overwrite them, whether they take facts only
  from documents, and which classifier types route into them.

  Read-only by design. Swapping a pack is destructive in a way a button should not
  be: facts in facets the new pack does not define stop being displayed, and new
  ones are rejected. Installing a pack stays an operator action until there is a
  second tenant that actually needs self-service.

  Deliberately not added to `PublicRuntimeRoutes`, so the shape stays free to
  evolve while the pack model is young.

## 1.2.1

### Patch Changes

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
  - @statecore/contracts@1.2.0
  - @statecore/prompts@1.2.0
  - @statecore/db@1.2.0
