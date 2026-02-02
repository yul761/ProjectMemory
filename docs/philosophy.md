# Project Memory Philosophy

Project Memory is a **long-term memory engine**, not a personal assistant. It provides primitives for ingesting events, producing layered digests, retrieving memory, and (optionally) generating answers grounded in that memory.

Principles:
- **Engine, not app**: no UI or hosted service. You own infra and secrets.
- **Layered memory**: each digest builds on the last digest plus recent events.
- **Two memory types**: stream (append-only) and document (upsert by key).
- **Adapters are references**: Telegram + CLI show how to integrate.
- **Replaceable intelligence**: LLM is optional and swappable.
