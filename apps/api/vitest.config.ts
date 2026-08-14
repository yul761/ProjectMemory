import { defineConfig } from "vitest/config";
import { workspaceAliases } from "../../vitest.shared";

export default defineConfig({
  resolve: { alias: workspaceAliases },
  test: {
    setupFiles: ["./src/test/vitest.setup.ts"],
    // Integration tests share a real Postgres DB; run files sequentially to avoid
    // clearDatabase race conditions between concurrent test-file workers.
    fileParallelism: false
  }
});
