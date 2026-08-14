# Provider Abstraction Specification

This document defines the intended model-provider abstraction for StateCore.

StateCore should support local models, remote models, and OpenAI-compatible endpoints without turning into a model hosting platform. The project owns the memory runtime, not the model lifecycle.

## Purpose

The provider abstraction exists to decouple memory logic from any single model vendor or environment variable scheme.

Its goals are:

- support bring-your-own-model usage
- make local and self-hosted setups practical
- avoid hard-coding OpenAI-specific assumptions into the runtime
- keep model integration secondary to the memory system

## Current State in the Repository

The migration this document once recommended is complete. `MODEL_*` is the
primary configuration scheme; `OPENAI_API_KEY` / `OPENAI_BASE_URL` /
`OPENAI_MODEL` survive only as legacy-compatible fallbacks in `env.ts` and should
not appear in new documentation.

Configuration resolves per role, each falling back to the generic `MODEL_*`
values: `MODEL_CHAT_*`, `MODEL_RUNTIME_*` (falls back to chat),
`MODEL_STRUCTURED_OUTPUT_*`, and `MODEL_EMBEDDING_*`. The runtime and
structured-output roles also take `*_REASONING_EFFORT` and
`*_MAX_OUTPUT_TOKENS`.

An API key is required only when the resolved base URL is `api.openai.com`
(`requiresApiKeyForBaseUrl` in `apps/api/src/env.ts`); a local endpoint without
auth is a supported configuration, and the startup errors name the `MODEL_*`
variables first.

The code paths that own this: `apps/api/src/env.ts`, `apps/worker/src/env.ts`,
and `packages/core/src/model-provider.ts` (`createModelProvider`).

## Design Principle

Provider abstraction should make model choice a configuration concern, not a memory architecture concern.

StateCore should continue to own:

- event ingestion
- digest control
- protected state
- retrieval
- answer grounding
- replay and evaluation

StateCore should not take ownership of:

- model downloads
- model serving infrastructure
- GPU orchestration
- provider account lifecycle

## Product Positioning Rule

The provider layer is important, but it is not the product center.

Provider support should be judged by one question:

Does this make the memory runtime easier to use with local or self-hosted models without distracting from low-drift memory?

If not, it is not a near-term priority.

## Configuration Model

The neutral scheme is the shipped scheme. The base variables:

- `MODEL_PROVIDER`
- `MODEL_BASE_URL`
- `MODEL_NAME`
- `MODEL_API_KEY`
- `MODEL_TIMEOUT_MS`

Role separation happened *inside* the `MODEL_*` namespace rather than through a
parallel `EMBEDDING_*` scheme: `MODEL_CHAT_*`, `MODEL_RUNTIME_*`,
`MODEL_STRUCTURED_OUTPUT_*`, `MODEL_EMBEDDING_*`, each falling back to the base
values. The per-variable semantics below remain accurate.

## Recommended Provider Modes

### OpenAI-compatible First

The first and most practical abstraction target is OpenAI-compatible APIs.

That includes:

- OpenAI
- Ollama adapters that expose OpenAI-compatible endpoints
- LM Studio
- other local OpenAI-compatible gateways

This is the right first step because it gives broad compatibility with low implementation complexity.

### Provider-specific Adapters Later

Direct provider adapters should only be added when they clearly improve:

- local model usability
- memory evaluation comparability
- reliability of structured outputs

They should not be added just to expand the provider matrix.

## Runtime Abstraction Boundaries

The runtime separates four model roles, each independently configurable:

- **chat** — `/memory/answer` and general chat workloads
- **runtime** — the assistant runtime turn; falls back to the chat configuration.
  Note this role always sends `reasoning_effort` (defaulted to `low`), so on
  OpenAI it needs a model that accepts the parameter
- **structuredOutput** — digest generation and other strict-JSON workloads
- **embedding** — retrieval embeddings; role stays `null` unless
  `MODEL_EMBEDDING_NAME` is set

This matters because digest generation, grounded answering, and retrieval embeddings may not share the same optimal model — and in the deployed configuration they do not.

One provider client may back more than one role, but the interfaces are separate concerns.

## Provider Factory

`createModelProvider` in `packages/core/src/model-provider.ts` is the factory.
The API and worker both construct their clients through it; provider-specific
configuration stays centralized there.

All roles are backed by real clients. The embedding client is constructed when
`MODEL_EMBEDDING_NAME` is set, and retrieval uses it two ways: rerank when
`RETRIEVE_USE_EMBEDDINGS=true`, and pgvector similarity search over stored
event embeddings, behind an HNSW index. Retrieval without an embedding
configuration falls back to heuristic ranking, and the retrieve response's
`retrieval.mode` field reports which path ran.

## Compatibility Rule

The provider abstraction should preserve current OpenAI-compatible behavior while making naming and construction more neutral.

Recommended migration rule:

- keep `OPENAI_*` as legacy-compatible aliases for a transition period
- prefer `MODEL_*` in new docs and new code
- emit clear errors when required values are missing

That avoids a breaking change while improving the architecture.

## Local Model Support

Local model support should be practical, not ceremonial.

The near-term goal is not "support every local runtime". The near-term goal is:

- a developer can point StateCore at a local OpenAI-compatible endpoint
- the memory runtime works without code changes
- evaluation and replay workflows still behave consistently

That is enough to satisfy the self-hosted and BYOM promise in a pragmatic way.

## Configuration Semantics

### `MODEL_PROVIDER`

Identifies the provider mode or adapter type.

Examples:

- `openai-compatible`
- `openai`
- `ollama`
- `lmstudio`

