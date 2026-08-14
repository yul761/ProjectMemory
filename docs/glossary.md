# Glossary

This glossary defines core terms used across the StateCore engine.

## Scope
A logical container for memory. Typically a project or domain. All memory events, digests, and reminders are scoped to a scope.

## Memory Event
The smallest unit of memory. Events are append-only or upserted depending on type.

### Stream Event
Append-only event. Good for logs, chat, progress, and quick notes.

### Document Event
Upserted event identified by a `key`. Good for notes, specs, and state summaries. Creating a document event with the same key replaces the previous content.

## Digest
A structured summary that compresses recent events, layered on top of the last digest. Digests are first-class objects stored in the database.

## Digest Rebuild
A recovery workflow that regenerates digest chains for a scope over a time range. Rebuild outputs are marked with a `rebuildGroupId` for traceability.

## Layered Memory
A digesting strategy where each new digest is generated from the last digest plus recent events. This keeps summaries short while preserving long-term context.

## Retrieve
A query that returns a concise memory bundle (latest digest + recent events + active facts). Ranking is hybrid: keyword heuristics plus optional pgvector semantic search, enabled with `RETRIEVE_USE_EMBEDDINGS` and backed by an HNSW index. A caller may declare a `maxChars` budget, in which case the response also reports what did not fit and why.

## Answer
An optional LLM-powered response generated from retrieved memory. If LLM is disabled, `/memory/answer` returns an error.

## Reminder
A scheduled item with a due time and text. The worker periodically checks due reminders and marks them as sent.

## Adapter
A reference integration that converts external signals into memory events. Adapters call the API and never touch the database directly.

## Fact
A single statement the engine believes, held in the `factRegistry` with its evidence, confidence and facet. Facts are bounded to statement length; a whole session or document is refused rather than stored as one fact.

## Facet
A named category a fact belongs to, carrying its own capacity, write protection, display group and the classifier types that route into it.

## Facet Pack
The set of facet definitions in force for a scope, resolved from the scope's template or an account-level override. The engine stores, protects, supersedes and retrieves without knowing what a facet means, so the ontology is replaceable without a migration. Readable at `GET /v1/facet-pack`.

## Supersession
Replacing a fact with a newer version. The old entry stays in the registry with `supersededBy` pointing at its replacement, which is what makes a fact's history walkable in either direction.

## Retirement
A fact leaving the active set **without** a replacement — capacity eviction, consolidation, or an explicit forget. The entry is kept with `retiredAt` and `retiredReason` rather than deleted, so a full facet cannot break the audit chain.

## Provenance
A fact's evidence plus its full version chain, readable from any version in it at `GET /v1/memory/facts/:factId/provenance`.

## Drop Log
The record of what a digest refused to keep and why, against the fixed set of reasons in `packages/core/src/drop-log.ts`: `facet_not_registered`, `cap_evicted`, `cap_rejected_incoming`, `no_display_group`, `protected_lower_authority`, `no_document_evidence`, `fact_too_long`, `consolidation_skipped`. Persisted to `Digest.selectionLog` and readable at `GET /v1/memory/digests/:digestId/selection`. Losing information is survivable; losing it silently is not. (This list is pinned to the code by a test — a new reason must be documented here.)

## Pinned Event
An ingested event marked `pinned`, meaning it must not lose a budget competition. Without it the only tiebreaker among documents is recency, which drops durable inputs first because they are the oldest.
