# LongMemEval: StateCore vs mem0 OSS

An external, comparative benchmark, as opposed to the synthetic latency and
consistency suite in [`benchmarking.md`](./benchmarking.md).

Both systems were driven by the **same runner**, over the **same question
sample**, with the **same answerer and the same judges**, on the **same host**.
The memory system is the only thing that differs.

## Result

| system | official judge (gpt-4o) | mem0-style judge (gpt-5) |
|---|---|---|
| **StateCore** | **65.5%** ±6.6 (131/200) | **65.5%** ±6.6 (131/200) |
| **mem0 OSS** | **61.0%** ±6.8 (122/200) | **61.0%** ±6.8 (122/200) |

Difference under the official judge: **+4.5 points, 95% CI ±9.4**. The interval
includes zero, so **on total score the two systems are not statistically
distinguishable.**

The two judges land on identical totals by coincidence, not by construction:
they disagree on 8 of 200 questions and those disagreements cancel out. Their
per-question agreement is **96% (192/200)**.

## Where the systems actually differ

Total score hides the interesting result. Two ~45-point differences point in
opposite directions and cancel:

| question type | StateCore | mem0 OSS | delta |
|---|---|---|---|
| **temporal-reasoning** | **70.6%** (24/34) | 23.5% (8/34) | **+47.1** |
| **single-session-assistant** | **67.6%** (23/34) | 44.1% (15/34) | **+23.5** |
| multi-session | 73.5% (25/34) | 70.6% (24/34) | +2.9 |
| knowledge-update | 67.6% (23/34) | 67.6% (23/34) | 0 |
| single-session-preference | 63.3% (19/30) | 66.7% (20/30) | −3.4 |
| **single-session-user** | 50.0% (17/34) | **94.1%** (32/34) | **−44.1** |

The split tracks a real architectural difference rather than tuning:

- **StateCore keeps sessions intact**, so relative time ("three weeks ago") still
  has an anchor and an assistant's earlier reasoning is still in context. It wins
  temporal-reasoning by 47 points.
- **mem0 extracts atomic facts**, which is a far better signal-to-noise ratio when
  the question is a single stored value the user stated once. It wins
  single-session-user by 44 points.

Neither result is a defect in the other system; they are the expected
consequences of consolidating into state versus indexing extracted facts.

## Cost, latency, reliability

| | StateCore | mem0 OSS |
|---|---|---|
| median wall clock / question | 55s | 87s |
| measured OpenAI cost / question | $0.135 | $0.076 |
| questions completed | 200 | 200 |
| runtime errors | 0 | 0 |
| state layer produced | 200/200 digests | n/a (no state layer) |

StateCore is faster per question but ~1.8× the API cost: every ingested event is
classified and the scope is periodically digested. That is the running cost of
maintaining structured state, and it is worth weighing alongside accuracy.

## Configuration

Every knob, because a LongMemEval score is a property of *system plus
configuration* (see the caveat below).

| knob | value |
|---|---|
| dataset | `longmemeval_s` (original, not `_cleaned`) |
| sample | 200 questions, stratified by type, seed `42` |
| ingest granularity | one event per session |
| retrieval top-k | 50 |
| `occurredAt` | disabled |
| StateCore commit | `5791157` |
| StateCore internal model | `gpt-4o-mini` |
| mem0 internal model | `gpt-4o-mini` |
| embedder (both) | `text-embedding-3-small` |
| answerer (both) | `gpt-5` |
| official judge | `gpt-4o-2024-08-06` via LongMemEval `evaluate_qa.py` |
| mem0-style judge | `gpt-5` via the mem0 harness `JUDGE_PROMPT` |
| host | one DigitalOcean `s-4vcpu-8gb`, both systems, run sequentially |

## Reproduction notes

Things a reader will otherwise trip over:

- **mem0's published Docker config does not build.** Its benchmark harness pins
  `mem0ai @ git+…/mem0.git@feat/v3-pipeline`, and that branch no longer exists
  upstream. Tested against `feat/oss-add-v3-ingestion-caps` instead.
- **mem0's server needed a one-line compatibility fix.** Current `mem0ai`
  rejects a top-level `user_id` in `search()` and requires `filters={…}`.
  Extraction, storage and ranking are untouched.
- **Both systems run `gpt-4o-mini` internally, not their own defaults.**
  StateCore normally runs `gpt-5-mini`, but gpt-5 reasoning models reject the
  `temperature` / `top_p` that mem0's client always sends, and `gpt-4o-mini`
  rejects StateCore's `reasoning_effort`. Parity mattered more than matching
  either project's default.
- These numbers are **not comparable to either project's published figures**,
  which use different answerers, judges and dataset variants.

## Caveat: quote the configuration with the number

A LongMemEval score is not a property of a memory system. The same StateCore
build, on the same machine, on the same day:

| retrieval configuration | score |
|---|---|
| message granularity, top-k 20 | 35% |
| message granularity, top-k 100 | 50% |
| session granularity, top-k 50 | **65.5%** |

A 30-point spread from retrieval configuration alone. Retrieval recall over the
gold evidence went from 0.18 to 1.00 across those configurations, which is what
moved the score — the memory system was identical throughout.

Cite the configuration alongside the number, or the number will not reproduce.
