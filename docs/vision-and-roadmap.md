# Project Vision, Positioning, and Roadmap

## One-line Direction

StateCore exists to help local or self-hosted models retain critical facts, goals, constraints, decisions, and todos over long-running interaction with as little memory drift as possible.

## Project Definition

StateCore is an open-source, self-hosted, developer-oriented long-term memory runtime.

It does not aim to be the best chat shell, model hosting platform, or general-purpose agent framework. Its purpose is to provide a reusable memory layer that developers can attach to local models, remote models, or OpenAI-compatible endpoints.

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

## North Star

The project should optimize for four outcomes:

- **Retention**: important facts remain available over time.
- **Stability**: goals, constraints, decisions, and todos do not drift or flip unexpectedly.
- **Grounding**: answers should be traceable to memory evidence instead of unsupported model completion.
- **Replayability**: memory state should be inspectable, replayable, auditable, and rebuildable.

These goals map directly to the existing architecture:

- Digest pipeline and control logic
- Protected state evolution
- Snapshot and rebuild capability
- Benchmark and evaluation workflow

## Vision

Enable developers to add a stable, long-term, verifiable memory layer to any local or bring-your-own model assistant, without rebuilding event storage, digesting, recall, state maintenance, drift control, and evaluation from scratch.

## Mission

Build a memory-first runtime that makes long-term assistant memory:

- open and self-hosted
- low-drift by design
- measurable and reproducible
- easy for developers to integrate

## Core Principles

- **Memory-first**: long-term memory is the product, not a side feature.
- **Self-hosted first**: users should not need a centralized memory SaaS.
- **BYOM**: model choice belongs to the developer; StateCore owns the memory layer.
- **Low drift over flashy demos**: stability matters more than broad but shallow features.
- **Evidence over intuition**: memory quality claims should be backed by benchmarks and reproducible methods.
- **Auditable over merely stored**: a fact keeps its evidence and its version history, a fact that leaves the active set is retired rather than deleted, and every discard is recorded with a reason. Losing information is survivable; losing it silently is not.
- **Domain-neutral core**: what a facet means comes from a replaceable pack. The engine stores, protects, supersedes and retrieves without knowing the domain.
- **Developer convenience**: integration cost and setup complexity should stay low.

## Problem Statement

Most models do not maintain stable long-term project memory on their own. Storing chat logs or adding light retrieval does not reliably preserve:

- project goals
- constraints
- decisions
- long-running todos
- continuity across noisy interaction

Developers often end up writing substantial glue code for event storage, summarization, retrieval, prompt assembly, reminders, state maintenance, and evaluation. Even after that effort, it is often hard to answer whether the system actually retained key information, whether it drifted, and whether its answers were grounded in memory.

StateCore addresses this gap by focusing on a memory runtime for local and self-hosted assistants, with explicit drift control and evaluation.

## Target Users

- **Independent developers and hackers** building personal or project assistants on local or self-hosted models.
- **AI application developers** who need a reusable long-term memory layer instead of rebuilding memory infrastructure.
- **Researchers and advanced builders** who want replayability, ablations, benchmark fixtures, and measurable drift analysis.

## Positioning

StateCore is:

- an event store for memory-relevant interaction
- a digest generation and control pipeline
- a protected state evolution layer
- a retrieval and reminder layer
- a rebuild and replay system
- a benchmark and evaluation framework
- an assistant memory runtime

The open-source core is not (these scope the core; the commercial product stack
above it — hosted version, GPT-API layer, app — is a separate layer, see Layered
Model above):

- a model deployment platform
- a general chat UI
- a local model manager
- a generic multi-agent orchestration framework
- a pure RAG knowledge base product
- a centralized hosted memory service

## Strategic Workstreams

The roadmap should follow three parallel workstreams, with clear priority ordering.

### A. Low-drift long-term memory

This is the primary workstream and should dominate prioritization.

Key areas:

- memory write policy
- digest stability
- protected state evolution
- contradiction detection
- rebuild and replay
- drift auditing

### B. Developer usability

This workstream productizes the core system without diluting the memory focus.

Key areas:

- local model integration
- standard API and runtime boundaries
- assistant runtime abstractions
- CLI and adapter reference integrations
- deployment simplicity

### C. Research and evaluation

This is the project's defensibility layer.

Key areas:

- benchmarks
- fixtures
- ablations
- drift metrics
- retention metrics
- reproducibility

