import { defineConfig } from "vitest/config";
import { workspaceAliases } from "../../vitest.shared";

export default defineConfig({
  resolve: { alias: workspaceAliases }
});
