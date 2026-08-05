import { Injectable } from "@nestjs/common";
import { prisma } from "@statecore/db";
import {
  DigestService,
  MemoryService,
  ProjectService,
  RetrieveService,
  ReminderService,
  WorkingMemoryService,
  compileStateLayerView,
  createModelProvider
} from "@statecore/core";
import type { DigestConsistencyResult, DigestState, WorkingMemorySnapshot, WorkingMemoryState, WorkingMemoryView } from "@statecore/core";
import { apiEnv } from "./env";
import { registerLiteHandlers } from "./queue";
import { selectWorkingMemoryEvents } from "@statecore/core";
import { createVectorSearchFn } from "./vector-search";

@Injectable()
export class DomainService {
  public projectService: ProjectService;
  public memoryService: MemoryService;
  public digestService: DigestService;
  public retrieveService: RetrieveService;
  public workingMemoryService: WorkingMemoryService;
  public reminderService: ReminderService;

  private mapDigestStateSnapshot(snapshot: {
    digestId: string;
    state: unknown;
    consistency: unknown;
    createdAt: Date;
  }): { digestId: string; state: DigestState; consistency: DigestConsistencyResult | null; createdAt: Date } {
    return {
      digestId: snapshot.digestId,
      state: snapshot.state as DigestState,
      consistency: snapshot.consistency as DigestConsistencyResult | null,
      createdAt: snapshot.createdAt
    };
  }

