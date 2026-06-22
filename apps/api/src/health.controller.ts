import { Controller, Get } from "@nestjs/common";
import { HealthOutput } from "@statecore/contracts";
import { readFileSync } from "fs";
import { join } from "path";
import { apiEnv } from "./env";
import { parseOutput } from "./output";
import { digestQueue, workingMemoryQueue } from "./queue";

@Controller()
export class HealthController {
  @Get("/diagnostics/queues")
  async getQueueStatus() {
    const [digest, workingMemory] = await Promise.all([
      digestQueue.getJobCounts(),
      workingMemoryQueue.getJobCounts()
    ]);
    return { digest, workingMemory };
  }

  @Get("/diagnostics/mcp-usage")
  getMcpUsage() {
    const today = new Date().toISOString().slice(0, 10);
    const logFile = join(process.cwd(), "mcp-usage-log", `usage-${today}.jsonl`);
    const counts: Record<string, number> = {};
    try {
      const lines = readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as { tool?: string };
          if (entry.tool && entry.tool !== "server_start") {
            counts[entry.tool] = (counts[entry.tool] ?? 0) + 1;
          }
        } catch {}
      }
    } catch {}
    return { today, counts };
  }

  @Get(["/health", "/v1/health"])
  getHealth() {
    return parseOutput(HealthOutput, {
      status: "ok",
      featureLlm: apiEnv.featureLlm,
      workingMemory: {
        enabled: apiEnv.workingMemoryEnabled,
        useLlm: apiEnv.workingMemoryUseLlm,
        maxRecentTurns: apiEnv.workingMemoryMaxRecentTurns,
        maxItemsPerField: apiEnv.workingMemoryMaxItemsPerField
      },
      retrieve: {
        useEmbeddings: apiEnv.retrieveUseEmbeddings,
        useVectorSearch: apiEnv.retrieveUseVectorSearch,
        embeddingCandidateLimit: apiEnv.retrieveEmbeddingCandidateLimit
      },
      model: {
        provider: apiEnv.modelProvider,
        model: apiEnv.modelName,
        baseUrl: apiEnv.modelBaseUrl,
        chatModel: apiEnv.chatModelName,
        runtimeModel: apiEnv.runtimeModelName,
        runtimeModelBaseUrl: apiEnv.runtimeModelBaseUrl,
        runtimeReasoningEffort: apiEnv.runtimeModelReasoningEffort,
        runtimeMaxOutputTokens: apiEnv.runtimeModelMaxOutputTokens,
        structuredOutputModel: apiEnv.structuredOutputModelName,
        embeddingModel: apiEnv.embeddingModelName || null
      }
    });
  }
}
