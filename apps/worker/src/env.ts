import { existsSync, readFileSync } from "fs";
import { z } from "zod";
import path from "path";

function loadEnvFile(filePath: string) {
  if (!existsSync(filePath)) return;
  const lines = readFileSync(filePath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (process.env[key] !== undefined) continue;
    process.env[key] = value;
  }
}

const repoRoot = path.resolve(__dirname, "../../..");
loadEnvFile(path.join(repoRoot, ".env"));
loadEnvFile(path.join(repoRoot, "apps/worker/.env"));

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  FEATURE_LLM: z.string().optional(),
  WORKING_MEMORY_ENABLED: z.string().optional(),
  WORKING_MEMORY_USE_LLM: z.string().optional(),
  WORKING_MEMORY_MAX_RECENT_TURNS: z.string().optional(),
  WORKING_MEMORY_MAX_ITEMS_PER_FIELD: z.string().optional(),
  FEATURE_TELEGRAM: z.string().optional(),
  MODEL_PROVIDER: z.string().optional(),
  MODEL_API_KEY: z.string().optional(),
  MODEL_BASE_URL: z.string().optional(),
  MODEL_NAME: z.string().optional(),
  MODEL_CHAT_API_KEY: z.string().optional(),
  MODEL_CHAT_BASE_URL: z.string().optional(),
  MODEL_CHAT_NAME: z.string().optional(),
  MODEL_STRUCTURED_OUTPUT_API_KEY: z.string().optional(),
  MODEL_STRUCTURED_OUTPUT_BASE_URL: z.string().optional(),
  MODEL_STRUCTURED_OUTPUT_NAME: z.string().optional(),
  MODEL_STRUCTURED_OUTPUT_REASONING_EFFORT: z.string().optional(),
  MODEL_STRUCTURED_OUTPUT_MAX_OUTPUT_TOKENS: z.string().optional(),
  MODEL_EMBEDDING_API_KEY: z.string().optional(),
  MODEL_EMBEDDING_BASE_URL: z.string().optional(),
  MODEL_EMBEDDING_NAME: z.string().optional(),
  MODEL_TIMEOUT_MS: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().optional(),
  OPENAI_MODEL: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  DIGEST_MAX_RECENT_EVENTS: z.string().optional(),
  DIGEST_FIRST_RUN_MAX_EVENTS: z.string().optional(),
  DIGEST_MAX_DAYS_LOOKBACK: z.string().optional(),
  DIGEST_EVENT_BUDGET_TOTAL: z.string().optional(),
  DIGEST_EVENT_BUDGET_DOCS: z.string().optional(),
  DIGEST_EVENT_BUDGET_STREAM: z.string().optional(),
  DIGEST_NOVELTY_THRESHOLD: z.string().optional(),
  DIGEST_MAX_RETRIES: z.string().optional(),
  DIGEST_USE_LLM_CLASSIFIER: z.string().optional(),
  DIGEST_DEBUG: z.string().optional(),
  DIGEST_REBUILD_CHUNK_SIZE: z.string().optional(),
  DIGEST_CONCURRENCY: z.string().optional(),
  REMINDER_CONCURRENCY: z.string().optional(),
  REMINDER_BATCH_SIZE: z.string().optional(),
  REMINDER_MAX_BATCHES: z.string().optional()
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error("Invalid environment variables", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const env = parsed.data;
const toBool = (value?: string) => value === "true";
const clean = (value?: string) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};
const requiresApiKeyForBaseUrl = (baseUrl: string) => /(^https?:\/\/)?api\.openai\.com\/?/i.test(baseUrl);
const modelBaseUrl = clean(env.MODEL_BASE_URL) || clean(env.OPENAI_BASE_URL) || "https://api.openai.com/v1";
const modelName = clean(env.MODEL_NAME) || clean(env.OPENAI_MODEL) || "gpt-4o-mini";
const chatModelBaseUrl = clean(env.MODEL_CHAT_BASE_URL) || modelBaseUrl;
const structuredOutputModelBaseUrl = clean(env.MODEL_STRUCTURED_OUTPUT_BASE_URL) || modelBaseUrl;
const embeddingModelBaseUrl = clean(env.MODEL_EMBEDDING_BASE_URL) || modelBaseUrl;
const chatModelApiKey = clean(env.MODEL_CHAT_API_KEY) ?? clean(env.MODEL_API_KEY) ?? clean(env.OPENAI_API_KEY) ?? "";
const structuredOutputModelApiKey = clean(env.MODEL_STRUCTURED_OUTPUT_API_KEY) ?? clean(env.MODEL_API_KEY) ?? clean(env.OPENAI_API_KEY) ?? "";
const embeddingModelApiKey = clean(env.MODEL_EMBEDDING_API_KEY) ?? clean(env.MODEL_API_KEY) ?? clean(env.OPENAI_API_KEY) ?? "";
const chatModelName = clean(env.MODEL_CHAT_NAME) || modelName;
const structuredOutputModelName = clean(env.MODEL_STRUCTURED_OUTPUT_NAME) || modelName;
const embeddingModelName = clean(env.MODEL_EMBEDDING_NAME) || "";
const modelApiKey = clean(env.MODEL_API_KEY) || clean(env.OPENAI_API_KEY) || "";
const modelProvider = clean(env.MODEL_PROVIDER) || "openai-compatible";
const requiresApiKey = requiresApiKeyForBaseUrl(modelBaseUrl);

