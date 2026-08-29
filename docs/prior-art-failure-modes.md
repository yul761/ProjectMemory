# Prior Art: Memory-System Failure Modes, With Receipts

The README claims that agent-memory tools' own issue trackers are full of
memories that silently stop being written, stale decisions injected as current,
cross-project leakage, and stores that cannot be audited or repaired. This page
is the evidence for that claim, and a map from each failure class to the
StateCore mechanism built against it.

Every issue below was verified directly against the source repository's issue
tracker on **2026-08-29** (number, title, and state confirmed; bodies read for
the load-bearing ones). States are as of that date. None of this is a claim
that these projects are bad — several are excellent at what they optimise for —
only that these failure classes are real, recurring, and worth designing
against on purpose.

## 1. Writes that silently fail

The most common failure class, across five unrelated architectures: the write
returns success, and the memory never lands.

| Issue | State | What happened |
|---|---|---|
| mem0ai/mem0 #5245 | open | `Memory.add()` silently drops extracted memories when batch embedding partially fails; logged at WARNING, no exception to the caller |
| mem0ai/mem0 #6911 | open | `add()` returns `event: ADD` for memories the vector store never persisted — the response, history rows, and entity links all describe writes that did not happen |
| rohitg00/agentmemory #301 | open | container can't write its volume; the wrapper buffers in RAM and looks healthy until a restart wipes everything |
| rohitg00/agentmemory #522 | closed | sessions were never created while observations were; the 4xx was swallowed by `fallback_on_error: true` |
| basicmachines-co/basic-memory #578 | closed | after one sqlite-vec load failure, all new entities silently skip embedding generation — background task errors are fire-and-forget |
| basicmachines-co/basic-memory #763 | closed | `write_note` returns before indexing completes; the CLI path loses embeddings on process exit |
| topoteretes/cognee #2250 | closed | MCP `cognify` on a valid file returns a success message but creates no data item |
| TencentCloud/TencentDB-Agent-Memory #903 | open | the first turn of a new session is silently dropped ~48% of the time (cold-start cursor race) |
| TencentCloud/TencentDB-Agent-Memory #927 | open | embedding timeout silently degrades to a metadata-only write that still returns `code:0` |

**StateCore's answer:** the digest logs every discard against a fixed set of
reasons (`packages/core/src/drop-log.ts`); the budget packer records everything
it refused (`budget.dropped`, exact counts never truncated); a digest that
cannot pass its consistency gate carries `degraded` rather than pretending it
ran. Losing information is survivable. Losing it silently is the defect class
this engine exists to remove.

## 2. Stale facts injected as current, with no correction path

| Issue | State | What happened |
|---|---|---|
| mem0ai/mem0 #5867 | open | ADD-only extraction stores "favorite player is Ronaldo" and later "…is Messi" side by side, both retrievable as current |
| mem0ai/mem0 #5193 | closed | stale facts kept being returned alongside their replacements; users asked for automatic overwrite |
| TencentCloud/TencentDB-Agent-Memory #48 | open | a preference stated for one context is generalized into a permanent global rule injected everywhere |

**StateCore's answer:** supersession is a first-class state transition. A
corrected fact gets a `supersededBy` pointer to its replacement; retrieval and
facts APIs serve the active version; the old version stays on the chain and
`GET /v1/memory/facts/:id/provenance` shows the whole history. The stage-2
prompt additionally instructs: on a correction, output only the latest value.

## 3. Destructive updates: history destroyed on merge

| Issue | State | What happened |
|---|---|---|
| mem0ai/mem0 #6367 | closed | TS `updateMemory()` could rewrite `user_id`/`agent_id` on an existing memory via an unconditional metadata spread |
| mem0ai/mem0 #4490 | closed | `actor_id` overwritten during UPDATE, destroying attribution |
| rohitg00/agentmemory #308 | closed | sessions that never end (crash, Ctrl-C) skip consolidation, and the eviction sweep then deletes the whole session |
| topoteretes/cognee #2732 | closed | deleting data from one dataset wipes the same shared data out of every other dataset referencing it |
| TencentCloud/TencentDB-Agent-Memory #770 | open | any checkpoint parse failure is treated as first-run, silently resetting state and overwriting existing data |

