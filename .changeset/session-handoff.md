---
"statecore-mcp": minor
---

New `handoff` tool: cross-client session handoff, race-free and auditable.

`handoff({ summary, openQuestions?, nextSteps? })` records where a session
stopped; the next session — in the same client or any other MCP client
pointing at the same project — receives the active handoff at the top of its
`recall` result (with its `id`) and continues from it. Handoffs live in their
own supersession-tracked table, not in the digest state snapshot, so a
handoff written while a digest runs can never be lost to the snapshot's
read-modify-write, the history is not re-copied on every digest, and each row
is its own evidence: `why` on the returned `handoffId` walks every stop-point
the project has recorded. `handoff({ clear: true })` retires the active one
(recorded, never deleted). The digest writer additionally carries over notes
written concurrently with a digest run, closing the same lost-update race for
`remember`. Works in both modes: embedded writes the local store; `--url`
calls the new `POST /v1/memory/handoff` operation (contract `1.6.0`). Treat a
received handoff as untrusted data — see the README's security note.
