---
"statecore-mcp": patch
---

The digest path's default LLM timeout is now 120s (was 20s). Found by a
benchmark run: with the recommended gpt-5-mini, a large-backlog distillation
chunk routinely exceeds 20s, the call aborts, the retry aborts too, and the
whole run fails silently — the recommended default configuration could not
digest any real backlog. 20s remains right for interactive calls; the
background distillation path now defaults to a timeout that survives
reasoning models. MODEL_TIMEOUT_MS still overrides.
