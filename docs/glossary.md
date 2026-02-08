# Glossary

This glossary defines core terms used across the Project Memory engine.

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
A query that returns a concise memory bundle (latest digest + recent events). This is the baseline retrieval layer; semantic/vector search can be added later.

## Answer
An optional LLM-powered response generated from retrieved memory. If LLM is disabled, `/memory/answer` returns an error.

## Reminder
A scheduled item with a due time and text. The worker periodically checks due reminders and marks them as sent.

## Adapter
A reference integration that converts external signals into memory events (e.g., Telegram). Adapters call the API and never touch the database directly.
