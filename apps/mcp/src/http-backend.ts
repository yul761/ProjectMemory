import type { MemoryBackend } from "./backend";

// Replaced by Task 7.
/** Remote `MemoryBackend` over a StateCore server; not yet implemented. */
export function createHttpBackend(_opts: { baseUrl: string; env: NodeJS.ProcessEnv }): MemoryBackend {
  throw new Error("--url mode lands in the next commit");
}
