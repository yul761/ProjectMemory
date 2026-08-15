import { defineConfig } from "tsup";

// The generated lite Prisma client (packages/db/generated/client-lite) ships a
// native query-engine binary (libquery_engine-<platform>.dylib.node) that its
// runtime locates via a path list built partly from `__dirname` and partly from
// an absolute path baked in at `prisma generate` time. Inlining that client's JS
// collapses `__dirname` to this package's own `dist/`, where no engine binary
// exists; the generate-time absolute path then becomes the only path that still
// resolves, and only because it happens to match this workspace checkout's
// location on this machine — an npm-installed copy on another machine would
// resolve neither and fail to load the engine. Excluding this one subpath from
// `noExternal` keeps its `require(...)` unresolved at bundle time, so at runtime
// Node's normal module resolution (relative to `dist/main.js`, walking up
// `node_modules`) finds it instead — correct in this workspace (where
// `node_modules/@statecore/db` symlinks to `packages/db`) and, for the npm
// package, the reason `apps/mcp`'s published form needs a postinstall step that
// generates this client into its own `node_modules` (tracked for Task 9, not
// solved here).
export default defineConfig({
  entry: ["src/main.ts"],
  format: ["cjs"],
  platform: "node",
  target: "node20",
  // Named explicitly rather than a single `/^@statecore\//` prefix regex: a
  // negative-lookahead regex meant to except only the `.../generated/client-lite`
  // subpath from `noExternal` (leaving it to `external` below) was verified by
  // build to still inline the engine loader — esbuild/tsup's resolver ends up
  // treating a workspace symlink's deep import differently than a plain
  // string/regex match against the written specifier can select for. Listing
  // the two packages that are safe to inline by exact name, and handling
  // `@statecore/db` only through `external` below, reliably keeps the loader
  // out (verified: bundle size drops from ~720KB to ~415KB, `dist/main.js`
  // keeps a real `require("@statecore/db/generated/client-lite")` instead of
  // inlined source, and the built binary still opens a real database from a
  // cwd with no relation to this workspace).
  noExternal: ["@statecore/core", "@statecore/prompts"],
  external: [
    "@prisma/client",
    "@modelcontextprotocol/sdk",
    "zod",
    // Never called from this package (dead re-export from
    // packages/core/src/relationship-context.ts, unreachable via the embedded
    // backend); listed for completeness alongside the subpath below rather
    // than left to fall through to esbuild's inlining default.
    "@statecore/db",
    "@statecore/db/generated/client-lite"
  ],
  clean: true
});
