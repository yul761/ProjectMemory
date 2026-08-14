/**
 * The dual-mode hinge: an embedded (keyless, in-process SQLite) and a remote
 * (Task 6/7, talks to a StateCore server) implementation both satisfy this
 * interface, so the MCP tool layer built on it never branches on which mode is
 * active.
 */
export interface MemoryBackend {
  /** Records a fact. Without `consolidate`, upserts into the active facts snapshot; with it, appends a stream event for later digesting. */
  remember(input: { text: string; consolidate?: boolean }): Promise<{ ok: true; mode: "note" | "event" }>;
  /** The engine's retrieve result for `query`, passed through with an added `budget` reporting the requested `maxChars`. */
  recall(input: { query?: string; maxChars?: number }): Promise<unknown>;
  /** Active facts grouped for display, each item carrying `factKey` and `factId` (the latter for `why`). */
  facts(): Promise<unknown>;
  /** The evidence chain for a fact id from `facts()`, or null if the id is unknown. */
  why(input: { factId: string }): Promise<unknown>;
  /** Retires a fact by its `factKey` and suppresses its evidence event; the record is kept, not deleted. */
  forget(input: { factKey: string }): Promise<{ ok: true }>;
  /** Ensures the backend's scope exists and kicks off startup digest catch-up. */
  init(): Promise<void>;
  /** Releases the backend's resources (its store connection). */
  close(): Promise<void>;
}
