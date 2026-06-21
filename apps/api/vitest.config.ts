import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./src/test/vitest.setup.ts"],
    // Integration tests share a real Postgres DB; run files sequentially to avoid
    // clearDatabase race conditions between concurrent test-file workers.
    fileParallelism: false
  }
});
