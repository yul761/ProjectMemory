# Technical Overview

This document explains the backend architecture, technology choices, and the three-layer memory workflow.

## Memory Layers

StateCore now separates memory into three explicit layers:

- Fast Layer
  - synchronous prompt-building context for the current turn
  - built from recent turns, retrieval, Working Memory, and State Layer views
- Working Memory Layer
  - lightweight, quickly updated structured state for active work
  - updated independently from the State Layer digest pipeline
- State Layer
  - authoritative long-term memory
  - persisted and consolidated through the controlled digest pipeline

## Stack

- Runtime: Node.js 20+
- Language: TypeScript (strict)
- Monorepo: pnpm workspaces + Turborepo
- API: NestJS (`apps/api`)
- Queue/Jobs: BullMQ + Redis (`apps/worker`)
- Database: PostgreSQL + Prisma (`packages/db`)
- Contracts: Zod schemas (`packages/contracts`)
- Engine: Pure domain logic (`packages/core`)
- Prompt assets: `packages/prompts`
- Integrations: external clients via the HTTP API

## Why This Split

- `packages/core` keeps memory logic independent from transport/UI.
- `apps/api` handles auth, validation, and queueing.
- `apps/worker` runs asynchronous/expensive memory jobs.
- Adapters only call API, never direct DB access.

## End-to-End Workflow

```mermaid
flowchart TD
  U[Client] --> A[API Runtime]
  A --> F[Fast Layer Context Compiler]
  F --> LLM[Answer Model]
  LLM --> A
  A --> U
  A -. background .-> DB[(Postgres)]
  A -. enqueue .-> WMQ[(Working Memory Queue)]
  A -. enqueue .-> SQ[(State Layer Digest Queue)]
  WMQ --> WMW[Working Memory Worker]
  SQ --> SW[State Layer Worker]
  WMW --> DB
  SW --> DB
```

## Turn Lifecycle

1. Runtime loads the latest Working Memory snapshot and State Layer snapshot.
2. Fast Layer compiles the current-turn prompt context.
3. The answer model returns immediately.
4. Runtime returns the response without waiting for the State Layer digest pipeline.
5. In background:
   - events are persisted
   - Working Memory is updated
   - State Layer digest is optionally enqueued

## Fast Layer Response Modes

The Fast Layer now exposes two response modes:

- `direct_state_fast_path`
  - used for canonical state questions such as current goal, constraints, decisions, or open work
  - answers directly from Working Memory, State Layer, or retrieved structured events
  - avoids an extra answer-model call when the answer is already present in memory
- `llm_fast_path`
  - used for open-ended turns that still require model generation
  - stays on the synchronous path, but with compact recall and prompt budgets

The runtime also exposes a retrieval plan for each turn:

- `none`
- `light`
- `full`

This lets developers inspect not just the answer, but why the runtime chose a certain recall strategy.

For product diagnostics, the repository now also exposes `GET /memory/layer-status`,
which aggregates:

- Working Memory version and view
- State Layer version and view
- Fast Layer prompt summary
- retrieval plan
- cross-layer alignment signals

## State Layer Digest Pipeline

The State Layer digest pipeline is intentionally not a single LLM call.

```mermaid
flowchart TD
  E[Recent events + last digest] --> S1[1) Event Selection]
  S1 --> S2[2) Delta Detection]
  S2 --> S3[3) Protected State Merge]
  S3 --> S4[4) LLM Digest Generation]
  S4 --> S5[5) Consistency Check]
  S5 -->|pass| OUT[Persist Digest]
  S5 -->|fail + retries left| S4
  S5 -->|fail + no retries| ERR[Fail job with reason]
```

### 1) Event Selection

- Deduplicate near-identical consecutive stream events.
- Always include latest document version per key (within budget).
- Rank stream events by heuristic importance (decision/constraint/todo keywords).
- Budget controls:
  - `DIGEST_EVENT_BUDGET_TOTAL`
  - `DIGEST_EVENT_BUDGET_DOCS`
  - `DIGEST_EVENT_BUDGET_STREAM`

### 2) Delta Detection

- Compute novelty score of selected event vs last digest summary (token overlap).
- Filter likely-redundant events below threshold.
- Always keep decision/constraint events even when novelty is low.
- Control:
  - `DIGEST_NOVELTY_THRESHOLD`

