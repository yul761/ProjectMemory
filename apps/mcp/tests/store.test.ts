import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../src/store";

describe("openStore", () => {
  it("creates the database, applies DDL idempotently, and enables WAL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sc-mcp-"));
    const store = await openStore(dir);
    const [{ journal_mode }] = await store.prisma.$queryRawUnsafe<any[]>("PRAGMA journal_mode;");
    expect(String(journal_mode).toLowerCase()).toBe("wal");
    // ProjectScope.userId carries a real FK to User.id (enforced: SQLite's Prisma
    // connector runs with foreign_keys=ON), so the probe row needs its parent first.
    await store.prisma.user.create({ data: { id: "local", identity: "local" } });
    await store.prisma.projectScope.create({ data: { userId: "local", name: "probe" } });
    await store.close();
    const again = await openStore(dir); // 第二次打开 = DDL 幂等 + 数据保留
    expect(await again.prisma.projectScope.count()).toBe(1);
    await again.close();
  });
});
