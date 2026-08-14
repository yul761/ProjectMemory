import { fileURLToPath } from "node:url";

/**
 * Points the workspace package names at source for every Vitest run.
 *
 * `main` in each package resolves to `dist`, because a built app starts with
 * `node dist/main.js` and Node cannot load a `.ts` entry. Vite reads `main` too,
 * so without this a test suite would silently exercise whatever was built last —
 * passing against stale output, or failing to resolve at all on a clean checkout.
 *
 * TypeScript needs no equivalent: `types` still points at source and resolves
 * through the node_modules symlink, which is also why `paths` are not used here.
 * Mapping these names through `paths` puts the files under the importing
 * package's `rootDir` check and fails every build with TS6059.
 */
export const workspaceAliases: Record<string, string> = {
  "@statecore/contracts": fileURLToPath(new URL("./packages/contracts/src/index.ts", import.meta.url)),
  "@statecore/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
  "@statecore/db": fileURLToPath(new URL("./packages/db/src/index.ts", import.meta.url)),
  "@statecore/prompts": fileURLToPath(new URL("./packages/prompts/src/index.ts", import.meta.url))
};