The value should influence client construction and error messages, not core memory logic.

### `MODEL_BASE_URL`

The base HTTP endpoint for model requests.

This should support both remote and local endpoints.

### `MODEL_NAME`

The model identifier used for chat or structured output requests.

### `MODEL_CHAT_NAME`

Optional override for chat and runtime-answer workloads. If omitted, the system falls back to `MODEL_NAME`.

### `MODEL_CHAT_BASE_URL`

Optional override for the chat/runtime endpoint. If omitted, the system falls back to `MODEL_BASE_URL`.

### `MODEL_CHAT_API_KEY`

Optional override for the chat/runtime credential. If omitted, the system falls back to `MODEL_API_KEY`.

### `MODEL_RUNTIME_NAME`

Optional override for the assistant runtime turn. If omitted, the system falls back to `MODEL_CHAT_NAME`, then `MODEL_NAME`. The runtime role also reads `MODEL_RUNTIME_BASE_URL`, `MODEL_RUNTIME_API_KEY`, `MODEL_RUNTIME_TIMEOUT_MS`, `MODEL_RUNTIME_REASONING_EFFORT` (default `low` — always sent, so the model must accept it), and `MODEL_RUNTIME_MAX_OUTPUT_TOKENS`.

### `MODEL_STRUCTURED_OUTPUT_NAME`

Optional override for digest and other structured-output style workloads. If omitted, the system falls back to `MODEL_NAME`. The role also reads `MODEL_STRUCTURED_OUTPUT_REASONING_EFFORT` (sent only when set) and `MODEL_STRUCTURED_OUTPUT_MAX_OUTPUT_TOKENS`.

### `MODEL_STRUCTURED_OUTPUT_BASE_URL`

Optional override for the structured-output endpoint. If omitted, the system falls back to `MODEL_BASE_URL`.

### `MODEL_STRUCTURED_OUTPUT_API_KEY`

Optional override for the structured-output credential. If omitted, the system falls back to `MODEL_API_KEY`.

### `MODEL_EMBEDDING_NAME`

Optional embedding-model identifier. If omitted, embedding remains disabled and the provider bundle keeps `embedding=null`.

### `MODEL_EMBEDDING_BASE_URL`

Optional override for the embedding endpoint. If omitted, the system falls back to `MODEL_BASE_URL`.

### `MODEL_EMBEDDING_API_KEY`

Optional override for the embedding credential. If omitted, the system falls back to `MODEL_API_KEY`.

### `MODEL_API_KEY`

The credential used for providers that require bearer auth.

For local setups that do not require auth, this may be optional depending on provider mode.

## Error and Validation Rules

Configuration validation should be explicit.

All three rules are implemented in `apps/api/src/env.ts`:

- If `FEATURE_LLM=true` but no provider configuration is valid, startup fails with the missing variable named.
- The API key is demanded only when the resolved base URL is `api.openai.com`; a local endpoint without auth passes validation.
- Error messages name `MODEL_*` variables first and mention `OPENAI_API_KEY` only as the legacy alias.

## Relationship to Evaluation

Provider abstraction is not only a DX improvement. It also supports research quality.

It enables:

- cross-model drift comparison
- provider-specific latency and consistency comparison
- reproducible reporting of model settings
- cleaner separation between memory quality and provider behavior

Evaluation reports should continue to record:

- provider type
- model name
- base URL or serving mode
- temperature and timeout settings if applicable

## Relationship to Assistant Runtime

The assistant runtime should depend on abstract model roles, not on provider-specific clients.

That means:

- `AssistantSession` should not know about OpenAI env vars
- write policy and recall policy should remain provider-agnostic
- answer grounding should remain provider-agnostic

Only the model factory boundary should care about how a provider client is created.

## Non-goals

The provider abstraction should not expand into:

- model download management
- built-in model serving
- hardware scheduling
- benchmark marketing focused on raw model performance
- large provider-specific feature matrices

Those directions dilute the memory-first product line.

## Migration Path (completed)

The migration ran in this order, and every step is done:

1. define neutral configuration names in docs
2. add support for `MODEL_*` alongside `OPENAI_*`
3. centralize provider construction behind a factory (`createModelProvider`)
4. update API and worker to use the factory
5. update docs and examples to prefer provider-neutral configuration
6. de-emphasize `OPENAI_*` without breaking existing setups — the aliases remain
   in `env.ts` as silent fallbacks and appear nowhere else

What remains deliberately not done is the "Optional future variables" split
(`EMBEDDING_PROVIDER` etc. as a separate scheme): the shipped design nests every
role under `MODEL_*` instead, which proved sufficient.

## Interfaces

The boundaries this section once sketched now exist in
`packages/core/src/model-provider.ts`: `ChatModel`, `StructuredOutputModel` and
`EmbeddingModel`, produced by a `ModelProviderFactory`. The chat-style roles also
accept per-call `LlmChatOptions` (`maxOutputTokens`, `reasoningEffort`), which is
how the runtime role's `reasoning_effort` reaches the wire. That file is the
authority on the exact signatures; this document only records why the roles are
separate.

## Documentation Rule

Docs say "set `FEATURE_LLM=true` and configure a compatible provider", using
`MODEL_*` names throughout; `OPENAI_*` appears in no current documentation and
survives only as a code-level fallback. Keep it that way in new writing.

## Success Criteria

The provider abstraction is successful when:

- a developer can use StateCore with a local or remote compatible model endpoint
- core memory logic does not change across providers
- configuration names communicate neutrality rather than vendor lock-in
- evaluation reports can compare memory behavior across providers

At that point, model support becomes a clean extension point instead of an accidental product identity.