## Product Scope

### Core Scope

- Memory ingestion for events, documents, and scoped interaction
- Digest control pipeline
- Protected state for goals, constraints, decisions, risks, questions, and todos
- A replaceable facet ontology, resolved per tenant and scope
- An audit surface: fact provenance, version chains, and the record of what each digest discarded
- Retrieval based on digest, state, and recent events, within an optional caller budget
- Assistant runtime abstractions
- Benchmark and evaluation tooling

### Secondary Scope

- optional vector retrieval
- embedding interfaces
- richer adapters
- desktop or web demos
- IDE integrations

### Non-goals for the Near and Mid Term

These scope the open-source core. The commercial product stack (hosted version,
GPT-API layer, app) lives above the core and is out of scope for this list — see
Layered Model above.

- model download and management
- broad consumer chat UI competition
- enterprise collaboration features
- complex multi-agent orchestration
- centralized hosted platform lock-in
- general-purpose AI operating system ambitions

## Recommended Roadmap

> **Status as of 2026-08-14.** The five phases below were written before any of
> them shipped, and their time horizons have passed. All five have delivered
> their main outputs, so read them as the reasoning behind what exists rather
> than as a work queue.
>
> | Phase | State |
> |---|---|
> | 1. Stabilize the low-drift digest core | Delivered — `docs/drift-definition.md`, a first-class `DigestState` with evidence chains and a fact registry, plus property and adversarial tests over the digest-control pure functions. |
> | 2. Measurable long-term memory evaluation | Delivered internally (`docs/evaluation-metrics.md`, the synthetic eval suite) and externally (`docs/longmemeval.md`, at equal context budget against mem0 OSS). |
> | 3. Assistant runtime | Delivered — `POST /v1/memory/runtime/turn` and `docs/assistant-runtime.md`. |
> | 4. Retrieval without losing low drift | Delivered — hybrid keyword + pgvector behind an HNSW index, CJK tokenization, and a caller-declared `maxChars` budget that reports what it refused. |
> | 5. Pluggable model providers | Delivered — `createModelProvider` and `docs/provider-abstraction.md`. |
>
> **What the phases did not anticipate**, and what the engine now also does: the
> ontology is a replaceable pack rather than a fixed set of facets, and the audit
> surface — fact provenance, digest selection logs, retirement instead of
> deletion — is part of the frozen contract. See `docs/philosophy.md`.
>
> **The open item is measuring the differentiator.** Retention has an external
> number; auditability has none. "Can it still explain a fact it superseded a
> month ago" is not measured by anything here, which the LongMemEval write-up
> says in as many words.

### Phase 1: Stabilize the low-drift digest core

Time horizon: next 1 to 2 months

Goal: turn the current digest pipeline from workable into demonstrably stable.

Priority tasks:

1. Define drift formally.
   - goal drift
   - constraint drift
   - decision drift
   - todo drift
   - answer drift

2. Make `DigestState` a first-class concept.
   - `stableFacts`
   - `workingNotes`
   - `volatileContext`
   - `todos`
   - `evidenceRefs`

3. Strengthen protected state merge behavior.
   - conflict detection
   - fact confidence
   - evidence chains
   - explicit allow-change and deny-overwrite rules

4. Add a digest failure taxonomy.
   - invalid JSON
   - overlong summary
   - repeated changes
   - vague next steps
   - conflicts with stable facts

Expected outputs:

- formal drift definition doc
- digest failure taxonomy
- stronger `DigestState`
- low-drift regression tests

### Phase 2: Build measurable long-term memory evaluation

Time horizon: next 2 to 4 months

Goal: make low drift a measurable claim instead of an intuition.

Priority tasks:

1. Add long-term memory metrics.
   - fact retention rate
   - goal stability rate
   - constraint preservation rate
   - decision continuity rate
   - todo continuity rate
   - digest contradiction rate
   - answer grounding rate
   - rebuild consistency rate

2. Add drift-focused benchmark fixtures.
   - long-running project evolution
   - repeated goal changes
   - noisy conversation interference
   - contradiction injection
   - document version updates
   - temporary task pile-up

3. Run ablations.
   - with or without protected state merge
   - with or without novelty threshold
   - with or without consistency checks
   - with or without classifier
   - drift across different budgets

4. Add trend comparison over time.
   - drift by commit
   - recall regressions
   - digest consistency changes

