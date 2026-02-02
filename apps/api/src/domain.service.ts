import { Injectable } from "@nestjs/common";
import { prisma } from "@project-memory/db";
import { DigestService, MemoryService, ProjectService, RetrieveService, ReminderService } from "@project-memory/core";

@Injectable()
export class DomainService {
  public projectService: ProjectService;
  public memoryService: MemoryService;
  public digestService: DigestService;
  public retrieveService: RetrieveService;
  public reminderService: ReminderService;

  constructor() {
    const projectsRepo = {
      create: (data: { userId: string; name: string; goal?: string | null; stage?: "idea" | "build" | "test" | "launch" }) =>
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
      }) => prisma.memoryEvent.create({ data }),
      upsertDocument: (data: { userId: string; scopeId: string; source: "telegram" | "cli" | "api" | "sdk"; key: string; content: string; contentHash?: string | null }) =>
        prisma.memoryEvent.upsert({
          where: { scopeId_key: { scopeId: data.scopeId, key: data.key } },
          update: { content: data.content, contentHash: data.contentHash, updatedAt: new Date() },
          create: { ...data, type: "document" }
        }),
      listRecent: async (scopeId: string, limit: number, cursor?: string | null) => {
        const items = await prisma.memoryEvent.findMany({
          where: { scopeId },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: limit + 1,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
        });
        const next = items.length > limit ? items.pop() : null;
        return { items, nextCursor: next ? next.id : null };
      },
      listByLookback: (scopeId: string, since: Date, limit: number) =>
        prisma.memoryEvent.findMany({
          where: { scopeId, createdAt: { gte: since } },
          orderBy: { createdAt: "desc" },
          take: limit
        })
    };

    const digestRepo = {
      create: (data: { scopeId: string; summary: string; changes: string; nextSteps: string[] }) =>
        prisma.digest.create({ data: { ...data, nextSteps: data.nextSteps } }),
      listRecent: async (scopeId: string, limit: number, cursor?: string | null) => {
        const items = await prisma.digest.findMany({
          where: { scopeId },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: limit + 1,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
        });
        const next = items.length > limit ? items.pop() : null;
        return { items, nextCursor: next ? next.id : null };
      },
      findLatest: (scopeId: string) => prisma.digest.findFirst({ where: { scopeId }, orderBy: { createdAt: "desc" } })
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
    this.retrieveService = new RetrieveService(digestRepo, memoryRepo);
    this.reminderService = new ReminderService(reminderRepo);
  }
}
