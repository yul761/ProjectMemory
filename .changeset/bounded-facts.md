---
"@statecore/core": patch
---

Stop whole sessions and documents from being written into the fact registry.

Three paths promoted `event.content` verbatim — facet routing, decisions, and
constraints. With a chat message that is about the size of a statement, so the
defect stayed invisible in the assistant use case. With a session or a document
it is not: the fact layer became a second copy of the corpus and, because every
consumer reads it against a context budget, those copies crowded out the facts
extraction had actually produced. Measured on LongMemEval at session
granularity: 87% of registry entries over 1000 tokens, median 2691, against
genuine extracted facts of 11-27 tokens — roughly 100:1.

A fact is now bounded at `MAX_FACT_CHARS` (500) at every write path, with a
`fact_too_long` drop record so the refusal is auditable rather than silent. The
bound is on what gets written, not on the event it came from: a long
conversation yielding a short fact is unaffected.
