import { z } from "zod";
import dotenv from "dotenv";
import path from "path";

const repoRoot = path.resolve(__dirname, "../../..");
dotenv.config({ path: path.join(repoRoot, ".env"), override: true });
dotenv.config({ path: path.join(repoRoot, "apps/api/.env"), override: true });

const booleanString = z
  .string()
  .optional()
  .transform((value) => value === "true");

const envSchema = z.object({
  PORT: z.string().optional(),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  LOG_LEVEL: z.string().optional(),
  LOCAL_USER_TOKEN: z.string().optional(),
  FEATURE_LLM: booleanString.default("false"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().optional(),
  OPENAI_MODEL: z.string().optional()
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

export const apiEnv = {
  port: Number(env.PORT || 3000),
  databaseUrl: env.DATABASE_URL,
  redisUrl: env.REDIS_URL,
  logLevel: env.LOG_LEVEL || "info",
  localUserToken: env.LOCAL_USER_TOKEN || "local-dev-user",
  featureLlm: env.FEATURE_LLM || false,
  openaiApiKey: env.OPENAI_API_KEY || "",
  openaiBaseUrl: env.OPENAI_BASE_URL || "https://api.openai.com/v1",
  openaiModel: env.OPENAI_MODEL || "gpt-4o-mini"
};
