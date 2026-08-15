import { randomUUID } from "node:crypto";
import {
  MemoryService,
  RetrieveService,
  ProjectService,
  flattenScopeFacts,
  groupFactsForDisplay,
  addNoteFact,
  resolveFacetPackForScope,
  buildFactProvenance,
  getActiveFactRegistry,
  factToGroup,
  computeFactKey,
  packWithinBudget,
  type DigestState,
  type ProjectRepo,
  type UserStateRepo,
  type MemoryRepo,
  type DigestRepo,
  type MemoryEvent,
  type Digest,
  type FacetPack,
  type DisplayGroup
} from "@statecore/core";
import { openStore, Prisma, type Store, type LitePrisma } from "./store";
import type { MemoryBackend } from "./backend";
import { maybeRunDigest } from "./digest";

const USER = "local";

// Mirrors apps/api/src/domain.service.ts#projectsRepo; keep in sync.
function makeProjectsRepo(prisma: LitePrisma): ProjectRepo {
  return {
    create: (data) => prisma.projectScope.create({ data }),
    listByUser: (userId) => prisma.projectScope.findMany({ where: { userId }, orderBy: { createdAt: "desc" } }),
    findById: (scopeId, userId) => prisma.projectScope.findFirst({ where: { id: scopeId, userId } })
  };
}

// Mirrors apps/api/src/domain.service.ts#userStateRepo; keep in sync.
function makeUserStateRepo(prisma: LitePrisma): UserStateRepo {
  return {
    getByUserId: (userId) => prisma.userState.findUnique({ where: { userId } }),
    upsertActiveProject: (userId, scopeId) =>
      prisma.userState.upsert({
        where: { userId },
        update: { activeProjectId: scopeId },
        create: { userId, activeProjectId: scopeId }
      })
  };
}

/**
 * `listRecentTurns` is not part of `MemoryRepo` — the working-memory feature
 * that consumes it is out of scope for the embedded backend — but the field
 * ships anyway to keep this closure a verbatim mirror of its source.
 */
type MirroredMemoryRepo = MemoryRepo & {
  listRecentTurns: (scopeId: string, limit: number) => Promise<MemoryEvent[]>;
};

// Mirrors apps/api/src/domain.service.ts#memoryRepo; keep in sync.
function makeMemoryRepo(prisma: LitePrisma): MirroredMemoryRepo {
  return {
    create: (data) => prisma.memoryEvent.create({ data }),
    upsertDocument: (data) =>
      prisma.memoryEvent.upsert({
        where: { scopeId_key: { scopeId: data.scopeId, key: data.key } },
        // `pinned` must be in the update branch too: re-uploading a document is
        // the normal way to change its pin state, and leaving it out would make
        // the flag settable only on first ingest.
        update: {
          content: data.content,
          contentHash: data.contentHash,
          updatedAt: new Date(),
          ...(data.pinned !== undefined ? { pinned: data.pinned } : {})
        },
        create: { ...data, type: "document" }
      }),
    listRecent: async (scopeId, limit, cursor) => {
      const items = await prisma.memoryEvent.findMany({
        where: { scopeId, suppressedAt: null },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
      });
      const next = items.length > limit ? items.pop() : null;
      return { items, nextCursor: next ? next.id : null };
    },
    findByIds: (ids) =>
      ids.length
        ? prisma.memoryEvent.findMany({
            where: { id: { in: ids }, suppressedAt: null },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }]
          })
        : Promise.resolve([]),
    listByLookback: (scopeId, since, limit) =>
      prisma.memoryEvent.findMany({
        where: { scopeId, createdAt: { gte: since }, suppressedAt: null },
        orderBy: { createdAt: "desc" },
        take: limit
      }),
    listRecentTurns: (scopeId, limit) =>
      prisma.memoryEvent.findMany({
        where: { scopeId, type: "stream" },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit
      })
  };
}

type DigestRow = {
  id: string;
  scopeId: string;
  summary: string;
  changes: string;
  nextSteps: unknown;
  createdAt: Date;
  rebuildGroupId?: string | null;
};

function toDigest(row: DigestRow): Digest {
  return {
    id: row.id,
    scopeId: row.scopeId,
    summary: row.summary,
    changes: row.changes,
    nextSteps: Array.isArray(row.nextSteps) ? (row.nextSteps as string[]) : [],
    createdAt: row.createdAt,
    rebuildGroupId: row.rebuildGroupId ?? null
  };
}

