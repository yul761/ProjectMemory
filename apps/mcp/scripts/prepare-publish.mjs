#!/usr/bin/env node
// Copies the lite Prisma schema and its bootstrap DDL from packages/db into
// this package's own tree, rewriting the schema's generator output to a
// package-local path. Runs at `npm publish` time (package.json's
// `prepublishOnly`), so the published tarball carries everything the
// `postinstall` `prisma generate` step needs on a consumer's machine, with no
// dependency on the pnpm workspace that produced it (packages/db is not a
// published dependency — see apps/mcp/src/store.ts's runtime loader).
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const dbRoot = join(pkgRoot, "../../packages/db");

const schemaSrc = join(dbRoot, "prisma/schema.lite.prisma");
const schemaDest = join(pkgRoot, "schema.lite.prisma");
const ddlSrc = join(dbRoot, "lite-bootstrap.sql");
const ddlDest = join(pkgRoot, "lite-bootstrap.sql");

const schema = readFileSync(schemaSrc, "utf8");
// packages/db/prisma/schema.lite.prisma generates into ../generated/client-lite
// (relative to packages/db/prisma), a path that only exists inside this
// workspace. The published package generates into its own tree instead —
// "./generated/client-lite" relative to the copied schema at the package
// root — which store.ts's runtime loader looks for at `dist/../generated/client-lite`.
const target = 'output   = "../generated/client-lite"';
const replacement = 'output   = "./generated/client-lite"';
if (!schema.includes(target)) {
  throw new Error(
    `${schemaSrc}: expected to find generator output line ${JSON.stringify(target)} to rewrite — schema.lite.prisma's generator block changed shape, update this script`
  );
}
writeFileSync(schemaDest, schema.replace(target, replacement));
copyFileSync(ddlSrc, ddlDest);

console.log(`prepare-publish: wrote ${schemaDest} and ${ddlDest}`);
