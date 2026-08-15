/**
 * Public library entry point (`statecore-mcp/lib`): the `MemoryBackend`
 * implementations, scope-name resolution, and the injectable-LLM digest
 * runner, packaged for reuse outside the MCP server binary — the dsh-statecore
 * native plugin's dependency surface. `.` (the package's default export,
 * `dist/main.js`) keeps serving the `statecore-mcp` bin unchanged; this entry
 * adds no behavior of its own, it only re-exports what already exists.
 */
export { createEmbeddedBackend } from "./embedded";
export { createHttpBackend } from "./http-backend";
export type { MemoryBackend } from "./backend";
export { resolveScopeName } from "./scope";
export { runScopeDigest, type DigestChatModel } from "./digest";
