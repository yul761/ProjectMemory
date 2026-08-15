#!/usr/bin/env node
// Generates the lite Prisma client into this package's own tree
// (`generated/client-lite`, resolved by apps/mcp/src/store.ts's runtime
// loader) on a published install, where `schema.lite.prisma` was copied into
// place by `prepublishOnly` (scripts/prepare-publish.mjs) before packing.
//
// In this pnpm workspace, `schema.lite.prisma` is never copied here — pnpm
// runs every workspace project's own `postinstall` on a root `pnpm install`
// (verified empirically), and this package's dev/test tree instead resolves
// the generated client from packages/db's own build via the second candidate
// in store.ts's loader. Skipping when the schema is absent keeps a plain
// `pnpm install` at the repo root working; it is not silently swallowing a
// failure, since the schema's absence here is the expected, only state this
// script ever sees in the workspace.
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const schemaPath = join(pkgRoot, "schema.lite.prisma");

if (!existsSync(schemaPath)) {
  console.log("postinstall: schema.lite.prisma absent (pnpm workspace dev tree) — skipping prisma generate");
  process.exit(0);
}

execSync("prisma generate --schema=./schema.lite.prisma", { cwd: pkgRoot, stdio: "inherit" });
