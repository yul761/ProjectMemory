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
  FEATURE_TELEGRAM: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().optional(),
  OPENAI_MODEL: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  DIGEST_MAX_RECENT_EVENTS: z.string().optional(),
  DIGEST_MAX_DAYS_LOOKBACK: z.string().optional(),
  DIGEST_EVENT_BUDGET_TOTAL: z.string().optional(),
  DIGEST_EVENT_BUDGET_DOCS: z.string().optional(),
  DIGEST_EVENT_BUDGET_STREAM: z.string().optional(),
  DIGEST_NOVELTY_THRESHOLD: z.string().optional(),
  DIGEST_MAX_RETRIES: z.string().optional(),
  DIGEST_USE_LLM_CLASSIFIER: z.string().optional(),
  DIGEST_DEBUG: z.string().optional(),
  DIGEST_REBUILD_CHUNK_SIZE: z.string().optional()
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error("Invalid environment variables", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const env = parsed.data;
const toBool = (value?: string) => value === "true";

if (toBool(env.FEATURE_LLM) && !env.OPENAI_API_KEY) {
  // eslint-disable-next-line no-console
  console.error("Invalid environment variables", { OPENAI_API_KEY: ["OPENAI_API_KEY required when FEATURE_LLM=true"] });
  process.exit(1);
}

export const workerEnv = {
  databaseUrl: env.DATABASE_URL,
  redisUrl: env.REDIS_URL,
  featureLlm: toBool(env.FEATURE_LLM),
  featureTelegram: toBool(env.FEATURE_TELEGRAM),
  openaiApiKey: env.OPENAI_API_KEY || "",
  openaiBaseUrl: env.OPENAI_BASE_URL || "https://api.openai.com/v1",
  openaiModel: env.OPENAI_MODEL || "gpt-4o-mini",
  telegramBotToken: env.TELEGRAM_BOT_TOKEN || "",
  maxRecentEvents: Number(env.DIGEST_MAX_RECENT_EVENTS || 50),
  maxDaysLookback: Number(env.DIGEST_MAX_DAYS_LOOKBACK || 14),
  digestEventBudgetTotal: Number(env.DIGEST_EVENT_BUDGET_TOTAL || 40),
  digestEventBudgetDocs: Number(env.DIGEST_EVENT_BUDGET_DOCS || 10),
  digestEventBudgetStream: Number(env.DIGEST_EVENT_BUDGET_STREAM || 30),
  digestNoveltyThreshold: Number(env.DIGEST_NOVELTY_THRESHOLD || 0.15),
  digestMaxRetries: Number(env.DIGEST_MAX_RETRIES || 1),
  digestUseLlmClassifier: toBool(env.DIGEST_USE_LLM_CLASSIFIER),
  digestDebug: toBool(env.DIGEST_DEBUG),
  digestRebuildChunkSize: Number(env.DIGEST_REBUILD_CHUNK_SIZE || 80)
};