// Mirrors apps/api/src/domain.service.ts#digestRepo; keep in sync.
function makeDigestRepo(prisma: LitePrisma): DigestRepo {
  return {
    create: async (data) => {
      const created = await prisma.digest.create({
        data: { ...data, nextSteps: data.nextSteps, ...(data.rebuildGroupId ? { rebuildGroupId: data.rebuildGroupId } : {}) }
      });
      return toDigest(created as unknown as DigestRow);
    },
    listRecent: async (scopeId, limit, cursor) => {
      const items = await prisma.digest.findMany({
        where: { scopeId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
      });
      const next = items.length > limit ? items.pop() : null;
      return { items: items.map((item) => toDigest(item as unknown as DigestRow)), nextCursor: next ? next.id : null };
    },
    findLatest: async (scopeId) => {
      const found = await prisma.digest.findFirst({ where: { scopeId }, orderBy: { createdAt: "desc" } });
      return found ? toDigest(found as unknown as DigestRow) : null;
    }
  };
}

/**
 * `DisplayFact`/`groupFactsForDisplay` (packages/core/src/memory-facts.ts) carry
 * `factKey` but no fact-registry id, so `why()` — which looks entries up by
 * `FactRegistryEntry.id` — has nothing to key on from `facts()` output alone.
 * This recomputes the same `factKey` core derives for each active profile-type
 * registry entry (display group + content, `computeFactKey`) and joins it back
 * onto the grouped display items as `factId`. Local to apps/mcp: core's
 * `memory-facts.ts` has no equivalent join to mirror, since the API's
 * `getFacts` response never needed evidence-chain ids.
 */
function attachFactIds(
  groups: Array<{ group: DisplayGroup; items: Array<{ factKey: string; text: string; createdAt: string | null }> }>,
  state: DigestState,
  pack: FacetPack
): Array<{ group: DisplayGroup; items: Array<{ factKey: string; text: string; createdAt: string | null; factId: string | null }> }> {
  // First-wins: mirror flattenScopeFacts' dedup order (memory-facts.ts:60-69,
  // `if (!byKey.has(factKey))` before insert) so a factKey collision — two
  // sibling facets sharing a displayGroup with identical normalized content —
  // resolves to the same registry entry `facts()` actually displays. Keep in
  // sync with that first-wins invariant.
  const idByFactKey = new Map<string, string>();
  for (const entry of getActiveFactRegistry(state)) {
    if (entry.type !== "profile" || !entry.facet) continue;
    const group = factToGroup(entry.facet, pack);
    if (!group) continue;
    const factKey = computeFactKey(group, entry.content);
    if (!idByFactKey.has(factKey)) idByFactKey.set(factKey, entry.id);
  }
  return groups.map((g) => ({
    group: g.group,
    items: g.items.map((item) => ({ ...item, factId: idByFactKey.get(item.factKey) ?? null }))
  }));
}

/**
 * The keyless, in-process `MemoryBackend`: five memory operations over an
 * embedded SQLite store, with no LLM key required. `remember`/`facts`/`why`/
 * `forget` mirror the Nest-free equivalents in `apps/api/src`, cited at each
 * replicated block.
 */
export function createEmbeddedBackend(opts: { dataDir: string; scopeName: string; env: NodeJS.ProcessEnv }): MemoryBackend {
  let store: Store;
  let scopeId: string;

  async function latestState(): Promise<{ id: string; state: DigestState } | null> {
    const snap = await store.prisma.digestStateSnapshot.findFirst({ where: { scopeId }, orderBy: { createdAt: "desc" } });
    return snap ? { id: snap.id, state: snap.state as unknown as DigestState } : null;
  }

  // The scope this backend serves always has template "project" (init() is the
  // only place that creates it, and it always passes "project"), so the pack
  // resolution needs no per-call scope lookup — unlike memory-facts.service.ts,
  // which serves arbitrary scopes and reads `template` off each one.
  const packFor = () =>
    resolveFacetPackForScope(
      { findFacetPack: async (id) => (await store.prisma.user.findUnique({ where: { id }, select: { facetPack: true } }))?.facetPack ?? null },
      USER,
      "project"
    );

  return {
    async init() {
      store = await openStore(opts.dataDir);
      await store.prisma.user.upsert({ where: { identity: USER }, update: {}, create: { id: USER, identity: USER } });
      const existing = await store.prisma.projectScope.findFirst({ where: { userId: USER, name: opts.scopeName } });
      scopeId =
        existing?.id ??
        (await new ProjectService(makeProjectsRepo(store.prisma), makeUserStateRepo(store.prisma)).createScope(
          USER,
          opts.scopeName,
          null,
          undefined,
          "project"
        )).id;
      void maybeRunDigest({ prisma: store.prisma, userId: USER, scopeId, env: opts.env, reason: "startup" });
    },

    async remember({ text, consolidate }) {
      if (!consolidate) {
        // Mirrors apps/api/src/memory-facts.service.ts#addNote; keep in sync.
        const snap = await latestState();
        const pack = await packFor();
        if (snap) {
          if (addNoteFact(snap.state, text, () => randomUUID(), () => new Date().toISOString(), pack)) {
            await store.prisma.digestStateSnapshot.update({
              where: { id: snap.id },
              data: { state: snap.state as any }
            });
          }
        } else {
          const state: DigestState = { stableFacts: { decisions: [] }, workingNotes: {}, todos: [], factRegistry: [], profile: {} };
          addNoteFact(state, text, () => randomUUID(), () => new Date().toISOString(), pack);
          await store.prisma.$transaction(async (tx) => {
            const digest = await tx.digest.create({ data: { scopeId, summary: "Notes", changes: "", nextSteps: [] } });
            await tx.digestStateSnapshot.create({
              data: { scopeId, digestId: digest.id, state: state as any, consistency: Prisma.JsonNull }
            });
          });
        }
        return { ok: true, mode: "note" };
      }

      await new MemoryService(makeMemoryRepo(store.prisma)).ingestEvent({
        userId: USER,
        scopeId,
        type: "stream",
        source: "api",
        content: text
      });
      void maybeRunDigest({ prisma: store.prisma, userId: USER, scopeId, env: opts.env, reason: "threshold" });
      return { ok: true, mode: "event" };
    },

    async recall({ query, maxChars }) {
      const retrieve = new RetrieveService(makeDigestRepo(store.prisma), makeMemoryRepo(store.prisma), {});
      const result = await retrieve.retrieve(scopeId, 20, query);
      const digest = result.digest ? result.digest.summary : null;
      const events = result.events.map((event) => ({ id: event.id, content: event.content, createdAt: event.createdAt.toISOString() }));

      if (maxChars === undefined) {
        return { digest, events, retrieval: (result as { retrieval?: unknown }).retrieval ?? null };
      }

      // Mirrors apps/api/src/memory.controller.ts#retrieve (maxChars branch); keep in sync.
      const snap = await latestState();
      const activeFactRegistry = snap ? getActiveFactRegistry(snap.state) : [];
      const trimmedQuery = query?.trim();
      const packed = packWithinBudget({
        digest,
        facts: activeFactRegistry,
        events,
        maxChars,
        // No query means no relevance signal; the packer falls back to confidence
        // and recency rather than pretending to rank by relevance.
        scoreFact: trimmedQuery ? (content: string) => retrieve.scoreText(trimmedQuery, content) : undefined
      });

      const retrieval = (result as { retrieval?: { matches: Array<{ id: string }>; returnedCount: number } }).retrieval;
      const keptEventIds = new Set(packed.events.map((event) => event.id));
      const narrowedRetrieval = retrieval
        ? (() => {
            const matches = retrieval.matches.filter((match) => keptEventIds.has(match.id));
            return { ...retrieval, matches, returnedCount: matches.length };
          })()
        : (retrieval ?? null);

      return {
        digest: packed.digest,
        events: packed.events,
        factRegistry: packed.facts,
        budget: packed.budget,
        retrieval: narrowedRetrieval
      };
    },

    async facts() {
      // Mirrors apps/api/src/memory-facts.service.ts#getFacts; keep in sync.
      const [snapshot, forgotten] = await Promise.all([
        store.prisma.digestStateSnapshot.findFirst({ where: { scopeId }, orderBy: { createdAt: "desc" } }),
        store.prisma.forgottenFact.findMany({ where: { scopeId } })
      ]);
      if (!snapshot) return [];
      const forgottenKeys = new Set(forgotten.map((f) => f.factKey));
      const pack = await packFor();
      const state = snapshot.state as unknown as DigestState;
      const facts = flattenScopeFacts(state, undefined, pack).filter((f) => !forgottenKeys.has(f.factKey));
      const groups = groupFactsForDisplay(facts, pack);
      // groupFactsForDisplay drops factRegistry ids; attachFactIds (above) joins
      // them back on so why() has an id to consume.
      return attachFactIds(groups, state, pack);
    },

    async why({ factId }) {
      const snap = await latestState();
      return snap ? buildFactProvenance(snap.state, factId) : null;
    },

    async forget({ factKey }) {
      // Mirrors apps/api/src/memory-facts.service.ts#forgetFact; keep in sync.
      const snapshot = await store.prisma.digestStateSnapshot.findFirst({ where: { scopeId }, orderBy: { createdAt: "desc" } });
      const pack = await packFor();
      const facts = snapshot ? flattenScopeFacts(snapshot.state as unknown as DigestState, undefined, pack) : [];
      const match = facts.find((f) => f.factKey === factKey);
      const contentSnapshot = match?.text ?? "";

      await store.prisma.forgottenFact.upsert({
        where: { scopeId_factKey: { scopeId, factKey } },
        create: { userId: USER, scopeId, factKey, contentSnapshot },
        update: {}
      });

      if (match?.evidenceId) {
        await store.prisma.memoryEvent.updateMany({
          where: { id: match.evidenceId },
          data: { suppressedAt: new Date() }
        });
      }
      return { ok: true };
    },

    close: () => store.close()
  };
}
