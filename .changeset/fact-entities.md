---
"statecore-mcp": minor
---

Facts carry entity vocabulary, so distillation no longer hides them from recall.

Stage 2 may now attach up to 10 concrete nouns from the evidence (tool names,
file paths, product names) to each extracted fact. They are stored on the
fact's registry entry, survive supersession, and retrieval scores a fact on
its text plus its entities — so a query in the evidence's vocabulary still
finds the fact after distillation rephrased it. Extracted once at digest time;
costs nothing at query time. Entirely additive: facts without entities score
exactly as before.
