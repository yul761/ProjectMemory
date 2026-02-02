import { z } from "zod";
import dotenv from "dotenv";
import path from "path";

const repoRoot = path.resolve(__dirname, "../../..");
dotenv.config({ path: path.join(repoRoot, ".env"), override: true });
dotenv.config({ path: path.join(repoRoot, "apps/cli/.env"), override: true });

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
