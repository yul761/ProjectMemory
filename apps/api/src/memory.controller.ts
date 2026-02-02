import { BadRequestException, Body, Controller, Get, Post, Query, Req } from "@nestjs/common";
import {
  AnswerInput,
  DigestRequestInput,
  MemoryEventInput,
  RetrieveInput
} from "@project-memory/contracts";
import { generateAnswer, LlmClient } from "@project-memory/core";
import { digestQueue } from "./queue";
import { DomainService } from "./domain.service";
import type { RequestWithUser } from "./types";
import { apiEnv } from "./env";
import { answerSystemPrompt, answerUserPrompt } from "@project-memory/prompts";

@Controller()
export class MemoryController {
  private llm: LlmClient | null = null;

  constructor(private readonly domain: DomainService) {
    if (apiEnv.featureLlm && apiEnv.openaiApiKey) {
      this.llm = new LlmClient({
        apiKey: apiEnv.openaiApiKey,
        baseUrl: apiEnv.openaiBaseUrl,
        model: apiEnv.openaiModel,
        timeoutMs: 20000
      });
    }
  }

  @Post("/memory/events")
  async ingestEvent(@Req() req: RequestWithUser, @Body() body: unknown) {
    const input = MemoryEventInput.parse(body);
    if (input.type === "document" && !input.key) {
      return { error: "key required for document events" };
    }
    const scope = await this.domain.projectService.getScope(req.userId, input.scopeId);
    if (!scope) {
      return { error: "Scope not found" };
    }
    const event = await this.domain.memoryService.ingestEvent({
      userId: req.userId,
      scopeId: input.scopeId,
      type: input.type,
      source: input.source ?? "api",
      key: input.key ?? null,
      content: input.content
    });
    return {
      id: event.id,
      userId: event.userId,
      scopeId: event.scopeId,
      type: event.type,
      source: event.source,
      key: event.key ?? null,
      content: event.content,
      createdAt: event.createdAt.toISOString(),
      updatedAt: event.updatedAt ? event.updatedAt.toISOString() : null
    };
  }

  @Get("/memory/events")
  async listEvents(
    @Req() req: RequestWithUser,
    @Query("scopeId") scopeId?: string,
    @Query("limit") limit?: string,
    @Query("cursor") cursor?: string
  ) {
    if (!scopeId) return { error: "scopeId required" };
    const scope = await this.domain.projectService.getScope(req.userId, scopeId);
    if (!scope) {
      return { error: "Scope not found" };
    }
    const parsed = Number(limit ?? 20);
    const take = Math.min(Number.isFinite(parsed) ? parsed : 20, 100);
    const { items, nextCursor } = await this.domain.memoryService.listEvents(scopeId, take, cursor ?? null);
    return {
      items: items.map((event) => ({
        id: event.id,
        userId: event.userId,
        scopeId: event.scopeId,
        type: event.type,
        source: event.source,
        key: event.key ?? null,
        content: event.content,
        createdAt: event.createdAt.toISOString(),
        updatedAt: event.updatedAt ? event.updatedAt.toISOString() : null
      })),
      nextCursor
    };
  }

  @Post("/memory/digest")
  async enqueueDigest(@Req() req: RequestWithUser, @Body() body: unknown) {
    const input = DigestRequestInput.parse(body);
    const scope = await this.domain.projectService.getScope(req.userId, input.scopeId);
    if (!scope) {
      return { error: "Scope not found" };
    }
    const job = await digestQueue.add("digest_scope", { userId: req.userId, scopeId: input.scopeId });
    return { jobId: job.id };
  }

  @Get("/memory/digests")
  async listDigests(
    @Req() req: RequestWithUser,
    @Query("scopeId") scopeId?: string,
    @Query("limit") limit?: string,
    @Query("cursor") cursor?: string
  ) {
    if (!scopeId) return { error: "scopeId required" };
    const scope = await this.domain.projectService.getScope(req.userId, scopeId);
    if (!scope) {
      return { error: "Scope not found" };
    }
    const parsed = Number(limit ?? 20);
    const take = Math.min(Number.isFinite(parsed) ? parsed : 20, 100);
    const { items, nextCursor } = await this.domain.digestService.listDigests(scopeId, take, cursor ?? null);
    return {
      items: items.map((digest) => ({
        id: digest.id,
        scopeId: digest.scopeId,
        summary: digest.summary,
        changes: digest.changes,
        nextSteps: digest.nextSteps,
        createdAt: digest.createdAt.toISOString()
      })),
      nextCursor
    };
  }

  @Post("/memory/retrieve")
  async retrieve(@Req() req: RequestWithUser, @Body() body: unknown) {
    const input = RetrieveInput.parse(body);
    const scope = await this.domain.projectService.getScope(req.userId, input.scopeId);
    if (!scope) {
      return { error: "Scope not found" };
    }
    const limit = input.limit ?? 20;
    const result = await this.domain.retrieveService.retrieve(input.scopeId, limit);
    return {
      digest: result.digest ? result.digest.summary : null,
      events: result.events.map((event) => ({
        id: event.id,
        content: event.content,
        createdAt: event.createdAt.toISOString()
      }))
    };
  }

  @Post("/memory/answer")
  async answer(@Req() req: RequestWithUser, @Body() body: unknown) {
    if (!apiEnv.featureLlm || !this.llm) {
      throw new BadRequestException("FEATURE_LLM disabled");
    }
    const input = AnswerInput.parse(body);
    const scope = await this.domain.projectService.getScope(req.userId, input.scopeId);
    if (!scope) {
      return { error: "Scope not found" };
    }
    const result = await this.domain.retrieveService.retrieve(input.scopeId, 25);
    const digestText = result.digest ? result.digest.summary : null;
    const eventsText = result.events.map((event) => `- ${event.createdAt.toISOString()}: ${event.content}`).join("\n");

    const answer = await generateAnswer({
      question: input.question,
      digestText,
      eventsText,
      systemPrompt: answerSystemPrompt,
      userPromptTemplate: answerUserPrompt,
      llm: this.llm
    });

    return { answer };
  }
}
