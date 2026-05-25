import { existsSync, readFileSync } from "fs";
import path from "path";
import { z } from "zod";

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
    if (!process.env[key]) process.env[key] = value;
  }
}

const repoRoot = path.resolve(__dirname, "../../..");
loadEnvFile(path.join(repoRoot, ".env"));

const envSchema = z.object({
  STATECORE_API_URL: z.string().default("http://localhost:3000"),
  STATECORE_TOKEN: z.string().default("local-dev-user"),
  STATECORE_USER_ID: z.string().default("mcp-user"),
  STATECORE_SCOPE_NAME: z.string().optional()
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid env", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const mcpEnv = {
  apiBaseUrl: parsed.data.STATECORE_API_URL,
  token: parsed.data.STATECORE_TOKEN,
  userId: parsed.data.STATECORE_USER_ID,
  scopeName: parsed.data.STATECORE_SCOPE_NAME
};
