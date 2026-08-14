# Assistant Runtime Specification

This document defines the intended assistant runtime layer for StateCore.

StateCore should not stop at exposing low-level memory primitives. It should provide a developer-facing runtime that makes long-term memory usable without forcing every integrator to rebuild the same ingestion, recall, prompt assembly, answer grounding, and digest-trigger logic.

In the current architecture, the assistant runtime is the Fast Layer orchestrator.
It should return quickly while Working Memory and State Layer updates continue in the background.

## Purpose

The assistant runtime exists to turn the memory system into a practical integration layer.

Its job is to standardize:

- how messages become memory events
- how recall is assembled before answer generation
- how and when memory is written
- how digesting is triggered
- how answers stay grounded in memory

The runtime should reduce glue code without turning the project into a generic agent orchestration framework.

The current runtime also exposes explicit decision metadata so callers can inspect:

- whether the answer came from `direct_state_fast_path` or `llm_fast_path`
- whether the retrieval plan was `none`, `light`, or `full`
- which Working Memory and State Layer versions were visible to the turn
- whether Working Memory and State Layer are currently aligned through the aggregated `GET /memory/layer-status` diagnostic
- whether the current turn itself saw layer warnings, without requiring a second diagnostic read

## Position in the Architecture

StateCore should be understood as four layers:

1. model layer
2. memory runtime layer
3. interaction layer
4. evaluation layer

The assistant runtime belongs in the memory runtime layer.

It sits above raw endpoints like:

- `POST /memory/events`
- `POST /memory/retrieve`
- `POST /memory/digest`
- `POST /memory/answer`

And below interaction surfaces like:

- external client integrations
- future reference apps

## Why a Runtime Layer Is Needed

The current repository already provides useful primitives, but an integrator still has to decide:

- what counts as a memory-worthy turn
- how to map a user message into stream or document events
- when recall should run
- how much memory should be included in the answer prompt
- when to trigger digest generation
- how to return evidence with an answer

If every developer solves these questions differently, StateCore remains a memory toolkit rather than a reusable runtime.

## Runtime Goals

The assistant runtime should optimize for:

- low integration overhead
- explicit memory policy
- evidence-backed answers
- compatibility with local or bring-your-own model providers
- low drift over long-running use

## Core Concepts

### AssistantSession

`AssistantSession` is the primary runtime unit.

It represents a scoped, memory-aware interaction loop for one user and one project or conversation scope.

Responsibilities:

- receive new conversation turns
- resolve recall for the current turn
- apply memory write policy
- trigger answer generation
- schedule Working Memory updates
- schedule or trigger State Layer digesting
- return answer output with evidence

Working Memory updates are intentionally lower-trust than State Layer digesting.
The current extractor prefers user-authored and document-backed signals, and ignores assistant reply text when building short-term structured state so the runtime does not reinforce its own generations as memory.

Minimum semantics:

- bound to `userId`
- bound to `scopeId`
- associated with a model provider and runtime policies

### ConversationTurn

A `ConversationTurn` is a single user-input and assistant-output cycle.

It should include:

- user message
- optional assistant reply
- timestamps
- optional metadata such as source, channel, tags, or attachments

The runtime should not assume every turn becomes long-term memory.

### MemoryWritePolicy

`MemoryWritePolicy` decides how conversation content enters memory.

This is critical because writing everything into long-term memory increases noise and drift.

Recommended write tiers:

- `ephemeral`: useful only for the immediate turn
- `candidate`: worth considering for digest inclusion
- `stable`: likely to become long-lived state
- `documented`: should be treated like durable document memory

The runtime should support rules that map incoming content into these tiers.

### RecallPolicy

`RecallPolicy` determines what memory is gathered before answer generation.

At minimum, recall should consider:

- the latest digest
- State Layer snapshot/view
- Working Memory snapshot/view
- recent events
- recent turns
- relevant documents

As retrieval evolves, this policy may also include vector or hybrid ranking. The runtime should keep the policy boundary explicit so retrieval improvements do not silently change answer behavior.

### DigestPolicy

`DigestPolicy` determines when and how digesting is triggered.

Possible triggers:

- after a fixed number of candidate events
- after important decisions or constraints
- on a timer
- on explicit manual request
- after document updates

