import { z } from "zod";
import dotenv from "dotenv";
import path from "path";

const repoRoot = path.resolve(__dirname, "../../..");
dotenv.config({ path: path.join(repoRoot, ".env"), override: true });
dotenv.config({ path: path.join(repoRoot, "apps/worker/.env"), override: true });

const booleanString = z
  .string()
  .optional()
  .transform((value) => value === "true");

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  FEATURE_LLM: booleanString.default("false"),
  FEATURE_TELEGRAM: booleanString.default("false"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().optional(),
  OPENAI_MODEL: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  DIGEST_MAX_RECENT_EVENTS: z.string().optional(),
  DIGEST_MAX_DAYS_LOOKBACK: z.string().optional()
}).superRefine((env, ctx) => {
  if (env.FEATURE_LLM === "true" && !env.OPENAI_API_KEY) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "OPENAI_API_KEY required when FEATURE_LLM=true" });
  }
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error("Invalid environment variables", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const env = parsed.data;

export const workerEnv = {
  databaseUrl: env.DATABASE_URL,
  redisUrl: env.REDIS_URL,
  featureLlm: env.FEATURE_LLM || false,
  featureTelegram: env.FEATURE_TELEGRAM || false,
  openaiApiKey: env.OPENAI_API_KEY || "",
  openaiBaseUrl: env.OPENAI_BASE_URL || "https://api.openai.com/v1",
  openaiModel: env.OPENAI_MODEL || "gpt-4o-mini",
  telegramBotToken: env.TELEGRAM_BOT_TOKEN || "",
  maxRecentEvents: Number(env.DIGEST_MAX_RECENT_EVENTS || 50),
  maxDaysLookback: Number(env.DIGEST_MAX_DAYS_LOOKBACK || 14)
};
