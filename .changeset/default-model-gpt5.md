---
"statecore-mcp": patch
---

The fallback digest model is now gpt-5-mini, matching the README's recommended
configuration. The engine is operated with gpt-5-class models (the runtime
sends reasoning_effort, which the gpt-4o family rejects), but the embedded and
worker fallbacks still said gpt-4o-mini — an explicit MODEL_NAME/OPENAI_MODEL
is unaffected.
