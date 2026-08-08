# LongMemEval: StateCore vs mem0 OSS

**Run date:** 2026-08-08 · **StateCore:** [`96b853d`](https://github.com/yul761/StateCore/commit/96b853d) · **mem0:** `mem0ai==2.0.17`, unmodified

Systems are compared at an **equal context budget** — the same number of
characters of memory in the answerer's prompt — rather than at an equal number
of retrieved items. Items are not comparable: a StateCore session event ran
~9,800 characters against a mem0 memory's ~145, so "top-k 50 for both" hands one
side 60× the context and the score measures context volume, not memory quality.

## Result

194 of 200 questions scored, `gpt-5` answering, the official LongMemEval `gpt-4o`
judge. Intervals are 95% Wilson.

| system | 4,000 tok | 16,000 tok | 64,000 tok |
|---|---|---|---|
| **StateCore** | 51.0% ±7.0 | **80.9% ±5.5** | **87.6% ±4.6** |
| **mem0 OSS** | **61.3% ±6.9** | 59.8% ±6.9 | 61.3% ±6.9 |
| No memory (recency window) | 9.3% ±4.1 | 22.7% ±5.9 | 53.6% ±7.0 |

**Ceiling** — the whole corpus in the prompt, no memory layer, no budget:
**70.1% ±6.4**.

All three differences have non-overlapping intervals. Read them as three separate
findings, not one:

- **At 16k and 64k, StateCore wins by 21 and 26 points.**
- **At 64k, StateCore beats the ceiling.** 64,000 characters chosen by the memory
  layer answer more questions than the entire corpus (~103,000 tokens) pasted in.
  That is the only result on this page that justifies having a memory layer at all.
- **At 4k, mem0 wins by 10 points.** See below — we are not fixing it, and the
  reason matters.

### Why mem0 flattens

Its whole store is 4,451 tokens. Raising the budget 16× leaves it 100%
underfilled and the score unmoved. At 64,000 tokens it scores 61.3% against a
plain recency window's 53.6% — an 8-point margin over having no memory system.

| system | budget | median used | runs that underfilled |
|---|---|---|---|
| StateCore | 4k / 16k / 64k | 3,955 / 15,951 / 63,940 | 0% / 0% / 0% |
| mem0 OSS | 4k / 16k / 64k | 3,988 / 4,451 / 4,451 | 44% / 100% / 100% |

### Why StateCore loses at 4,000

At that budget StateCore fits 4 whole sessions plus 23 facts; mem0 fits 142 short
memories. In a narrow budget the contest is coverage, and fragmented storage wins
it. This is a genuine difference in kind, and it is reported rather than closed.

One caveat on transferring it: the benchmark ingests with
`--granularity session`, so one StateCore event is an entire conversation. A
deployment that writes one event per turn has a different shape at the same
budget. The 4k result is about the ingest granularity used here, not a fixed
property of the engine.

### Ingest completeness

A system holding less of the corpus is answering a different question, so this is
reported rather than hidden.

| system | median corpus lost | worst question | questions over threshold |
|---|---|---|---|
| StateCore | 0.0% | 0.0% | 0 |
| mem0 OSS | 4.3% | 12.5% | 6 |

mem0 extracts nothing from some conversational sessions and then embeds an empty
string, which its own API rejects. That is released behaviour, not a harness
failure; patching it would mean publishing a number for something nobody runs.
The 6 affected questions were excluded from **every** arm so all systems answer
the same set.

### By question type, at 64,000 tokens

| question type | StateCore | mem0 OSS |
|---|---|---|
| knowledge-update | 88.2% | 73.5% |
| multi-session | 79.4% | 82.4% |
| single-session-assistant | 100.0% | 25.8% |
| single-session-preference | 75.9% | 58.6% |
| single-session-user | 96.9% | 87.5% |
| temporal-reasoning | 85.3% | 38.2% |

`single-session-assistant` holds at 96.8–100% vs 25.8–29.0% across all three
budgets: mem0 does not retain what the assistant said.

## What this does not measure

LongMemEval measures exhaustive needle-in-haystack recall. It does not measure
auditability, contradiction resolution, or state stability over time — which is
what StateCore is actually built for. These numbers show the engine is not weak
at recall. They do not show what makes it different.

A LongMemEval score is a property of *system + configuration*, not of a system.
Quote the configuration with the number or the number will not reproduce.

## Reproducing it

Harness, raw retrievals, per-question judge verdicts and the full report:
**[memory-budget-bench](https://github.com/yul761/memory-budget-bench)** —
[`FAIR-REPORT.md`](https://github.com/yul761/memory-budget-bench/blob/main/FAIR-REPORT.md)
is the generated report; `artifacts/` holds exactly what each system handed the
answerer, so a reported score can be checked rather than taken on trust.

## The withdrawn run

An earlier comparison on this page reported StateCore 65.5% vs mem0 61.0%, and a
later one 88.0% vs 55.5%. **Both were withdrawn before this run replaced them.**

The first truncated every retrieved item to 2,000 characters — a cap written when
one item was one chat message, applied when one item was a whole session — which
discarded ~80% of each retrieved session before the answerer saw it, and cost
StateCore heavily while barely touching mem0.

The second had `--top-k 50` against a corpus of roughly 50 sessions, so retrieval
degenerated into returning everything: the prompt reached 1.44× the entire corpus
and the score came from `gpt-5` reading the whole thing, with the memory layer
outside the causal chain.

Both are kept in `withdrawn/` in the benchmark repository with notices explaining
what was wrong. A benchmark maintained by an interested party is worth nothing if
its failures quietly disappear.
