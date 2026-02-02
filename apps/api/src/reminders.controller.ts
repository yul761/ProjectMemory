import { Body, Controller, Get, Inject, Param, Post, Query, Req } from "@nestjs/common";
import { ReminderCreateInput, ReminderStatus } from "@project-memory/contracts";
import { DomainService } from "./domain.service";
import type { RequestWithUser } from "./types";
import { reminderQueue } from "./queue";

@Controller()
export class RemindersController {
  constructor(@Inject(DomainService) private readonly domain: DomainService) {}

  @Post("/reminders")
  async createReminder(@Req() req: RequestWithUser, @Body() body: unknown) {
    const input = ReminderCreateInput.parse(body);
    if (input.scopeId) {
      const scope = await this.domain.projectService.getScope(req.userId, input.scopeId);
      if (!scope) return { error: "Scope not found" };
    }
    const reminder = await this.domain.reminderService.createReminder(
      req.userId,
      input.scopeId ?? null,
      new Date(input.dueAt),
      input.text
    );
    await reminderQueue.add("send_reminders", {});
    return {
      id: reminder.id,
      scopeId: reminder.scopeId ?? null,
      dueAt: reminder.dueAt.toISOString(),
      text: reminder.text,
      status: reminder.status,
      createdAt: reminder.createdAt.toISOString()
    };
  }

  @Get("/reminders")
  async listReminders(
    @Req() req: RequestWithUser,
    @Query("status") status?: string,
    @Query("limit") limit?: string,
    @Query("cursor") cursor?: string
  ) {
    const parsed = Number(limit ?? 20);
    const take = Math.min(Number.isFinite(parsed) ? parsed : 20, 100);
    const statusValue = status ? ReminderStatus.parse(status) : undefined;
    const { items, nextCursor } = await this.domain.reminderService.listReminders(req.userId, statusValue, take, cursor ?? null);
    return {
      items: items.map((reminder) => ({
        id: reminder.id,
        scopeId: reminder.scopeId ?? null,
        dueAt: reminder.dueAt.toISOString(),
        text: reminder.text,
        status: reminder.status,
        createdAt: reminder.createdAt.toISOString()
      })),
      nextCursor
    };
  }

  @Post("/reminders/:id/cancel")
  async cancelReminder(@Req() req: RequestWithUser, @Param("id") reminderId: string) {
    const ok = await this.domain.reminderService.cancelReminder(reminderId, req.userId);
    return { ok };
  }
}
