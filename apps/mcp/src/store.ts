// A type-only import: erased entirely by tsc/esbuild, so it never becomes a
// runtime module reference tsup could try to inline (the concern the runtime
// loader below exists to avoid). Resolves fine under tsc via the workspace
// symlink (`node_modules/@statecore/db` -> `packages/db` in this checkout).
import type * as LiteClientTypes from "@statecore/db/generated/client-lite";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Loads the generated lite Prisma client at runtime rather than importing it
 * statically, because `tsup.config.ts` excludes it from inlining: its native
 * query-engine binary is located via a path baked in at `prisma generate`
 * time, so a bundled copy resolves the engine only on the machine that ran
 * `generate` (traced in Task 8's report). Two candidates, tried in order:
 * 1. The package-local copy a published install's `postinstall` generates
 *    into `<package root>/generated/client-lite` (this file's `dist/../generated/client-lite`).
 * 2. The workspace form used in this repo's dev/test tree, where
 *    `node_modules/@statecore/db` is a pnpm symlink to `packages/db` and
 *    Vitest's `workspaceAliases` (`vitest.shared.ts`) points the bare
 *    specifier at `packages/db/generated/client-lite` directly.
 * `require()` with a computed path (candidate 1) is left alone by esbuild —
 * no literal specifier to resolve — so it carries no bundling risk; the
 * literal specifier (candidate 2) is the one `tsup.config.ts`'s `external`
 * entry protects from inlining.
 */
function loadLiteClient(): typeof LiteClientTypes {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(join(__dirname, "../generated/client-lite")) as typeof LiteClientTypes;
  } catch {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("@statecore/db/generated/client-lite") as typeof LiteClientTypes;
  }
}

const { PrismaClient, Prisma } = loadLiteClient();
export { Prisma };

export type LitePrisma = InstanceType<typeof PrismaClient>;
export interface Store { prisma: LitePrisma; close(): Promise<void>; }

/** DDL 随包分发；开发态从 workspace 读。tsup 不打包 .sql，用显式查找。 */
function bootstrapSqlPath(): string {
  const candidates = [
    join(__dirname, "../lite-bootstrap.sql"),                       // 发布包内（files 里带）
    join(__dirname, "../../../packages/db/lite-bootstrap.sql")      // workspace 开发态
  ];
  const hit = candidates.find(existsSync);
  if (!hit) throw new Error("lite-bootstrap.sql not found next to the package or in the workspace");
  return hit;
}

export async function openStore(dataDir: string): Promise<Store> {
  mkdirSync(dataDir, { recursive: true });
  const url = `file:${join(dataDir, "statecore.db")}`;
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  // Both PRAGMAs return the value they set as a result row; SQLite (and Prisma's
  // $executeRawUnsafe) rejects a statement that returns rows, so both go through
  // $queryRawUnsafe even though we discard the result for busy_timeout.
  await prisma.$queryRawUnsafe("PRAGMA journal_mode=WAL;");
  await prisma.$queryRawUnsafe("PRAGMA busy_timeout=5000;");
  const ddl = readFileSync(bootstrapSqlPath(), "utf8");
  // SQLite 一次只执行一条语句；按分号+换行切分。每条语句前有独立的注释行（如
  // "-- CreateTable"），不是尾随注释，所以逐行过滤 "--" 前缀而不是按整段判断,
  // 否则每条语句都会因为以注释行开头而被整体跳过。
  //
  // This split has no string-literal or block-comment awareness: a future
  // schema-diff regeneration that introduces a `;` immediately followed by a
  // newline inside a string value or CHECK expression would mis-split silently
  // (partial statement executed, or truncated DDL). The count check below is the
  // safety net — it fails loudly instead of letting that happen quietly.
  const expectedStatementCount = (ddl.match(/^CREATE (TABLE|UNIQUE INDEX|INDEX) /gm) ?? []).length;
  let executedStatementCount = 0;
  for (const raw of ddl.split(/;\s*\n/)) {
    const stmt = raw.split("\n").filter((line: string) => !line.trim().startsWith("--")).join("\n").trim();
    if (!stmt) continue;
    await prisma.$executeRawUnsafe(stmt);
    executedStatementCount += 1;
  }
  if (executedStatementCount !== expectedStatementCount) {
    throw new Error(
      `lite-bootstrap.sql DDL split mismatch: expected ${expectedStatementCount} CREATE TABLE/INDEX statements, executed ${executedStatementCount} — the statement splitter likely mis-split on a literal ";\\n" inside a value`
    );
  }
  return { prisma, close: () => prisma.$disconnect() };
}