### 3) Protected State Merge

- Deterministic merge into internal `DigestState`:
  - `stableFacts` (goal, constraints, decisions)
  - `workingNotes` (risks, open questions, context)
  - `todos`
  - `volatileContext`
  - `evidenceRefs`
  - lightweight `provenance`
  - lightweight `recentChanges`
  - `factRegistry` — the per-fact record with its evidence and version chain
  - `profile` — facet name to fact lines, keyed by the active facet pack
- Conservative overwrite rules prevent accidental drift. A write-protected facet
  is not overwritten by a lower-authority source, and a document-authority facet
  takes facts only from documents.
- Facet routing, capacity and protection come from the pack resolved for the
  scope, not from a table in the engine (`packages/core/src/facet-registry.ts`).
- A fact displaced by capacity or by consolidation is **retired, not deleted** —
  the registry keeps it with `retiredAt` and `retiredReason`, so the audit chain
  survives a full facet.
- Anything the merge refuses is appended to a drop log with a reason and
  persisted to `Digest.selectionLog`.

This layer is authoritative.
Working Memory may help the next turn quickly, but it does not overwrite this layer by itself.

### 4) LLM Generation

- Optional classifier stage (`DIGEST_USE_LLM_CLASSIFIER=true`).
- Stage-2 generation receives:
  - previous digest
  - protected state
  - delta candidates
  - latest docs
- Must output strict JSON `{summary, changes, nextSteps}`, plus the profile facts
  it extracted. The facet list in the prompt is generated from the active pack.
- Stage 2 runs one pass per prompt-sized chunk over the whole corpus, threading
  each pass's output forward as the next pass's previous digest, so a corpus
  larger than one prompt is fully seen. `STAGE2_MAX_CHUNKS` bounds the work per
  run; events beyond it wait for the next one.
- Facets touched by the run are then consolidated by a separate LLM pass, which
  resolves contradictions in favour of the document-sourced side and retires the
  loser. It is fail-open: a failed consolidation leaves the facts as they were.

### 5) Consistency Check + Retry

- Validate schema + hard output constraints.
- Reject contradictions against protected stable facts.
- Reject repeated changes and vague next steps.
- Retry with corrective instruction up to:
  - `DIGEST_MAX_RETRIES`

## State Layer Snapshots

After each digest, the worker persists a `DigestStateSnapshot` row. When the next digest runs, the snapshot is used as the previous protected state (fallback to derived state if no snapshot exists). This keeps state evolution deterministic and avoids reconstructing from text when possible.

## Working Memory Snapshots

Working Memory snapshots are stored separately from State Layer snapshots.
They are cheap to update, versioned independently, and designed for fast-turn usefulness rather than durable authority.
The extractor is intentionally conservative:

- it prefers recent user/document events over assistant-generated replies
- it parses structured multi-line turns line by line
- it avoids turning assistant follow-up questions into short-term truth by default

## Rebuild / Backfill

`POST /memory/digest/rebuild` enqueues rebuild job:

- Select events in a time range (`from`, `to`) and strategy.
- Reprocess in chunks (`DIGEST_REBUILD_CHUNK_SIZE`).
- New digests are tagged with `rebuildGroupId`.

## Observability

Worker logs structured stage metrics:

- selection count/time
- classification time (optional)
- delta count/time
- merge time
- generation time
- total pipeline time

Enable debug details with:

- `DIGEST_DEBUG=true`

## Benchmarking and Scoring

Use `pnpm benchmark` to generate reproducible performance/reliability reports.

The benchmark currently measures:
- ingest throughput and latency
- retrieve latency and hit-rate
- fast-turn latency
- working-memory update latency
- State Layer digest success + consistency + latency (when LLM enabled)
- reminder due-to-sent latency

Reports are written to `benchmark-results/` as JSON and Markdown.

## Current Limitations

- Retrieval is heuristic by default. An optional embedding rerank path can reorder the top heuristic candidates without introducing a vector index.
- State extraction is rule-based; no semantic entity graph.

## Extension Paths

- Add embedding/vector retrieval behind current interfaces.
- Add richer state persistence (optional new table) for stronger replay guarantees.
- Add confidence scoring for facts and automated drift audits.