Expected outputs:

- drift benchmark suite
- long-term memory evaluation template
- regression dashboard direction
- stronger research story

### Phase 3: Turn the memory system into an assistant runtime

Time horizon: next 3 to 5 months

Goal: expose a developer-facing runtime instead of only low-level APIs.

Priority tasks:

1. Define runtime abstractions.
   - `AssistantSession`
   - `ConversationTurn`
   - `MemoryWritePolicy`
   - `RecallPolicy`
   - `DigestPolicy`

2. Add memory write tiers.
   - `ephemeral`
   - `candidate`
   - `stable`
   - `documented`

3. Standardize traceable answers.
   - digest fragments
   - event evidence
   - matched state fragments

4. Upgrade CLI and adapters into reference integrations.

Expected outputs:

- assistant runtime API
- automated memory write and recall flow
- traceable answer mechanism
- improved developer integration experience

### Phase 4: Improve retrieval without sacrificing low drift

Time horizon: next 4 to 6 months

Goal: improve recall quality while preserving evidence-first behavior and auditability.

Priority tasks:

1. Introduce model abstractions.
   - `ChatModel`
   - `StructuredOutputModel`
   - `EmbeddingModel`

2. Add optional vector retrieval.
   - heuristic retrieval
   - digest retrieval
   - vector retrieval
   - hybrid ranking

3. Keep evidence-first ranking metadata.
   - evidence ids
   - ranking reason
   - source type
   - recency factor

4. Measure retrieval impact on drift.
   - hit rate changes
   - drift changes
   - false association risk

Expected outputs:

- embedding interface
- vector retrieval plugin
- hybrid retrieval path
- retrieval evaluation through a drift lens

### Phase 5: Make model providers pluggable without losing focus

This can proceed in parallel where practical.

Goal: support local and remote models while keeping memory, not model hosting, as the product center.

Priority tasks:

1. Replace provider-specific environment assumptions with neutral configuration.
   - `MODEL_PROVIDER`
   - `MODEL_BASE_URL`
   - `MODEL_NAME`
   - `MODEL_API_KEY`

2. Support OpenAI-compatible endpoints first.
   - Ollama
   - LM Studio
   - other local OpenAI-compatible services

3. Add a provider factory so the API and worker do not instantiate provider clients directly.

Expected outputs:

- BYOM configuration
- local model integration guide
- provider abstraction

## Research Priorities

The most valuable long-term research directions are:

- deciding what deserves long-term memory
- defining safe state evolution rules
- drift auditing and early drift detection
- rebuild consistency under the same event history
- cross-model stability comparison for local models

## Success Metrics

### North Star

`Long-term Memory Reliability Score`

A composite score representing:

- whether key information is retained
- whether state remains stable
- whether answers stay grounded
- whether rebuilds remain reproducible

### Core Metric Families

- Retention metrics
  - fact retention rate
  - goal retention rate
  - constraint preservation rate
  - decision continuity rate
  - todo continuity rate

- Drift metrics
  - goal drift rate
  - constraint drift rate
  - decision contradiction rate
  - digest contradiction rate
  - state drift rate

- Grounding metrics
  - answer grounding rate
  - evidence usage rate
  - unsupported claim rate

- Stability metrics
  - rebuild consistency rate
  - digest consistency pass rate
  - snapshot replay stability

- Developer experience metrics
  - time to first memory
  - setup steps count
  - local deployment success rate
  - example integration completion time

## Decision Filter

Every major feature should be checked against four questions:

1. Does it improve long-term memory effectiveness?
2. Does it reduce drift?
3. Does it reduce developer setup cost?
4. Does it improve verifiability or interpretability?

If a proposed feature does not help any of these, it should not be a near-term priority.

## 12-Month Direction

- 0 to 3 months: strengthen digest stability, define drift, and expand memory evaluation.
- 3 to 6 months: ship the first assistant runtime and neutralize provider configuration.
- 6 to 9 months: prototype optional vector or hybrid retrieval and deepen replay analysis.
- 9 to 12 months: publish clearer adoption paths and provide one or two high-quality reference integrations.

## Positioning Statement

StateCore is an open-source, self-hosted long-term memory runtime for developers.

It does not host models. Instead, it gives local or bring-your-own models a low-drift, measurable, replayable memory layer so developers can build assistants with real continuity over time.
