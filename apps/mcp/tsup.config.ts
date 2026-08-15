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
// Node's normal module resolution (relative to the loading `dist/*.js`, walking
// up `node_modules`) finds it instead — correct in this workspace (where
// `node_modules/@statecore/db` symlinks to `packages/db`) and, for the npm
// package, the reason `apps/mcp`'s published form generates this client into
// its own tree at install time (package.json `postinstall`, gated by
// scripts/postinstall.mjs's presence check on `schema.lite.prisma`) and
// `store.ts`'s runtime loader looks for it there first. `src/lib.ts` reaches
// the same `store.ts` loader through `embedded.ts`, so it needs the identical
// treatment, not just `src/main.ts`.
//
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
const noExternal = ["@statecore/core", "@statecore/prompts"];
const external = [
  "@prisma/client",
  "@modelcontextprotocol/sdk",
  "zod",
  // Never called from this package (dead re-export from
  // packages/core/src/relationship-context.ts, unreachable via the embedded
  // backend); listed for completeness alongside the subpath below rather
  // than left to fall through to esbuild's inlining default.
  "@statecore/db",
  "@statecore/db/generated/client-lite"
];

export default [
  defineConfig({
    entry: ["src/main.ts"],
    format: ["cjs"],
    platform: "node",
    target: "node20",
    // dist/main.js is the package's `bin`. npm's .bin shim execs the file
    // directly, so without a shebang the shell interprets JavaScript as shell
    // ("use strict: command not found") — shipped broken in 0.1.0, where every
    // test ran `node dist/main.js` and nothing exercised the bin path itself.
    // The `src/lib.ts` entry below must NOT get this banner: it is imported as
    // a module (`statecore-mcp/lib`), never executed, and the e2e test pins
    // `dist/main.js`'s first line as the shebang specifically.
    banner: { js: "#!/usr/bin/env node" },
    noExternal,
    external,
    clean: true
  }),
  defineConfig({
    entry: ["src/lib.ts"],
    format: ["cjs", "esm"],
    platform: "node",
    target: "node20",
    dts: true,
    noExternal,
    external,
    // Bundled dependencies (pino, transitively via @statecore/core's
    // noExternal inlining above) call Node builtins through plain
    // `require(...)`. esbuild wraps every such call in a `__require` helper
    // that falls back to the real global `require` when one is in scope, but
    // ESM has no such global — tsup's `shims` option covers `__dirname`/
    // `__filename`/`import.meta.url` but not this one, so without a `require`
    // binding in scope `dist/lib.mjs` throws "Dynamic require of ... is not
    // supported" the first time such a call runs. This banner defines one
    // via `createRequire(import.meta.url)`, which `__require`'s fallback then
    // picks up. The CJS output needs neither: `require` is already a real
    // global there.
    shims: true,
    esbuildOptions(options, context) {
      if (context.format === "esm") {
        options.banner = {
          ...options.banner,
          js: [
            options.banner?.js,
            'import { createRequire as __createRequire } from "node:module";',
            "const require = __createRequire(import.meta.url);"
          ]
            .filter(Boolean)
            .join("\n")
        };
      }
    },
    // The main-entry config above already cleans `dist/` once; a second clean
    // here would delete what it just built.
    clean: false
  })
];
