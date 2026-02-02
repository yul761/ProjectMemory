import { Body, Controller, Get, Inject, Param, Post, Req } from "@nestjs/common";
import { ScopeCreateInput } from "@project-memory/contracts";
import { DomainService } from "./domain.service";
import type { RequestWithUser } from "./types";

@Controller()
export class ScopesController {
  constructor(@Inject(DomainService) private readonly domain: DomainService) {}

  @Post("/scopes")
  async createScope(@Req() req: RequestWithUser, @Body() body: unknown) {
    const input = ScopeCreateInput.parse(body);
    const scope = await this.domain.projectService.createScope(req.userId, input.name, input.goal ?? null, input.stage);
    return {
      id: scope.id,
      name: scope.name,
      goal: scope.goal ?? null,
      stage: scope.stage,
      createdAt: scope.createdAt.toISOString()
    };
  }

  @Get("/scopes")
  async listScopes(@Req() req: RequestWithUser) {
    const scopes = await this.domain.projectService.listScopes(req.userId);
    return {
      items: scopes.map((scope) => ({
        id: scope.id,
        name: scope.name,
        goal: scope.goal ?? null,
        stage: scope.stage,
        createdAt: scope.createdAt.toISOString()
      }))
    };
  }

  @Post("/scopes/:id/active")
  async setActiveScope(@Req() req: RequestWithUser, @Param("id") scopeId: string) {
    const scope = await this.domain.projectService.getScope(req.userId, scopeId);
    if (!scope) {
      return { error: "Scope not found" };
    }
    const state = await this.domain.projectService.setActiveScope(req.userId, scopeId);
    return { activeScopeId: state.activeProjectId ?? null };
  }

  @Get("/state")
  async getState(@Req() req: RequestWithUser) {
    const state = await this.domain.projectService.getState(req.userId);
    return { activeScopeId: state?.activeProjectId ?? null };
  }
}