The runtime should be able to expose these choices rather than baking in one hardcoded rule.

### GroundedAnswer

A runtime answer should not just return free-form text. It should be able to return an evidence-backed answer object.

Recommended shape:

```ts
interface GroundedAnswer {
  answer: string;
  evidence: {
    digestIds: string[];
    eventIds: string[];
    stateRefs: string[];
  };
  notes?: string[];
}
```

The exact schema can evolve, but the runtime should preserve the idea that answers can be traced to memory sources.
The current implementation already goes slightly beyond ids by returning lightweight `digestSummary`, `eventSnippets`, a `stateSummary`, and structured `stateDetails` derived from the latest digest snapshot when available. Those `stateDetails` include both raw `recentChanges` and a compact transition taxonomy so callers can audit state evolution without reparsing the list themselves.

## Recommended Runtime Flow

The runtime for a single turn should roughly follow this sequence:

1. Receive a user message.
2. Resolve Fast Layer context from recent turns, retrieval, Working Memory, and State Layer.
3. Generate and return the answer immediately.
4. Classify the message for memory write intent.
5. Persist raw turn artifacts in the background.
6. Enqueue a Working Memory update.
7. Trigger State Layer digesting if `DigestPolicy` conditions are met.
8. Return answer text plus evidence information and layer metadata.

For product debugging, that returned metadata is now part of the contract rather than something you have to infer from logs.

## Suggested Runtime Interfaces

The names below are intentionally simple and reflect the roadmap direction.

```ts
interface AssistantSession {
  userId: string;
  scopeId: string;
  handleTurn(input: RuntimeTurnInput): Promise<GroundedAnswer>;
}

interface RuntimeTurnInput {
  message: string;
  source?: string;
  metadata?: Record<string, unknown>;
}

interface MemoryWritePolicy {
  classifyTurn(input: RuntimeTurnInput): Promise<"ephemeral" | "candidate" | "stable" | "documented">;
}

interface RecallPolicy {
  resolve(input: RuntimeTurnInput): Promise<ResolvedRecall>;
}

interface DigestPolicy {
  shouldDigest(input: RuntimeTurnInput, context: RuntimeTurnContext): boolean | Promise<boolean>;
}
```

These are now beginning to exist in the repository as a minimal core runtime abstraction in `packages/core/src/assistant-runtime.ts`.

The current implementation is intentionally small:

- `AssistantSession`
- `DefaultMemoryWritePolicy`
- `DefaultRecallPolicy`
- `ThresholdDigestPolicy`

The current runtime output now also exposes lightweight layer metadata:

- `workingMemoryVersion`
- `stableStateVersion`
- `usedFastLayerContextSummary`

The current runtime turn input also supports explicit policy hints:

- `policyProfile`
- `policyOverrides`
- `writeTier`
- `documentKey`
- `digestMode`

Current built-in profiles:

- `default`
- `conservative`
- `document-heavy`

Current per-turn overrides:

- `recallLimit`
- `promoteLongFormToDocumented`
- `digestOnCandidate`

The current runtime output also carries lightweight audit notes so policy decisions are inspectable, for example:

- why a turn was classified as `candidate` or `stable`
- whether digesting was forced, skipped, or triggered by policy

The current runtime evidence object is also structured enough for lightweight grounding inspection:

- digest ids plus digest summary text
- event ids plus short event snippets
- state refs plus a state-summary marker

It is a starting boundary, not a finished runtime surface.

## Mapping to the Current Repository

The primitives:

- scopes as the session boundary
- `/v1/memory/events` for ingestion
- `/v1/memory/retrieve` for baseline recall, optionally within a `maxChars` budget
- `/v1/memory/answer` for answer generation
- `/v1/memory/digest` for digest triggering
- the HTTP API as the integration boundary

The abstraction that composes them **now exists**: `AssistantSession` in
`packages/core/src/assistant-runtime.ts`, exposed as
`POST /v1/memory/runtime/turn`. That endpoint is part of the frozen `/v1`
contract, narrowed to its stable top-level fields — `answer`, `answerMode`,
`writeTier`, `digestTriggered`. The diagnostic fields it also returns
(`layerAlignment`, `retrievalPlan`, `evidence`, `notes`, `warnings`) are
deliberately outside the promise and may change without notice.

