import { z } from "zod";

const envSchema = z.object({
  API_BASE_URL: z.string().min(1)
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error("Invalid environment variables", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const cliEnv = {
  apiBaseUrl: parsed.data.API_BASE_URL
};
