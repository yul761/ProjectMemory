// Deep import via the package specifier (`@statecore/db/generated/client-lite`) resolves
// fine under plain Node (require.resolve confirms it) and under tsc, but Vite's resolver
// (used by Vitest) fails to find it — the generated client ships a nested package.json
// whose own `exports` map confuses Vite's bare-specifier walk. Falling back to a relative
// import sidesteps that resolver and works identically under tsc, tsx, and Vitest.
import { PrismaClient } from "../../../packages/db/generated/client-lite";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export type LitePrisma = PrismaClient;
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
  for (const raw of ddl.split(/;\s*\n/)) {
    const stmt = raw.split("\n").filter((line: string) => !line.trim().startsWith("--")).join("\n").trim();
    if (!stmt) continue;
    await prisma.$executeRawUnsafe(stmt);
  }
  return { prisma, close: () => prisma.$disconnect() };
}
