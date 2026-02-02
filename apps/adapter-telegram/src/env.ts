import { z } from "zod";

const booleanString = z
  .string()
  .optional()
  .transform((value) => value === "true");

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  PUBLIC_BASE_URL: z.string().optional(),
  TELEGRAM_WEBHOOK_PATH: z.string().optional(),
  API_BASE_URL: z.string().min(1),
  ADAPTER_PORT: z.string().optional(),
  FEATURE_TELEGRAM: booleanString.default("false")
}).superRefine((env, ctx) => {
  if (env.FEATURE_TELEGRAM === "true") {
    if (!env.TELEGRAM_BOT_TOKEN) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "TELEGRAM_BOT_TOKEN required when FEATURE_TELEGRAM=true" });
    }
    if (!env.PUBLIC_BASE_URL) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "PUBLIC_BASE_URL required when FEATURE_TELEGRAM=true" });
    }
  }
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error("Invalid environment variables", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const env = parsed.data;

export const adapterEnv = {
  botToken: env.TELEGRAM_BOT_TOKEN || "",
  publicBaseUrl: env.PUBLIC_BASE_URL || "",
  webhookPath: env.TELEGRAM_WEBHOOK_PATH || "/telegram/webhook",
  apiBaseUrl: env.API_BASE_URL,
  port: Number(env.ADAPTER_PORT || 3001),
  featureTelegram: env.FEATURE_TELEGRAM || false
};