  constructor() {
    type DigestRow = {
      id: string;
      scopeId: string;
      summary: string;
      changes: string;
      nextSteps: unknown;
      createdAt: Date;
      rebuildGroupId?: string | null;
    };

    const toDigest = (row: DigestRow) => ({
      id: row.id,
      scopeId: row.scopeId,
      summary: row.summary,
      changes: row.changes,
      nextSteps: Array.isArray(row.nextSteps) ? (row.nextSteps as string[]) : [],
      createdAt: row.createdAt,
      rebuildGroupId: row.rebuildGroupId ?? null
    });

    const projectsRepo = {
      create: (data: { userId: string; name: string; goal?: string | null; stage?: "idea" | "build" | "test" | "launch"; template?: string }) =>
        prisma.projectScope.create({ data }),
      listByUser: (userId: string) => prisma.projectScope.findMany({ where: { userId }, orderBy: { createdAt: "desc" } }),
      findById: (scopeId: string, userId: string) => prisma.projectScope.findFirst({ where: { id: scopeId, userId } })
    };

    const userStateRepo = {
      getByUserId: (userId: string) => prisma.userState.findUnique({ where: { userId } }),
      upsertActiveProject: (userId: string, scopeId: string | null) =>
        prisma.userState.upsert({
          where: { userId },
          update: { activeProjectId: scopeId },
          create: { userId, activeProjectId: scopeId }
        })
    };

    const memoryRepo = {
      create: (data: {
        userId: string;
        scopeId: string;
        type: "stream" | "document";
        source: "telegram" | "cli" | "api" | "sdk";
        key?: string | null;
        content: string;
        contentHash?: string | null;
        createdAt?: Date;
        pinned?: boolean;
      }) => prisma.memoryEvent.create({ data }),
      upsertDocument: (data: { userId: string; scopeId: string; source: "telegram" | "cli" | "api" | "sdk"; key: string; content: string; contentHash?: string | null; createdAt?: Date; pinned?: boolean }) =>
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
      listRecent: async (scopeId: string, limit: number, cursor?: string | null) => {
        const items = await prisma.memoryEvent.findMany({
          where: { scopeId, suppressedAt: null },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: limit + 1,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
        });
        const next = items.length > limit ? items.pop() : null;
        return { items, nextCursor: next ? next.id : null };
      },
      findByIds: (ids: string[]) =>
        ids.length
          ? prisma.memoryEvent.findMany({
              where: { id: { in: ids }, suppressedAt: null },
              orderBy: [{ createdAt: "desc" }, { id: "desc" }]
            })
          : Promise.resolve([]),
      listByLookback: (scopeId: string, since: Date, limit: number) =>
        prisma.memoryEvent.findMany({
          where: { scopeId, createdAt: { gte: since }, suppressedAt: null },
          orderBy: { createdAt: "desc" },
          take: limit
        }),
      listRecentTurns: (scopeId: string, limit: number) =>
        prisma.memoryEvent.findMany({
          where: { scopeId, type: "stream" },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: limit
        })
    };

    const digestRepo = {
      create: async (data: { scopeId: string; summary: string; changes: string; nextSteps: string[]; rebuildGroupId?: string | null }) => {
        const created = await prisma.digest.create({ data: { ...data, nextSteps: data.nextSteps, ...(data.rebuildGroupId ? ({ rebuildGroupId: data.rebuildGroupId } as any) : {}) } as any });
        return toDigest(created as any);
      },
      listRecent: async (scopeId: string, limit: number, cursor?: string | null) => {
        const items = await prisma.digest.findMany({
          where: { scopeId },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: limit + 1,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
        });
        const next = items.length > limit ? items.pop() : null;
        return { items: items.map((item: DigestRow) => toDigest(item)), nextCursor: next ? next.id : null };
      },
      findLatest: async (scopeId: string) => {
        const found = await prisma.digest.findFirst({ where: { scopeId }, orderBy: { createdAt: "desc" } });
        return found ? toDigest(found as any) : null;
      }
    };

    const reminderRepo = {
      create: (data: { userId: string; scopeId?: string | null; dueAt: Date; text: string }) =>
        prisma.reminder.create({ data }),
      listByUser: async (userId: string, status?: "scheduled" | "sent" | "cancelled", limit?: number, cursor?: string | null) => {
        const take = Math.min(limit ?? 20, 100);
        const items = await prisma.reminder.findMany({
          where: { userId, ...(status ? { status } : {}) },
          orderBy: [{ dueAt: "asc" }, { id: "asc" }],
          take: take + 1,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
        });
        const next = items.length > take ? items.pop() : null;
        return { items, nextCursor: next ? next.id : null };
      },
      cancel: async (reminderId: string, userId: string) => {
        const reminder = await prisma.reminder.findFirst({ where: { id: reminderId, userId } });
        if (!reminder) return false;
        await prisma.reminder.update({ where: { id: reminderId }, data: { status: "cancelled" } });
        return true;
      },
      listDue: (now: Date, limit: number) =>
        prisma.reminder.findMany({
          where: { status: "scheduled", dueAt: { lte: now } },
          orderBy: { dueAt: "asc" },
          take: limit
        }),
      markSent: (reminderId: string) => prisma.reminder.update({ where: { id: reminderId }, data: { status: "sent" } }).then(() => undefined)
    };

    this.projectService = new ProjectService(projectsRepo, userStateRepo);
    this.memoryService = new MemoryService(memoryRepo);
    this.digestService = new DigestService(digestRepo);
    this.workingMemoryService = new WorkingMemoryService({
      findLatest: async (scopeId: string) => {
        const snapshot = await prisma.workingMemorySnapshot.findUnique({ where: { scopeId } });
        if (!snapshot) return null;
        return {
          id: snapshot.id,
          scopeId: snapshot.scopeId,
          version: snapshot.version,
          state: snapshot.state as unknown as WorkingMemoryState,
          view: snapshot.view as unknown as WorkingMemoryView,
          createdAt: snapshot.createdAt,
          updatedAt: snapshot.updatedAt
        } satisfies WorkingMemorySnapshot;
      },
      upsert: async (input) => {
        const snapshot = await prisma.workingMemorySnapshot.upsert({
          where: { scopeId: input.scopeId },
          update: {
            version: input.version,
            state: input.state as any,
            view: input.view as any
          },
          create: {
            scopeId: input.scopeId,
            version: input.version,
            state: input.state as any,
            view: input.view as any
          }
        });
        return {
          id: snapshot.id,
          scopeId: snapshot.scopeId,
          version: snapshot.version,
          state: snapshot.state as unknown as WorkingMemoryState,
          view: snapshot.view as unknown as WorkingMemoryView,
          createdAt: snapshot.createdAt,
          updatedAt: snapshot.updatedAt
        } satisfies WorkingMemorySnapshot;
      }
    }, {
      maxItemsPerField: apiEnv.workingMemoryMaxItemsPerField
    });
    const provider = apiEnv.featureLlm
      ? createModelProvider({
          provider: apiEnv.modelProvider,
          apiKey: apiEnv.modelApiKey,
          baseUrl: apiEnv.modelBaseUrl,
          model: apiEnv.modelName,
          chatApiKey: apiEnv.chatModelApiKey,
          chatBaseUrl: apiEnv.chatModelBaseUrl,
          chatModel: apiEnv.chatModelName,
          structuredOutputApiKey: apiEnv.structuredOutputModelApiKey,
          structuredOutputBaseUrl: apiEnv.structuredOutputModelBaseUrl,
          structuredOutputModel: apiEnv.structuredOutputModelName,
          embeddingApiKey: apiEnv.embeddingModelApiKey,
          embeddingBaseUrl: apiEnv.embeddingModelBaseUrl,
          embeddingModel: apiEnv.embeddingModelName || undefined
        })
      : null;
    this.retrieveService = new RetrieveService(digestRepo, memoryRepo, {
      embeddingModel: provider?.embedding ?? null,
      useEmbeddingRerank: apiEnv.retrieveUseEmbeddings,
      embeddingCandidateLimit: apiEnv.retrieveEmbeddingCandidateLimit,
      useVectorSearch: apiEnv.retrieveUseVectorSearch,
      vectorSearchFn: apiEnv.retrieveUseVectorSearch && provider?.embedding
        ? createVectorSearchFn(prisma)
        : undefined
    });
    this.reminderService = new ReminderService(reminderRepo);

    if (process.env["STATECORE_MODE"] === "lite") {
      const wmMaxTurns = apiEnv.workingMemoryMaxRecentTurns;
      const wmSvc = this.workingMemoryService;
      registerLiteHandlers({
        workingMemory: async (_jobName, data) => {
          const { scopeId } = data as { userId: string; scopeId: string };
          const take = Math.max(wmMaxTurns * 3, wmMaxTurns + 8);
          const { prisma: db } = await import("@statecore/db");
          const [recentEvents, scope] = await Promise.all([
            db.memoryEvent.findMany({
              where: { scopeId },
              orderBy: [{ createdAt: "desc" }, { id: "desc" }],
              take
            }),
            db.projectScope.findUnique({ where: { id: scopeId }, select: { goal: true } })
          ]);
          const selected = selectWorkingMemoryEvents(
            recentEvents.reverse().map((event) => ({
              id: event.id,
              type: event.type as "stream" | "document",
              key: event.key ?? null,
              content: event.content,
              createdAt: event.createdAt,
              role: /^assistant reply:/i.test(event.content.trim()) ? "assistant" as const : "user" as const
            })),
            wmMaxTurns
          );
          await wmSvc.updateFromEvents(scopeId, selected, scope?.goal);
        }
      });
    }
  }