Grounding evidence reports `eventSnippetsTotal` alongside the snippets it shows,
so an answer displaying 5 of 30 says so rather than implying it had five.

> **Model constraint.** The runtime turn sends `reasoning_effort` on every
> request — `assistant-runtime.ts` defaults it to `"low"` rather than leaving it
> unset — so on OpenAI this endpoint requires a model that accepts the parameter.
> `gpt-4o*` models reject it. Digest and answers do not send it unless
> `MODEL_STRUCTURED_OUTPUT_REASONING_EFFORT` is set, so a deployment configured
> with a gpt-4o model looks healthy until its first runtime turn.

## Runtime Write Policy

Not every message should be treated as durable memory.

The runtime should prefer a write policy like this:

### Ephemeral

Use for:

- chit-chat
- acknowledgements
- one-off requests with no project relevance
- transient clarification

Ephemeral content may influence the immediate answer, but should not automatically become long-term memory.

### Candidate

Use for:

- plausible project updates
- intermediate work notes
- partially important observations

Candidate content should be stored as events and allowed into digest selection, but not automatically promoted to stable facts.

### Stable

Use for:

- explicit goals
- constraints
- decisions
- persistent preferences or project rules

Stable content should be favored by digest selection and protected state evolution.

### Documented

Use for:

- canonical project plans
- specs
- updated reference documents
- durable written notes

Documented content should usually map to document memory rather than ordinary stream events.

## Runtime Recall Policy

The runtime should assemble recall in evidence-first order.

Recommended order:

1. protected state
2. latest digest
3. recent high-value events
4. current documents
5. optional retrieval plugins

This keeps answer generation grounded in the most stable memory layers before broader evidence is introduced.

## Runtime Answering Policy

The runtime should treat answering as a memory-backed operation, not just a plain LLM call.

Answer generation should:

- prefer recalled evidence over parametric guessing
- surface uncertainty when evidence is weak
- preserve constraint awareness
- avoid inventing decisions or todos

The runtime should eventually support an option to return:

- answer text
- grounding metadata
- warnings when evidence is weak or conflicting

## Digest Trigger Policy

Digesting should be policy-driven.

Recommended trigger categories:

- count-based: after N candidate or stable events
- importance-based: after decisions or constraints
- document-based: after meaningful document change
- time-based: after a quiet period or fixed interval
- manual: explicit developer request

This is preferable to forcing all integrations into a single cadence.

## Reference Integrations

External clients that call the HTTP API are the intended integration model.

They demonstrate:

- session-scoped interaction
- event ingestion
- digest triggering
- answer retrieval

The API contract (not any specific client) is the product boundary.

## Non-goals

The assistant runtime should not become:

- a general multi-agent framework
- a tool execution planner
- a hosted chat app
- a universal orchestration layer for arbitrary workflows

The runtime exists to standardize memory-aware assistant behavior, not to absorb every assistant concern.

## Relationship to Drift

The assistant runtime is a drift control surface because it decides:

- what enters long-term memory
- what gets recalled
- when digests run
- whether answers are evidence-backed

A poor runtime policy can create drift even when the digest engine itself is good. That is why runtime policy should be explicit and benchmarkable.

## Evaluation Implications

A future runtime-aware benchmark should be able to evaluate:

- write-policy quality
- recall grounding quality
- answer grounding rate
- unsupported claim rate
- drift under different digest trigger cadences

This matters because long-term memory quality is not only a digest problem. It is also a runtime policy problem.

## Suggested Implementation Path

The safest rollout path is:

1. Document the runtime boundary.
2. Build a thin session abstraction on top of existing API primitives.
3. Add write-policy hooks before introducing more complex retrieval.
4. Return evidence metadata from answer paths.
5. Add benchmark fixtures that evaluate runtime policies, not only digest internals.

## Success Criteria

The assistant runtime is successful when a developer can attach StateCore to a local or remote model assistant and avoid rebuilding:

- session handling
- memory write classification
- recall assembly
- answer grounding
- digest trigger logic

At that point, StateCore stops being only a memory engine and becomes a usable long-term memory runtime.
