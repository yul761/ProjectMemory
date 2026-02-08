# Project Memory v0.1.0

Project Memory v0.1.0 is the first public OSS release of the developer-first long-term memory engine.

## Highlights

- Long-term memory primitives via API:
  - ingest events (stream/document)
  - layered digest generation
  - retrieval
  - grounded answer generation (when `FEATURE_LLM=true`)
- Digest control layer:
  - event selection with de-dup + budget controls
  - delta detection
  - protected state merge
  - consistency checks + retry
  - rebuild/backfill job flow
- Worker queues:
  - digest processing
  - reminder scheduling/sending
- Reference adapters:
  - Telegram webhook adapter
  - CLI adapter
- Benchmarking and reliability scoring:
  - ingest/retrieve/digest/reminder metrics
  - all-runs comparison report support

## OSS Foundation Included

- CI workflows (`ci`, `integration-smoke`)
- Governance docs (`CONTRIBUTING`, `CODE_OF_CONDUCT`, `SECURITY`)
- Issue / PR templates
- Roadmap and release process documentation

## Notes

- This project is BYO infra and BYO keys (no hosted defaults).
- For production deployments, replace header-based dev auth with a stronger auth layer.
