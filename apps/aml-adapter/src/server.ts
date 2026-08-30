/**
 * StateCore ⇄ Agent Memory Leaderboard adapter.
 *
 * AML (agentmemoryleaderboard.ai) evaluates memory systems through exactly two
 * participant-hosted operations — Add and Search — plus an unauthenticated
 * health check. This service maps that contract onto StateCore's frozen /v1:
 *
 *   user_id      → one StateCore scope (the engine's retrieval-isolation
 *                  boundary; cross-user retrieval is impossible by scoping,
 *                  not by post-filtering)
 *   Add.messages → POST /v1/memory/events, one event per message, with the
 *                  platform's timestamp carried as occurredAt so time-based
 *                  reasoning survives replay; a digest is enqueued after each
 *                  chunk so distillation runs while the Add phase continues
 *   Search       → POST /v1/memory/retrieve; the reply interleaves the fact
 *                  and event layers (each relevance-ranked by the engine)
 *                  behind the digest summary — the assembly that measured
 *                  best on MemoryAgentBench FactConsolidation
 *
 * AML's own rules govern the shapes: Add must return 200 only after
 * persistence (so events are awaited; only the digest enqueue is
 * best-effort), Search must return relevance-ordered `data`, and the platform
 * authenticates with a participant-issued key via Bearer/Token/X-Api-Key.
 */
import { z } from "zod";

export interface CoreClient {
  findScope(name: string): Promise<string | null>;
  createScope(name: string): Promise<string>;
  ingest(scopeId: string, content: string, occurredAtIso?: string): Promise<void>;
  enqueueDigest(scopeId: string): Promise<void>;
  retrieve(
    scopeId: string,
    query: string,
    limit: number,
    maxChars: number
  ): Promise<{
    digest: string | null;
    factRegistry: Array<{ id: string; content: string; addedAt?: string }>;
    events: Array<{ id: string; content: string; createdAt?: string }>;
  }>;
}

export interface HandlerResult {
  status: number;
  body: unknown;
}

/** The engine's /v1 retrieve limit ceiling; also AML's formal top_k. */
const RETRIEVE_LIMIT_MAX = 100;
/** Character budget for a formal top_k=100 search — generous, whole-item packed. */
const SEARCH_MAX_CHARS = 60_000;

export function authorize(headers: Record<string, string | string[] | undefined>, key: string): boolean {
  if (!key) return false;
  const auth = headers["authorization"];
  if (typeof auth === "string") {
    const [scheme, value] = auth.split(/\s+/, 2);
    if ((scheme === "Bearer" || scheme === "Token") && value === key) return true;
  }
  const apiKey = headers["x-api-key"];
  return typeof apiKey === "string" && apiKey === key;
}

const AddInput = z.object({
  request_id: z.string().min(1),
  user_id: z.string().min(1),
  session_id: z.string().min(1),
  messages: z
    .array(
      z.object({
        role: z.string().optional(),
        content: z.string().min(1),
        timestamp: z.number().int().positive().optional()
      })
    )
    .min(1)
});

export async function handleAdd(body: unknown, core: CoreClient): Promise<HandlerResult> {
  const parsed = AddInput.safeParse(body);
  if (!parsed.success) {
    return { status: 400, body: { success: false, error: parsed.error.issues[0]?.message ?? "invalid body" } };
  }
  const { request_id, user_id, session_id, messages } = parsed.data;

  try {
    const scopeId = (await core.findScope(user_id)) ?? (await core.createScope(user_id));
    // Sequential, awaited writes: AML's contract is 200 only after persistence,
    // and order is the recency signal the engine ranks by.
    for (const message of messages) {
      await core.ingest(
        scopeId,
        message.content,
        message.timestamp !== undefined ? new Date(message.timestamp).toISOString() : undefined
      );
    }
    // Distillation keeps pace with the Add phase; its enqueue failing must not
    // fail a write that already persisted.
    try {
      await core.enqueueDigest(scopeId);
    } catch {
      // recorded by the core's own queue logging; the write stands
    }
    return { status: 200, body: { success: true, request_id, user_id, session_id } };
  } catch (err) {
    return { status: 500, body: { success: false, error: err instanceof Error ? err.message : String(err) } };
  }
}

const SearchInput = z.object({
  query: z.string().min(1),
  options: z.array(z.string()).optional(),
  user_id: z.string().min(1),
  top_k: z.number().int().min(1)
});

export async function handleSearch(body: unknown, core: CoreClient): Promise<HandlerResult> {
  const parsed = SearchInput.safeParse(body);
  if (!parsed.success) {
    return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "invalid body" } };
  }
  const { query, options, user_id, top_k } = parsed.data;

  try {
    const scopeId = await core.findScope(user_id);
    if (!scopeId) return { status: 200, body: { data: [] } };

    // Choice options are retrieval signal the platform hands us — fold their
    // vocabulary into the lexical query rather than discarding it.
    const retrievalQuery = options?.length ? `${query}\n${options.join("\n")}` : query;
    const limit = Math.min(top_k, RETRIEVE_LIMIT_MAX);
    const result = await core.retrieve(scopeId, retrievalQuery, limit, SEARCH_MAX_CHARS);

    // Digest first, then the fact and event layers interleaved: both layers
    // are relevance-ranked by the engine, and interleaving keeps the top of
    // each inside the platform's reading window (measured on MemoryAgentBench).
    const items: Array<{ id: string; content: string; created_at?: string }> = [];
    if (result.digest) items.push({ id: `digest:${scopeId}`, content: result.digest });
    const facts = result.factRegistry ?? [];
    const events = result.events ?? [];
    for (let i = 0; i < Math.max(facts.length, events.length); i++) {
      if (i < facts.length) items.push({ id: facts[i].id, content: facts[i].content, created_at: facts[i].addedAt });
      if (i < events.length) items.push({ id: events[i].id, content: events[i].content, created_at: events[i].createdAt });
    }

    const capped = items.slice(0, top_k);
    const data = capped.map((item, index) => ({
      ...item,
      // Rank-derived, strictly decreasing: the platform reads results in
      // submitted order and the score documents that order.
      score: Number((1 - index / Math.max(capped.length, 1)).toFixed(4))
    }));
    return { status: 200, body: { data } };
  } catch (err) {
    return { status: 500, body: { error: err instanceof Error ? err.message : String(err) } };
  }
}
