import { defineConfig } from "tsup";
export default defineConfig({
  entry: ["src/main.ts"],
  format: ["cjs"],
  platform: "node",
  target: "node20",
  noExternal: [/^@statecore\//],
  external: ["@prisma/client", "@modelcontextprotocol/sdk", "zod"],
  clean: true
});
