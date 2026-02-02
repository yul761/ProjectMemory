# Project Memory Philosophy

Project Memory is a **long-term memory engine**, not a personal assistant. It provides primitives for ingesting events, producing layered digests, retrieving memory, and (optionally) generating answers grounded in that memory.

Principles:
- **Engine, not app**: no UI or hosted service. You own infra and secrets.
- **Layered memory**: each digest builds on the last digest plus recent events.
- **Two memory types**: stream (append-only) and document (upsert by key).
- **Adapters are references**: Telegram + CLI show how to integrate.
- **Replaceable intelligence**: LLM is optional and swappable.

## Memory Flow (High-Level)

```mermaid
flowchart TD
  A[Client/Adapter/SDK] -->|POST /memory/events| B[API]
  B --> C[(Postgres: MemoryEvent)]

  A -->|POST /memory/digest| B
  B -->|enqueue digest_scope| Q[Queue]
  Q --> W[Worker]
  W -->|fetch last digest + recent events| C
  W -->|if FEATURE_LLM=true| L[LLM]
  L --> W
  W --> D[(Postgres: Digest)]

  A -->|POST /memory/retrieve| B
  B -->|get last digest + recent events| C
  B --> R[Retrieve Output]

  A -->|POST /memory/answer| B
  B -->|retrieve| C
  B -->|if FEATURE_LLM=true| L
  B --> O[Answer Output]
```