if (toBool(env.FEATURE_LLM) && requiresApiKey && !modelApiKey) {
  // eslint-disable-next-line no-console
  console.error("Invalid environment variables", { MODEL_API_KEY: ["MODEL_API_KEY or OPENAI_API_KEY required for the configured provider when FEATURE_LLM=true"] });
  process.exit(1);
}

if (toBool(env.FEATURE_LLM) && requiresApiKeyForBaseUrl(chatModelBaseUrl) && !chatModelApiKey) {
  // eslint-disable-next-line no-console
  console.error("Invalid environment variables", { MODEL_CHAT_API_KEY: ["MODEL_CHAT_API_KEY, MODEL_API_KEY, or OPENAI_API_KEY required for chat model configuration when FEATURE_LLM=true"] });
  process.exit(1);
}

if (toBool(env.FEATURE_LLM) && requiresApiKeyForBaseUrl(structuredOutputModelBaseUrl) && !structuredOutputModelApiKey) {
  // eslint-disable-next-line no-console
  console.error("Invalid environment variables", { MODEL_STRUCTURED_OUTPUT_API_KEY: ["MODEL_STRUCTURED_OUTPUT_API_KEY, MODEL_API_KEY, or OPENAI_API_KEY required for structured-output model configuration when FEATURE_LLM=true"] });
  process.exit(1);
}

if (toBool(env.FEATURE_LLM) && embeddingModelName && requiresApiKeyForBaseUrl(embeddingModelBaseUrl) && !embeddingModelApiKey) {
  // eslint-disable-next-line no-console
  console.error("Invalid environment variables", { MODEL_EMBEDDING_API_KEY: ["MODEL_EMBEDDING_API_KEY, MODEL_API_KEY, or OPENAI_API_KEY required for embedding model configuration when FEATURE_LLM=true"] });
  process.exit(1);
}

export const workerEnv = {
  databaseUrl: env.DATABASE_URL,
  redisUrl: env.REDIS_URL,
  featureLlm: toBool(env.FEATURE_LLM),
  workingMemoryEnabled: env.WORKING_MEMORY_ENABLED ? toBool(env.WORKING_MEMORY_ENABLED) : true,
  workingMemoryUseLlm: toBool(env.WORKING_MEMORY_USE_LLM),
  workingMemoryMaxRecentTurns: Number(env.WORKING_MEMORY_MAX_RECENT_TURNS || 6),
  workingMemoryMaxItemsPerField: Number(env.WORKING_MEMORY_MAX_ITEMS_PER_FIELD || 10),
  featureTelegram: toBool(env.FEATURE_TELEGRAM),
  modelProvider,
  modelApiKey,
  modelBaseUrl,
  modelName,
  chatModelApiKey,
  chatModelBaseUrl,
  chatModelName,
  structuredOutputModelApiKey,
  structuredOutputModelBaseUrl,
  structuredOutputModelName,
  structuredOutputReasoningEffort: env.MODEL_STRUCTURED_OUTPUT_REASONING_EFFORT as "low" | "medium" | "high" | undefined,
  structuredOutputMaxOutputTokens: env.MODEL_STRUCTURED_OUTPUT_MAX_OUTPUT_TOKENS
    ? Number(env.MODEL_STRUCTURED_OUTPUT_MAX_OUTPUT_TOKENS)
    : undefined,
  embeddingModelApiKey,
  embeddingModelBaseUrl,
  embeddingModelName,
  modelTimeoutMs: Number(env.MODEL_TIMEOUT_MS || 20000),
  telegramBotToken: env.TELEGRAM_BOT_TOKEN || "",
  maxRecentEvents: Number(env.DIGEST_MAX_RECENT_EVENTS || 50),
  digestFirstRunMaxEvents: Number(env.DIGEST_FIRST_RUN_MAX_EVENTS ?? "200"),
  maxDaysLookback: Number(env.DIGEST_MAX_DAYS_LOOKBACK || 14),
  digestEventBudgetTotal: Number(env.DIGEST_EVENT_BUDGET_TOTAL || 40),
  digestEventBudgetDocs: Number(env.DIGEST_EVENT_BUDGET_DOCS || 10),
  digestEventBudgetStream: Number(env.DIGEST_EVENT_BUDGET_STREAM || 30),
  digestNoveltyThreshold: Number(env.DIGEST_NOVELTY_THRESHOLD || 0.15),
  digestMaxRetries: Number(env.DIGEST_MAX_RETRIES || 1),
  digestUseLlmClassifier: toBool(env.DIGEST_USE_LLM_CLASSIFIER),
  digestDebug: toBool(env.DIGEST_DEBUG),
  digestRebuildChunkSize: Number(env.DIGEST_REBUILD_CHUNK_SIZE || 80),
  digestConcurrency: Number(env.DIGEST_CONCURRENCY || 2),
  reminderConcurrency: Number(env.REMINDER_CONCURRENCY || 1),
  reminderBatchSize: Number(env.REMINDER_BATCH_SIZE || 50),
  reminderMaxBatches: Number(env.REMINDER_MAX_BATCHES || 4)
};
