import { logger } from "./index";
import { getDefaultFacetPack, parseFacetPack, type FacetPack } from "./facet-registry";

/**
 * Resolves the facet pack for a tenant.
 *
 * A cloud account maps 1:1 onto a core user — the gateway forwards `accountId`
 * as `x-user-id` — so the tenant's ontology lives on the User row and "per
 * customer" and "per user" are the same lookup.
 *
 * Every fallback to the default is logged. A tenant silently running the wrong
 * ontology is precisely the failure this design is built to avoid: it produces
 * plausible facts in the wrong shape, with nothing to indicate anything went
 * wrong.
 */
export interface FacetPackStore {
  findFacetPack: (userId: string) => Promise<unknown | null>;
}

const CACHE_TTL_MS = 60_000;

type CacheEntry = { pack: FacetPack; expiresAt: number };
const cache = new Map<string, CacheEntry>();

/** Drops cached packs. Call after installing a pack so the change takes effect. */
export function clearFacetPackCache(userId?: string): void {
  if (userId) cache.delete(userId);
  else cache.clear();
}

export async function resolveFacetPack(
  store: FacetPackStore,
  userId: string,
  now: () => number = () => Date.now()
): Promise<FacetPack> {
  const cached = cache.get(userId);
  if (cached && cached.expiresAt > now()) return cached.pack;

  let raw: unknown | null = null;
  try {
    raw = await store.findFacetPack(userId);
  } catch (err) {
    // A lookup failure must not take the digest down, but it must not pass for
    // "this tenant has no pack" either.
    logger.error({ err, userId }, "facet pack lookup failed; falling back to the default pack");
    return getDefaultFacetPack();
  }

  if (raw === null || raw === undefined) {
    const pack = getDefaultFacetPack();
    cache.set(userId, { pack, expiresAt: now() + CACHE_TTL_MS });
    return pack;
  }

  const { pack, usedDefault } = parseFacetPack(raw);
  if (usedDefault) {
    logger.warn(
      { userId, packName: (raw as { name?: unknown })?.name },
      "stored facet pack is malformed; falling back to the default pack"
    );
  }
  cache.set(userId, { pack, expiresAt: now() + CACHE_TTL_MS });
  return pack;
}
