# Research Questions

## RQ1: Digest Consistency
How reliably does the digest pipeline preserve stable facts and avoid contradictions as the event stream grows?

**Metrics**
- Consistency pass rate (schema + constraint checks)
- Contradiction rate vs protected state
- Repetition rate of changes

## RQ2: Latency vs Reliability
What is the latency cost of higher consistency constraints or retries?

**Metrics**
- Digest end-to-end latency
- Retry counts
- Success rate under timeouts

## RQ3: Retrieval Robustness
How stable is retrieval quality across event noise and drift?

**Metrics**
- Semantic hit rate
- Strict hit rate
- Sensitivity to noise proportion

## RQ4: Snapshot Value
Do persisted digest state snapshots reduce drift and improve reproducibility?

**Metrics**
- Consistency delta with/without snapshots
- State divergence over time
