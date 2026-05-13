// Must run before any module imports — overrides DATABASE_URL for test DB.
// apps/api/src/env.ts skips keys already set (line 15: "if process.env[key] !== undefined, continue")
// so setting here before env.ts loads ensures the test DB URL is used.
const testUrl = process.env["DATABASE_URL_TEST"] ?? "postgresql://postgres:postgres@localhost:5434/statecore_test";
process.env["DATABASE_URL"] = testUrl;

// The .env file contains empty-string values for optional enum fields which fail zod validation.
// Pre-set them to valid values here so env.ts loadEnvFile skips them (it skips keys already set).
// This prevents zod from receiving "" for z.enum(["low","medium","high"]).optional() fields.
process.env["MODEL_RUNTIME_REASONING_EFFORT"] = process.env["MODEL_RUNTIME_REASONING_EFFORT"] || "low";
process.env["MODEL_STRUCTURED_OUTPUT_REASONING_EFFORT"] = process.env["MODEL_STRUCTURED_OUTPUT_REASONING_EFFORT"] || "low";
