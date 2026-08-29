# Why "Auditable" Is a Mechanism, Not an Adjective

Every memory system's README says it remembers. The question that separates
them is what happens when a memory is *wrong*: corrected, evicted, superseded,
or simply refused at retrieval time. This page compares, factually and from
public sources, how four systems answer the three questions StateCore treats as
the product:

1. **What happens to the old version when a fact is corrected?**
2. **Can you ask *why* the store believes something?**
3. **Is anything ever lost — or refused — silently?**

Systems compared: StateCore, mem0 OSS, [ai-memory]
(https://github.com/akitaonrails/ai-memory), and [TencentDB-Agent-Memory]
(https://github.com/TencentCloud/TencentDB-Agent-Memory). All observations are
from the projects' public repositories and docs as of 2026-08-29; issue numbers
are cited where a behaviour is documented by the project's own tracker. The
other three are good systems with different priorities — this is a comparison
of *audit* posture, not of overall quality.

## 1. When a fact is corrected

| System | Behaviour |
|---|---|
| **StateCore** | New fact enters the registry; the old one gets `supersededBy` pointing at it and stays on the chain. Eviction or explicit forgetting sets `retiredAt`/`retiredReason` instead. Nothing is deleted. |
| **mem0 OSS** | The extraction LLM decides ADD / UPDATE / DELETE. UPDATE rewrites the memory in place (a history table records the transition); DELETE removes it from the store. Conflicting facts can also simply coexist (mem0 #5867, open). |
| **ai-memory** | Closest to StateCore: wiki pages are versioned in place (`supersedes`, `is_latest`), with git history underneath. Granularity is the *page* — individual facts inside a consolidated page do not carry their own chains. |
| **TencentDB-Agent-Memory** | L1 conflict resolution outputs `store/skip/update/merge`; on `update`/`merge` the losing records are **deleted**. A generation log can say which job produced a memory, but the pre-merge content is gone. |

## 2. Asking "why do you believe this?"

| System | Behaviour |
|---|---|
| **StateCore** | `GET /v1/memory/facts/:id/provenance` returns the fact's evidence (the event or document it came from) and its full version chain. `GET /v1/memory/digests/:id/selection` shows what any digest kept and dropped, and why. |
| **mem0 OSS** | Per-memory history of ADD/UPDATE/DELETE transitions. No evidence link from a memory back to the source turn; mem0 #6911 (open) documents history rows describing writes that never persisted. |
| **ai-memory** | `audit_log` of changes, raw session observations retrievable as the evidence behind compiled pages, and `memory_query(explain: true)` scoring breakdowns. Strong — page-granular rather than fact-granular. |
| **TencentDB-Agent-Memory** | Memory-Generation-Log maps a memory to the generation task that produced it. Message-level `source_message_ids` exist on L1 records. No version chain to walk. |

## 3. Silent loss and silent refusal

| System | Behaviour |
|---|---|
| **StateCore** | Every digest discard is logged against a fixed reason set; the retrieve budget reports exact refused counts (`budget.dropped`); a failed digest carries `degraded`; retrieval reports failed embedding stages in `retrieval.degraded` and derives `mode` from what actually ran. |
| **mem0 OSS** | Partial embedding failures drop memories at WARNING level with success returned to the caller (mem0 #5245, open). |
| **ai-memory** | Forget sweeps leave tombstones; feedback downgrades salience rather than deleting. Hook ingestion is fire-and-forget by design (bounded, spooled), which trades some write-path visibility for agent latency. |
| **TencentDB-Agent-Memory** | Recall failures return structured error codes (good — StateCore adopted the same posture for retrieval). But embedding-timeout writes degrade to metadata-only while returning success (Tencent #927, open), and a gateway outage yields an empty prompt block with no signal (Tencent #1133, open). |

## What this buys in practice

An agent memory is only as trustworthy as its worst silent failure. The
concrete scenarios the audit surface covers:

- **"The agent just confidently used last month's decision."** Walk the fact's
  chain: was it superseded? By what evidence? When?
- **"Something I told it is gone."** The drop log and selection report say
  whether it was refused (and why), evicted (and why), or never extracted.
- **"Recall quality fell off a cliff yesterday."** `retrieval.degraded` and
  `mode` distinguish an embedding outage from a genuinely empty store.
- **"Delete what you know about X — but prove you knew it."** Forgetting
  retires; the retirement is itself a recorded, dated event.

For the wider catalogue of documented failures this design answers, see
[prior-art-failure-modes.md](prior-art-failure-modes.md).
