---
"statecore-mcp": patch
---

Ship the bin with a shebang

0.1.0's `dist/main.js` had none, so npm's `.bin` shim handed JavaScript to the
shell and every `npx statecore-mcp` invocation died on
`use strict: command not found`. Every test had launched the file via
`node dist/main.js`, which is exactly why nothing caught it; the e2e now execs
the built file directly, the way the shim does, and pins the shebang line.
