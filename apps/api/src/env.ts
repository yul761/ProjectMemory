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
loadEnvFile(path.join(repoRoot, "apps/api/.env"));

const envSchema = z.object({
  PORT: z.string().optional(),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().optional(),
  STATECORE_MODE: z.enum(["lite", "full"]).optional(),
  LOG_LEVEL: z.string().optional(),
  LOCAL_USER_TOKEN: z.string().optional(),
  FEATURE_LLM: z.string().optional(),
  WORKING_MEMORY_ENABLED: z.string().optional(),
  WORKING_MEMORY_USE_LLM: z.string().optional(),
  WORKING_MEMORY_MAX_RECENT_TURNS: z.string().optional(),
  WORKING_MEMORY_MAX_ITEMS_PER_FIELD: z.string().optional(),
  RETRIEVE_USE_EMBEDDINGS: z.string().optional(),
  RETRIEVE_USE_VECTOR_SEARCH: z.string().optional(),
  RETRIEVE_EMBEDDING_CANDIDATE_LIMIT: z.string().optional(),
  MODEL_PROVIDER: z.string().optional(),
  MODEL_API_KEY: z.string().optional(),
  MODEL_BASE_URL: z.string().optional(),
  MODEL_NAME: z.string().optional(),
  MODEL_CHAT_API_KEY: z.string().optional(),
  MODEL_CHAT_BASE_URL: z.string().optional(),
  MODEL_CHAT_NAME: z.string().optional(),
  MODEL_RUNTIME_API_KEY: z.string().optional(),
  MODEL_RUNTIME_BASE_URL: z.string().optional(),
  MODEL_RUNTIME_NAME: z.string().optional(),
  MODEL_RUNTIME_TIMEOUT_MS: z.string().optional(),
  MODEL_RUNTIME_REASONING_EFFORT: z.enum(["low", "medium", "high"]).optional(),
  MODEL_RUNTIME_MAX_OUTPUT_TOKENS: z.string().optional(),
  MODEL_STRUCTURED_OUTPUT_API_KEY: z.string().optional(),
  MODEL_STRUCTURED_OUTPUT_BASE_URL: z.string().optional(),
  MODEL_STRUCTURED_OUTPUT_NAME: z.string().optional(),
  MODEL_STRUCTURED_OUTPUT_REASONING_EFFORT: z.enum(["low", "medium", "high"]).optional(),
  MODEL_STRUCTURED_OUTPUT_MAX_OUTPUT_TOKENS: z.string().optional(),
  MODEL_EMBEDDING_API_KEY: z.string().optional(),
  MODEL_EMBEDDING_BASE_URL: z.string().optional(),
  MODEL_EMBEDDING_NAME: z.string().optional(),
  MODEL_TIMEOUT_MS: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().optional(),
  OPENAI_MODEL: z.string().optional()
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error("Invalid environment variables", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

// Validate REDIS_URL requirement based on mode
const parsedMode = process.env["STATECORE_MODE"] === "lite" ? "lite" : "full";
if (parsedMode !== "lite" && !process.env["REDIS_URL"]) {
  // eslint-disable-next-line no-console
  console.error("REDIS_URL is required in full mode. Set STATECORE_MODE=lite for zero-dependency development.");
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
const runtimeModelBaseUrl = clean(env.MODEL_RUNTIME_BASE_URL) || chatModelBaseUrl;
const structuredOutputModelBaseUrl = clean(env.MODEL_STRUCTURED_OUTPUT_BASE_URL) || modelBaseUrl;
const embeddingModelBaseUrl = clean(env.MODEL_EMBEDDING_BASE_URL) || modelBaseUrl;
const chatModelApiKey = clean(env.MODEL_CHAT_API_KEY) ?? clean(env.MODEL_API_KEY) ?? clean(env.OPENAI_API_KEY) ?? "";
const runtimeModelApiKey = clean(env.MODEL_RUNTIME_API_KEY) ?? clean(env.MODEL_CHAT_API_KEY) ?? clean(env.MODEL_API_KEY) ?? clean(env.OPENAI_API_KEY) ?? "";
const structuredOutputModelApiKey = clean(env.MODEL_STRUCTURED_OUTPUT_API_KEY) ?? clean(env.MODEL_API_KEY) ?? clean(env.OPENAI_API_KEY) ?? "";
const embeddingModelApiKey = clean(env.MODEL_EMBEDDING_API_KEY) ?? clean(env.MODEL_API_KEY) ?? clean(env.OPENAI_API_KEY) ?? "";
const chatModelName = clean(env.MODEL_CHAT_NAME) || modelName;
const runtimeModelName = clean(env.MODEL_RUNTIME_NAME) || chatModelName;
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

if (toBool(env.FEATURE_LLM) && requiresApiKeyForBaseUrl(runtimeModelBaseUrl) && !runtimeModelApiKey) {
  // eslint-disable-next-line no-console
  console.error("Invalid environment variables", { MODEL_RUNTIME_API_KEY: ["MODEL_RUNTIME_API_KEY, MODEL_CHAT_API_KEY, MODEL_API_KEY, or OPENAI_API_KEY required for runtime model configuration when FEATURE_LLM=true"] });
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

export const apiEnv = {
  port: Number(env.PORT || 3000),
  databaseUrl: env.DATABASE_URL,
  redisUrl: env.REDIS_URL ?? "",
  mode: (env.STATECORE_MODE ?? "full") as "lite" | "full",
  logLevel: env.LOG_LEVEL || "info",
  localUserToken: env.LOCAL_USER_TOKEN || "local-dev-user",
  featureLlm: toBool(env.FEATURE_LLM),
  workingMemoryEnabled: env.WORKING_MEMORY_ENABLED ? toBool(env.WORKING_MEMORY_ENABLED) : true,
  workingMemoryUseLlm: toBool(env.WORKING_MEMORY_USE_LLM),
  workingMemoryMaxRecentTurns: Number(env.WORKING_MEMORY_MAX_RECENT_TURNS || 6),
  workingMemoryMaxItemsPerField: Number(env.WORKING_MEMORY_MAX_ITEMS_PER_FIELD || 10),
  retrieveUseEmbeddings: toBool(env.RETRIEVE_USE_EMBEDDINGS),
  retrieveUseVectorSearch: toBool(env.RETRIEVE_USE_VECTOR_SEARCH),
  retrieveEmbeddingCandidateLimit: Number(env.RETRIEVE_EMBEDDING_CANDIDATE_LIMIT || 24),
  modelProvider,
  modelApiKey,
  modelBaseUrl,
  modelName,
  chatModelApiKey,
  chatModelBaseUrl,
  chatModelName,
  runtimeModelApiKey,
  runtimeModelBaseUrl,
  runtimeModelName,
  runtimeModelTimeoutMs: Number(env.MODEL_RUNTIME_TIMEOUT_MS || env.MODEL_TIMEOUT_MS || 20000),
  runtimeModelReasoningEffort: env.MODEL_RUNTIME_REASONING_EFFORT || "low",
  runtimeModelMaxOutputTokens: Number(env.MODEL_RUNTIME_MAX_OUTPUT_TOKENS || 400),
  structuredOutputModelApiKey,
  structuredOutputModelBaseUrl,
  structuredOutputModelName,
  structuredOutputModelReasoningEffort: env.MODEL_STRUCTURED_OUTPUT_REASONING_EFFORT || "low",
  structuredOutputModelMaxOutputTokens: Number(env.MODEL_STRUCTURED_OUTPUT_MAX_OUTPUT_TOKENS || 600),
  embeddingModelApiKey,
  embeddingModelBaseUrl,
  embeddingModelName,
  modelTimeoutMs: Number(env.MODEL_TIMEOUT_MS || 20000)
};
