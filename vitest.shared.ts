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
  // The Prisma-generated lite client ships its own nested package.json with an
  // `exports` map; Vite's bare-specifier resolver trips on that when resolving the
  // deep subpath `@statecore/db/generated/client-lite` (works fine under plain Node
  // and tsc, fails only under Vite/Vitest). Aliasing the exact deep path to the
  // generated directory bypasses that walk the same way the packages above bypass
  // resolving through `main`. This entry MUST precede `@statecore/db` below: Vite's
  // alias matcher (via @rollup/plugin-alias) treats a shorter string key as a prefix
  // match too (`importee.startsWith(pattern + "/")`), so with the shorter key first,
  // `@statecore/db` would swallow this deep path before it ever gets checked.
  "@statecore/db/generated/client-lite": fileURLToPath(new URL("./packages/db/generated/client-lite", import.meta.url)),
  "@statecore/db": fileURLToPath(new URL("./packages/db/src/index.ts", import.meta.url)),
  "@statecore/prompts": fileURLToPath(new URL("./packages/prompts/src/index.ts", import.meta.url))
};
