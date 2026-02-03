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
loadEnvFile(path.join(repoRoot, "apps/adapter-telegram/.env"));

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  PUBLIC_BASE_URL: z.string().optional(),
  TELEGRAM_WEBHOOK_PATH: z.string().optional(),
  API_BASE_URL: z.string().min(1),
  ADAPTER_PORT: z.string().optional(),
  FEATURE_TELEGRAM: z.string().optional()
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error("Invalid environment variables", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const env = parsed.data;
const featureTelegram = env.FEATURE_TELEGRAM === "true";

if (featureTelegram) {
  const result = z.object({
    TELEGRAM_BOT_TOKEN: z.string().min(1),
    PUBLIC_BASE_URL: z.string().min(1)
  }).safeParse(env);
  if (!result.success) {
    // eslint-disable-next-line no-console
    console.error("Invalid environment variables", result.error.flatten().fieldErrors);
    process.exit(1);
  }
}

export const adapterEnv = {
  botToken: env.TELEGRAM_BOT_TOKEN || "",
  publicBaseUrl: env.PUBLIC_BASE_URL || "",
  webhookPath: env.TELEGRAM_WEBHOOK_PATH || "/telegram/webhook",
  apiBaseUrl: env.API_BASE_URL,
  port: Number(env.ADAPTER_PORT || 3001),
  featureTelegram
};
