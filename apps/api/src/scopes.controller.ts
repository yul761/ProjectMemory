import { Body, Controller, Get, Inject, NotFoundException, Param, Patch, Post, Req } from "@nestjs/common";
import { ScopeActivationOutput, ScopeCreateInput, ScopeListOutput, ScopeOutput, StateOutput } from "@statecore/contracts";
import { prisma } from "@statecore/db";
import { DomainService } from "./domain.service";
import { parseOutput } from "./output";
import type { RequestWithUser } from "./types";
import { z } from "zod";

@Controller()
export class ScopesController {
  constructor(@Inject(DomainService) private readonly domain: DomainService) {}

  @Post("/scopes")
  async createScope(@Req() req: RequestWithUser, @Body() body: unknown) {
    const input = ScopeCreateInput.parse(body);
    const scope = await this.domain.projectService.createScope(req.userId, input.name, input.goal ?? null, input.stage, input.template);
    return parseOutput(ScopeOutput, {
      id: scope.id,
      name: scope.name,
      goal: scope.goal ?? null,
      stage: scope.stage,
      createdAt: scope.createdAt.toISOString()
    });
  }

  @Get("/scopes")
  async listScopes(@Req() req: RequestWithUser) {
    const scopes = await this.domain.projectService.listScopes(req.userId);
    return parseOutput(ScopeListOutput, {
      items: scopes.map((scope) => ({
        id: scope.id,
        name: scope.name,
        goal: scope.goal ?? null,
        stage: scope.stage,
        createdAt: scope.createdAt.toISOString()
      }))
    });
  }

  @Post("/scopes/:id/active")
  async setActiveScope(@Req() req: RequestWithUser, @Param("id") scopeId: string) {
    const scope = await this.domain.projectService.getScope(req.userId, scopeId);
    if (!scope) {
      throw new NotFoundException("Scope not found");
    }
    const state = await this.domain.projectService.setActiveScope(req.userId, scopeId);
    return parseOutput(ScopeActivationOutput, { activeScopeId: state.activeProjectId ?? null });
  }

  @Patch("/scopes/:id/webhook")
  async setWebhook(
    @Param("id") id: string,
    @Req() req: RequestWithUser,
    @Body() body: unknown
  ) {
    const input = z.object({
      notificationWebhook: z.string().url().nullable()
    }).parse(body);

    const scope = await this.domain.projectService.getScope(req.userId, id);
    if (!scope) throw new NotFoundException("Scope not found");

    const updated = await prisma.projectScope.updateMany({
      where: { id, userId: req.userId },
      data: { notificationWebhook: input.notificationWebhook }
    });
    if (updated.count === 0) throw new NotFoundException("Scope not found");

    return { ok: true };
  }

  @Get("/state")
  async getState(@Req() req: RequestWithUser) {
    const state = await this.domain.projectService.getState(req.userId);
    return parseOutput(StateOutput, { activeScopeId: state?.activeProjectId ?? null });
  }
}