Merge-time deletion is also a design choice in some systems, not only a bug:
TencentDB-Agent-Memory's L1 conflict resolution deletes the losing record
outright on `update`/`merge` decisions, so the pre-merge fact is gone.

**StateCore's answer:** facts are never deleted. Replacement leaves a
`supersededBy` chain; eviction and explicit forgetting leave
`retiredAt`/`retiredReason`. The deterministic merge — not the LLM — decides
what enters protected state, and `GET /v1/memory/digests/:id/selection` shows
what any digest kept and dropped.

## 4. Index out of sync with data, corruption, concurrency

| Issue | State | What happened |
|---|---|---|
| mem0ai/mem0 #4892 | open | concurrent async writes corrupt the vector index; reads then fail or return garbage |
| mem0ai/mem0 #6627 | closed | `delete_all()` silently deleted only the first 100 memories while reporting success |
| basicmachines-co/basic-memory #765 | closed | stale FTS entries survive `reset --reindex`; zombie processes serve phantom results from the unlinked old database file |
| topoteretes/cognee #2717 | closed | SQLite deadlock during parallel `cognify()`; ~9-minute hang before crash |
| TencentCloud/TencentDB-Agent-Memory #157 | open | checkpoint counters only increment, permanently drifting from actual data — the store's own accounting overstates what it holds |

**StateCore's answer:** state transitions go through one pipeline with a
consistency gate, replayable digest state snapshots, and an eval suite that
fails when a change breaks retention or retrieval. The failure class where *the
store's own record of itself is wrong* (mem0 #6911, Tencent #157) is precisely
what the audit surface is for.

## 5. Cross-project / cross-tenant leakage

| Issue | State | What happened |
|---|---|---|
| mem0ai/mem0 #6279 | closed | Pinecone `reset()` ignored the configured namespace and wiped the entire shared index — other tenants' data included |
| mem0ai/mem0 #6796 | open | `add()` mutates the caller's `filters` object, leaking one call's scope into the next |
| mem0ai/mem0 #5439 | open | entity store links memories across `user_id` boundaries; scope is filtered at search time but never validated on the links |
| basicmachines-co/basic-memory #256 | closed | search-index DELETE was missing a `project_id` filter; editing a note in one project erased index rows in every project sharing the permalink |
| topoteretes/cognee #2845–#2847 | closed | ACL trio: search ignored ACLs on datasets resolved by name; add silently created a new dataset on name collision; cognify silently skipped non-owners' data |

**StateCore's answer:** every read and write is scoped (`scopeId` predicates in
SQL, not post-filtering), and `multi-tenant-isolation.integration.test.ts`
exists to keep it that way. Vector search joins events on scope inside the
query.

## 6. No way to audit or repair what the store believes

| Issue | State | What happened |
|---|---|---|
| basicmachines-co/basic-memory #124 | open | undo/recovery has a design spec but remains unsolved since June 2025 |
| basicmachines-co/basic-memory #59 | open | proposal to prevent knowledge corruption via git diff; no provenance surface exists |
| mem0ai/mem0 #6911 | open | doubles here: the history table records ADD events for memories never persisted — the audit trail itself is wrong |

**StateCore's answer:** this is the product, not a diagnostic. `why` / the
provenance endpoint returns a fact's evidence and full version chain; the
selection endpoint shows a digest's kept-and-dropped; the drop log enumerates
every discard reason; the retrieve response reports its budget refusals and its
own degradation.

## The one we had ourselves

Honesty cuts both ways. Until 2026-08-29, StateCore's *retrieval* was the one
subsystem that could not report its own degradation: a vector-search failure
was swallowed by a bare `catch {}`, and `retrieval.mode` was derived from
configuration, so a run whose every embedding call failed still reported
`"hybrid"` — the same shape as Tencent #927 above. Digests carried `degraded`,
the packer carried `dropped`, the merge carried a drop log; retrieval lied.
It now reports `mode` from what actually ran and itemises failed stages in
`retrieval.degraded`. The lesson generalises: the silent-degradation class is
not something a project is immune to by philosophy — only by mechanism, and
only where the mechanism actually reaches.