  async getLatestDigestState(scopeId: string): Promise<{ digestId: string; state: DigestState; consistency: DigestConsistencyResult | null; createdAt: Date } | null> {
    const snapshot = await prisma.digestStateSnapshot.findFirst({
      where: { scopeId },
      orderBy: { createdAt: "desc" }
    });
    if (!snapshot) return null;
    return this.mapDigestStateSnapshot(snapshot);
  }

  async getLatestMemoryEvent(scopeId: string): Promise<{ id: string; createdAt: Date } | null> {
    const event = await prisma.memoryEvent.findFirst({
      where: { scopeId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        createdAt: true
      }
    });
    return event ?? null;
  }

  async listDigests(scopeId: string, limit: number, cursor?: string | null, rebuildGroupId?: string | null) {
    type DigestRow = {
      id: string;
      scopeId: string;
      summary: string;
      changes: string;
      nextSteps: unknown;
      createdAt: Date;
      rebuildGroupId?: string | null;
    };

    const items = await prisma.digest.findMany({
      where: { scopeId, ...(rebuildGroupId ? { rebuildGroupId } : {}) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
    });
    const next = items.length > limit ? items.pop() : null;
    return {
      items: items.map((row: DigestRow) => ({
        id: row.id,
        scopeId: row.scopeId,
        summary: row.summary,
        changes: row.changes,
        nextSteps: Array.isArray(row.nextSteps) ? (row.nextSteps as string[]) : [],
        createdAt: row.createdAt,
        rebuildGroupId: row.rebuildGroupId ?? null
      })),
      nextCursor: next ? next.id : null
    };
  }

  async listDigestStates(
    scopeId: string,
    limit: number,
    rebuildGroupId?: string | null
  ): Promise<Array<{ digestId: string; state: DigestState; consistency: DigestConsistencyResult | null; createdAt: Date }>> {
    const snapshots = await prisma.digestStateSnapshot.findMany({
      where: { scopeId, ...(rebuildGroupId ? { digest: { rebuildGroupId } } : {}) },
      orderBy: { createdAt: "desc" },
      take: limit
    });
    return snapshots.map((snapshot) => this.mapDigestStateSnapshot(snapshot));
  }

  async getLatestWorkingMemory(scopeId: string) {
    return this.workingMemoryService.getLatest(scopeId);
  }

  async getStateLayerView(scopeId: string) {
    const snapshot = await this.getLatestDigestState(scopeId);
    if (!snapshot) return null;
    return {
      digestId: snapshot.digestId,
      state: snapshot.state,
      view: compileStateLayerView(snapshot.state),
      consistency: snapshot.consistency,
      createdAt: snapshot.createdAt
    };
  }

  async listRecentTurns(scopeId: string, limit: number): Promise<Array<{ id: string; content: string; createdAt: Date }>> {
    const recent = await prisma.memoryEvent.findMany({
      where: { scopeId, type: "stream" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: Math.max(limit * 4, limit)
    });
    const ordered = recent.reverse();
    const grouped: Array<{ id: string; content: string; createdAt: Date }> = [];

    for (const event of ordered) {
      const role = /^assistant reply:/i.test(event.content.trim()) ? "assistant" : "user";
      const previous = grouped[grouped.length - 1];
      const previousRole = previous && /^assistant reply:/i.test(previous.content.trim()) ? "assistant" : "user";
      const withinTurnWindow = previous
        ? Math.abs(event.createdAt.getTime() - previous.createdAt.getTime()) <= 5_000
        : false;

      if (previous && previousRole === role && withinTurnWindow && role === "user") {
        previous.content = `${previous.content}\n${event.content}`;
        continue;
      }

      grouped.push({
        id: event.id,
        content: event.content,
        createdAt: event.createdAt
      });
    }

    return grouped.slice(-limit);
  }
}
