// Must run before any module imports — overrides DATABASE_URL for test DB.
// apps/api/src/env.ts skips keys already set (line 15: "if process.env[key] !== undefined, continue")
// so setting here before env.ts loads ensures the test DB URL is used.
const testUrl = process.env["DATABASE_URL_TEST"] ?? "postgresql://postgres:postgres@localhost:5433/statecore_test";
process.env["DATABASE_URL"] = testUrl;
