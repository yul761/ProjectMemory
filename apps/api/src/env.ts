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
loadEnvFile(path.join(repoRoot, "apps/api/.env"));

const envSchema = z.object({
  PORT: z.string().optional(),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  LOG_LEVEL: z.string().optional(),
  LOCAL_USER_TOKEN: z.string().optional(),
  FEATURE_LLM: z.string().optional(),
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

const env = parsed.data;
const toBool = (value?: string) => value === "true";

if (toBool(env.FEATURE_LLM) && !env.OPENAI_API_KEY) {
  // eslint-disable-next-line no-console
  console.error("Invalid environment variables", { OPENAI_API_KEY: ["OPENAI_API_KEY required when FEATURE_LLM=true"] });
  process.exit(1);
}

export const apiEnv = {
  port: Number(env.PORT || 3000),
  databaseUrl: env.DATABASE_URL,
  redisUrl: env.REDIS_URL,
  logLevel: env.LOG_LEVEL || "info",
  localUserToken: env.LOCAL_USER_TOKEN || "local-dev-user",
  featureLlm: toBool(env.FEATURE_LLM),
  openaiApiKey: env.OPENAI_API_KEY || "",
  openaiBaseUrl: env.OPENAI_BASE_URL || "https://api.openai.com/v1",
  openaiModel: env.OPENAI_MODEL || "gpt-4o-mini"
};
