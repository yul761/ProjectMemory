# MCP Server（零部署内嵌 lite 引擎）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 发布 `statecore-mcp`——一个 `npx` 即用的 MCP server，内嵌 StateCore lite 引擎（SQLite、无 Redis、无 NestJS），暴露 remember/recall/facts/why/forget 五个工具，无 LLM key 时仍提供确定性记忆 + 完整审计链。

**Architecture:** 双模后端：默认 `EmbeddedBackend` 进程内直调 `@statecore/core`（repo 注入模式，lite Prisma client + SQLite），`--url` 时切 `HttpBackend`（`/v1` 薄客户端）。digest 由阈值 + 启动追赶触发，跨进程用库内锁表串行。npm 发布用 tsup 把未发布的 workspace 包打进单文件，Prisma schema 随包 + 启动时幂等 DDL 建表。

**Tech Stack:** TypeScript（CommonJS，同仓惯例）、`@modelcontextprotocol/sdk`（stdio）、Prisma 6.2 SQLite（Json 列已支持）、zod、tsup、vitest。

**Spec:** `docs/superpowers/specs/2026-08-14-mcp-server-design.md`

## Global Constraints

- 包名首选 `statecore-mcp`（无 scope），被占则 `@statecore/mcp`；bin 名恒为 `statecore-mcp`。
- 本仓模块解析规则（root CLAUDE.md「Module resolution」节）必须遵守：新包 `main` 指 `dist`，vitest 配置 import `vitest.shared.ts` 的 `workspaceAliases`，tsx 脚本带 `--tsconfig ../../tsconfig.dev.json`。
- 所有提交前跑 `pnpm format:check`（CRLF/行尾门禁）与 `pnpm lint`。
- 不改 `/v1` 契约、不改 `packages/core` 既有行为（Task 2 的纯函数搬家除外——行为不变、api 快照不变）。
- 环境变量前缀：MCP 自有配置用 `STATECORE_*`；模型配置沿用引擎的 `MODEL_*` 全套语义（见 `apps/worker/src/env.ts`）。
- digest 路径不发送 `reasoning_effort`（除非用户显式设 `MODEL_STRUCTURED_OUTPUT_REASONING_EFFORT`），保证 DeepSeek/任意 openai-compatible key 可用。

---

### Task 1: lite schema 同步 + 启动 DDL

lite schema 是搁置期产物，缺 `ForgottenFact` 表和 `selectionLog`/`pinned`/`ingestedAt`/`suppressedAt`/`facetPack` 列。先把它同步到与 `schema.prisma` 等价（去掉 pgvector 的 `MemoryEventEmbedding` 与 `DigestJobLog`），再产出 npx 场景用的幂等建表 SQL。

**Files:**
- Modify: `packages/db/prisma/schema.lite.prisma`
- Create: `packages/db/lite-bootstrap.sql`
- Test: 手工验证命令（本任务是 schema/工具链任务，测试即命令产出）

- [ ] **Step 1: 同步 schema.lite.prisma**

逐模型对照 `packages/db/prisma/schema.prisma` 更新 `schema.lite.prisma`：
- `User` 补 `facetPack Json?`
- `MemoryEvent` 补 `pinned Boolean @default(false)`、`ingestedAt DateTime @default(now())`、`suppressedAt DateTime?`，以及 full schema 中对应的 `@@index`
- `Digest` 补 `selectionLog Json?`
- 新增 `ForgottenFact` 模型（从 full schema 整体复制，含 `@@unique([scopeId, factKey])`）
- 不加 `MemoryEventEmbedding`、`DigestJobLog`
- 保留 lite 既有的 `generator` 输出路径 `../generated/client-lite` 与 `sqlite` datasource

- [ ] **Step 2: 验证 generate 与 push**

```bash
cd packages/db
pnpm generate:lite
DATABASE_URL="file:/tmp/statecore-lite-probe.db" pnpm push:lite
```
Expected: 两条命令零报错；`sqlite3 /tmp/statecore-lite-probe.db ".tables"` 列出 8 张表（含 `ForgottenFact`）。

- [ ] **Step 3: 导出幂等 DDL**

```bash
cd packages/db
pnpm exec prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.lite.prisma --script > lite-bootstrap.sql
```
手工把每条 `CREATE TABLE` / `CREATE INDEX` / `CREATE UNIQUE INDEX` 改为 `IF NOT EXISTS` 形式（SQLite 支持）。文件顶部加注释：`-- Generated from schema.lite.prisma via prisma migrate diff; regenerate when the lite schema changes.`

- [ ] **Step 4: 冒烟 DDL 幂等性**

```bash
sqlite3 /tmp/statecore-ddl-probe.db < packages/db/lite-bootstrap.sql
sqlite3 /tmp/statecore-ddl-probe.db < packages/db/lite-bootstrap.sql   # 第二次必须零报错
```

- [ ] **Step 5: Commit**

```bash
git add packages/db/prisma/schema.lite.prisma packages/db/lite-bootstrap.sql
git commit -m "feat(db): sync the lite schema with current models, add idempotent bootstrap DDL"
```

---

### Task 2: 把 provenance 纯函数搬进 core

`buildFactProvenance` 与 `normalizeSelectionLog` 是纯 `DigestState` 函数，现在住在 `apps/api/src/memory.controller.ts`——MCP 要用它们，跨 app import 不可取；它们本来就该在 core。**行为零变化**。

**Files:**
- Create: `packages/core/src/provenance.ts`
- Modify: `packages/core/src/index.ts`（barrel 加 `export * from "./provenance";`）
- Modify: `apps/api/src/memory.controller.ts`（删本地定义，改从 `@statecore/core` import；文件内两个使用点不变）
- Modify: `apps/api/src/memory.controller.provenance.spec.ts`（import 路径改为 `@statecore/core`）

**Interfaces:**
- Produces: `buildFactProvenance(state: DigestState, factId: string): { fact: FactRegistryEntry; chain: FactRegistryEntry[] } | null`；`normalizeSelectionLog(raw: unknown): { rationale: string[]; drops: unknown[] }`（签名与现有完全一致）

- [ ] **Step 1: 移动代码**

把 `apps/api/src/memory.controller.ts` 中 `buildFactProvenance`（含其 JSDoc）与 `normalizeSelectionLog`（含 JSDoc）两个函数整体剪切到新文件 `packages/core/src/provenance.ts`，文件头 import：

```ts
import type { DigestState, FactRegistryEntry } from "./digest-control";
```

barrel（`packages/core/src/index.ts`）追加 `export * from "./provenance";`。api 侧删除两函数定义，在既有 `@statecore/core` import 里追加这两个名字。

- [ ] **Step 2: 跑受影响测试**

```bash
pnpm --filter @statecore/api test -- --run provenance
pnpm --filter @statecore/core test
pnpm lint
```
Expected: 全绿；api 快照零变化（`git diff apps/api/src/__snapshots__` 为空）。

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/provenance.ts packages/core/src/index.ts apps/api/src/memory.controller.ts apps/api/src/memory.controller.provenance.spec.ts
git commit -m "refactor(core): move the provenance walkers into core, unchanged"
```

---

### Task 3: apps/mcp 脚手架 + lite 存储层

**Files:**
- Create: `apps/mcp/package.json`、`apps/mcp/tsconfig.json`、`apps/mcp/vitest.config.ts`、`apps/mcp/tsup.config.ts`
- Create: `apps/mcp/src/store.ts`（lite client 工厂 + 启动 DDL + PRAGMA）
- Create: `apps/mcp/src/scope.ts`（scope 解析）
- Test: `apps/mcp/tests/store.test.ts`、`apps/mcp/tests/scope.test.ts`

**Interfaces:**
- Produces: `openStore(dataDir: string): Promise<Store>` 其中 `Store = { prisma: LitePrisma; close(): Promise<void> }`；`resolveScopeName(cwd: string, env: NodeJS.ProcessEnv): string`

- [ ] **Step 1: package.json / tsconfig / vitest / tsup**

`apps/mcp/package.json`：
```json
{
  "name": "statecore-mcp",
  "version": "0.1.0",
  "description": "Zero-deploy MCP memory server backed by the StateCore engine — auditable facts with evidence chains",
  "license": "MIT",
  "main": "dist/main.js",
  "bin": { "statecore-mcp": "dist/main.js" },
  "files": ["dist", "schema.lite.prisma", "lite-bootstrap.sql", "README.md"],
  "scripts": {
    "dev": "tsx --tsconfig ../../tsconfig.dev.json src/main.ts",
    "build": "tsc -p tsconfig.json",
    "bundle": "tsup",
    "test": "vitest run"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "@prisma/client": "^6.2.1",
    "zod": "^3.24.1"
  },
  "devDependencies": {
    "@statecore/core": "workspace:*",
    "@statecore/db": "workspace:*",
    "@statecore/prompts": "workspace:*",
    "prisma": "^6.2.1",
    "tsup": "^8.3.5",
    "tsx": "^4.19.2",
    "typescript": "^5.7.3",
    "vitest": "^2.1.9"
  }
}
```
（workspace 包放 devDependencies 是刻意的：发布物由 tsup 内联它们，安装者不需要解析它们。）

`tsconfig.json` 抄 `apps/worker/tsconfig.json`。`vitest.config.ts` 抄 `apps/worker/vitest.config.ts`（import `workspaceAliases`）。`tsup.config.ts`：
```ts
import { defineConfig } from "tsup";
export default defineConfig({
  entry: ["src/main.ts"],
  format: ["cjs"],
  platform: "node",
  target: "node20",
  noExternal: [/^@statecore\//],
  external: ["@prisma/client", "@modelcontextprotocol/sdk", "zod"],
  clean: true
});
```

`pnpm-workspace.yaml` 已用 `apps/*` 通配则无需改；否则把 `apps/mcp` 加入。跑 `pnpm install`。

- [ ] **Step 2: 写 store 的失败测试**

`apps/mcp/tests/store.test.ts`：
```ts
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
    await store.prisma.projectScope.create({ data: { userId: "local", name: "probe" } });
    await store.close();
    const again = await openStore(dir); // 第二次打开 = DDL 幂等 + 数据保留
    expect(await again.prisma.projectScope.count()).toBe(1);
    await again.close();
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --filter statecore-mcp test`  Expected: FAIL（`openStore` 不存在）。

- [ ] **Step 4: 实现 store.ts 与 scope.ts**

`apps/mcp/src/store.ts`：
```ts
import { PrismaClient } from "@statecore/db/generated/client-lite";
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
  await prisma.$queryRawUnsafe("PRAGMA journal_mode=WAL;");
  await prisma.$executeRawUnsafe("PRAGMA busy_timeout=5000;");
  const ddl = readFileSync(bootstrapSqlPath(), "utf8");
  // SQLite 一次只执行一条语句；按分号+换行切分,跳过空白与注释行。
  for (const stmt of ddl.split(/;\s*\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith("--"))) {
    await prisma.$executeRawUnsafe(stmt);
  }
  return { prisma, close: () => prisma.$disconnect() };
}
```

`apps/mcp/src/scope.ts`：
```ts
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

/** scope 名 = 归一化项目根路径。STATECORE_SCOPE 覆盖；git 根优先，取不到用 cwd。 */
export function resolveScopeName(cwd: string, env: NodeJS.ProcessEnv): string {
  if (env.STATECORE_SCOPE?.trim()) return env.STATECORE_SCOPE.trim();
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, stdio: ["ignore", "pipe", "ignore"] })
      .toString().trim();
    if (root) return resolve(root);
  } catch { /* 非 git 目录：git 不存在或 rev-parse 失败都落到 cwd,行为一致 */ }
  return resolve(cwd);
}
```

`apps/mcp/tests/scope.test.ts`：
```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { resolveScopeName } from "../src/scope";

describe("resolveScopeName", () => {
  it("prefers STATECORE_SCOPE", () => {
    expect(resolveScopeName("/anywhere", { STATECORE_SCOPE: "my-scope" } as any)).toBe("my-scope");
  });
  it("uses the git toplevel from a subdirectory", () => {
    const repo = mkdtempSync(join(tmpdir(), "sc-git-"));
    execFileSync("git", ["init", "-q"], { cwd: repo });
    const sub = join(repo, "a/b");
    execFileSync("mkdir", ["-p", sub]);
    expect(resolveScopeName(sub, {} as any)).toBe(resolve(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: repo }).toString().trim()));
  });
  it("falls back to cwd outside git", () => {
    const dir = mkdtempSync(join(tmpdir(), "sc-plain-"));
    expect(resolveScopeName(dir, {} as any)).toBe(resolve(dir));
  });
});
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter statecore-mcp test`  Expected: PASS（store 2 用例、scope 3 用例）。
再跑 `pnpm lint && pnpm format:check`。

- [ ] **Step 6: Commit**

```bash
git add apps/mcp pnpm-lock.yaml pnpm-workspace.yaml
git commit -m "feat(mcp): scaffold statecore-mcp with lite store and scope resolution"
```

---

### Task 4: EmbeddedBackend — 五个动作的存储实现

后端接口是双模的枢纽。事实/遗忘/笔记逻辑是 `apps/api/src/memory-facts.service.ts` 的去 Nest 复刻（来源注释指回原文件）；repo 闭包按 `apps/api/src/domain.service.ts:63-160` 的模式取子集。

**Files:**
- Create: `apps/mcp/src/backend.ts`（接口）
- Create: `apps/mcp/src/embedded.ts`
- Test: `apps/mcp/tests/embedded.test.ts`

**Interfaces:**
- Produces（Task 6/7 依赖，逐字使用）:
```ts
export interface MemoryBackend {
  remember(input: { text: string; consolidate?: boolean }): Promise<{ ok: true; mode: "note" | "event" }>;
  recall(input: { query?: string; maxChars?: number }): Promise<unknown>;   // 引擎 retrieve 结果原样透传
  facts(): Promise<unknown>;                                               // 分组事实（含 factKey/factId）
  why(input: { factId: string }): Promise<unknown>;                        // provenance 或 null
  forget(input: { factKey: string }): Promise<{ ok: true }>;
  init(): Promise<void>;                                                   // scope 确保存在 + 启动追赶入口
  close(): Promise<void>;
}
export function createEmbeddedBackend(opts: { dataDir: string; scopeName: string; env: NodeJS.ProcessEnv }): MemoryBackend;
```

- [ ] **Step 1: 写失败测试（无 key 全链）**

`apps/mcp/tests/embedded.test.ts` —— 这是 spec「无 key 卖点」的可执行形式：
```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEmbeddedBackend } from "../src/embedded";

describe("embedded backend, keyless", () => {
  const dir = mkdtempSync(join(tmpdir(), "sc-emb-"));
  const be = createEmbeddedBackend({ dataDir: dir, scopeName: "/tmp/fake-project", env: {} as any });
  beforeAll(() => be.init());
  afterAll(() => be.close());

  it("remember(note) → facts → why yields an evidence chain without any LLM", async () => {
    await be.remember({ text: "We use pnpm, not npm" });
    const groups: any = await be.facts();
    const all = groups.flatMap((g: any) => g.items);
    expect(all.some((f: any) => f.text.includes("pnpm"))).toBe(true);
    const factId = all.find((f: any) => f.text.includes("pnpm")).factId;
    const prov: any = await be.why({ factId });
    expect(prov.fact.content).toContain("pnpm");
    expect(prov.fact.evidenceId).toBeTruthy();
    expect(prov.chain.length).toBeGreaterThanOrEqual(1);
  });

  it("forget removes the fact from facts() but retires rather than deletes", async () => {
    await be.remember({ text: "Temporary secret preference" });
    const before: any = await be.facts();
    const target = before.flatMap((g: any) => g.items).find((f: any) => f.text.includes("Temporary"));
    await be.forget({ factKey: target.factKey });
    const after: any = await be.facts();
    expect(after.flatMap((g: any) => g.items).some((f: any) => f.factKey === target.factKey)).toBe(false);
  });

  it("recall respects a maxChars budget and reports it", async () => {
    const out: any = await be.recall({ query: "pnpm", maxChars: 500 });
    expect(out.budget?.maxChars).toBe(500);
  });

  it("remember(consolidate) stores a stream event and never throws keyless", async () => {
    const res = await be.remember({ text: "long conversational turn …", consolidate: true });
    expect(res.mode).toBe("event");
  });
});
```

- [ ] **Step 2: 确认失败**

Run: `pnpm --filter statecore-mcp test -- --run embedded`  Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

`apps/mcp/src/backend.ts` 放上面的接口定义。`apps/mcp/src/embedded.ts` 要点（完整实现）：

```ts
import { randomUUID } from "node:crypto";
import {
  MemoryService, RetrieveService, ProjectService,
  flattenScopeFacts, groupFactsForDisplay, addNoteFact, resolveFacetPackForScope,
  buildFactProvenance, type DigestState
} from "@statecore/core";
import { openStore, type Store } from "./store";
import type { MemoryBackend } from "./backend";
import { maybeRunDigest } from "./digest";

const USER = "local";

export function createEmbeddedBackend(opts: { dataDir: string; scopeName: string; env: NodeJS.ProcessEnv }): MemoryBackend {
  let store: Store; let scopeId: string;

  // repo 闭包：抄 apps/api/src/domain.service.ts 的对应片段（projectsRepo/userStateRepo/
  // memoryRepo/digestRepo 全量字段），prisma 换成 store.prisma。此处不再重复 90 行,
  // 实现者以该文件 63-160 行为唯一蓝本,不得省字段。
  const repos = () => makeRepos(store.prisma);

  async function latestState(): Promise<{ id: string; state: DigestState } | null> {
    const snap = await store.prisma.digestStateSnapshot.findFirst({ where: { scopeId }, orderBy: { createdAt: "desc" } });
    return snap ? { id: snap.id, state: snap.state as unknown as DigestState } : null;
  }
  const packFor = () => resolveFacetPackForScope(
    { findFacetPack: async (id) => (await store.prisma.user.findUnique({ where: { id }, select: { facetPack: true } }))?.facetPack ?? null },
    USER, "project");

  return {
    async init() {
      store = await openStore(opts.dataDir);
      await store.prisma.user.upsert({ where: { identity: USER }, update: {}, create: { id: USER, identity: USER } });
      const existing = await store.prisma.projectScope.findFirst({ where: { userId: USER, name: opts.scopeName } });
      scopeId = existing?.id ?? (await new ProjectService(...Object.values(makeProjectRepos(store.prisma)) as any)
        .createScope(USER, opts.scopeName, null, undefined, "project")).id;
      void maybeRunDigest({ prisma: store.prisma, userId: USER, scopeId, env: opts.env, reason: "startup" });
    },

    async remember({ text, consolidate }) {
      if (!consolidate) {
        // 复刻 apps/api/src/memory-facts.service.ts#addNote（去 Nest）:有快照则原地
        // addNoteFact+update,无快照则事务内建 "Notes" digest+快照。评论指回原文件。
        const snap = await latestState();
        const pack = await packFor();
        if (snap) {
          if (addNoteFact(snap.state, text, () => randomUUID(), () => new Date().toISOString(), pack))
            await store.prisma.digestStateSnapshot.update({ where: { id: snap.id }, data: { state: snap.state as any } });
        } else {
          const state: DigestState = { stableFacts: { decisions: [] }, workingNotes: {}, todos: [], factRegistry: [], profile: {} };
          addNoteFact(state, text, () => randomUUID(), () => new Date().toISOString(), pack);
          await store.prisma.$transaction(async (tx) => {
            const digest = await tx.digest.create({ data: { scopeId, summary: "Notes", changes: "", nextSteps: [] } });
            await tx.digestStateSnapshot.create({ data: { scopeId, digestId: digest.id, state: state as any, consistency: null } });
          });
        }
        return { ok: true, mode: "note" };
      }
      await new MemoryService(makeMemoryRepo(store.prisma)).ingestEvent({ userId: USER, scopeId, type: "stream", source: "api", content: text });
      void maybeRunDigest({ prisma: store.prisma, userId: USER, scopeId, env: opts.env, reason: "threshold" });
      return { ok: true, mode: "event" };
    },

    async recall({ query, maxChars }) {
      const retrieve = new RetrieveService(makeDigestRepo(store.prisma), makeMemoryRepo(store.prisma), {});
      return retrieve.retrieve({ userId: USER, scopeId, query, limit: 20, maxChars });
    },

    async facts() {
      // 复刻 memory-facts.service.ts#getFacts:最新快照 + forgottenFact 过滤 + pack 分组。
      // 分组条目需带 factId(flattenScopeFacts 的 DisplayFact 已含),供 why 使用。
      /* …与原文件同構,prisma=store.prisma… */
    },

    async why({ factId }) {
      const snap = await latestState();
      return snap ? buildFactProvenance(snap.state, factId) : null;
    },

    async forget({ factKey }) {
      // 复刻 memory-facts.service.ts#forgetFact:flatten 找 match → forgottenFact.upsert
      // → 证据事件 suppressedAt(updateMany 防 P2025)。同構复刻。
      /* … */
      return { ok: true };
    },

    close: () => store.close()
  };
}
```

实现要求：`makeRepos`/`makeMemoryRepo`/`makeDigestRepo`/`makeProjectRepos` 是 `domain.service.ts` 对应闭包的逐字段复刻（不含 reminders）；`facts`/`forget` 是 `memory-facts.service.ts` 的逐行为复刻；每处复刻顶部注释 `// Mirrors apps/api/src/<file>#<member>; keep in sync.`。`RetrieveService` 第三个参数传 `{}`（无 embedding 配置 → 引擎自动走 heuristic + CJK bigram）。若 `RetrieveService.retrieve` 的实际签名与上述不符，以 `packages/core/src/index.ts:306` 起的真实签名为准调整调用（接口层不变）。

- [ ] **Step 4: 确认通过**

Run: `pnpm --filter statecore-mcp test -- --run embedded`  Expected: 4 用例 PASS。
注：Step 3 里 `maybeRunDigest` 尚为桩——先创建 `apps/mcp/src/digest.ts` 导出
`export async function maybeRunDigest(_: { prisma: any; userId: string; scopeId: string; env: NodeJS.ProcessEnv; reason: "startup" | "threshold" }): Promise<void> {}`
空实现（keyless 测试不触发 digest 语义），Task 5 替换为真实现。

- [ ] **Step 5: Commit**

```bash
git add apps/mcp/src apps/mcp/tests
git commit -m "feat(mcp): embedded backend — keyless note/facts/why/forget over the lite store"
```

---

### Task 5: digest 触发器（阈值 + 启动追赶 + 锁表）

**Files:**
- Modify: `apps/mcp/src/digest.ts`（替换桩）
- Create: `apps/mcp/src/digest-lock.ts`
- Test: `apps/mcp/tests/digest-trigger.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `maybeRunDigest` 调用形（签名不变）
- Produces: 无新对外接口；`STATECORE_DIGEST_THRESHOLD`（默认 `20`）生效

- [ ] **Step 1: 失败测试（触发判定与锁，不真调 LLM）**

```ts
import { describe, it, expect } from "vitest";
import { shouldDigest, acquireDigestLock, releaseDigestLock } from "../src/digest";
// shouldDigest(pendingCount, threshold) 纯函数；锁基于表 DigestLock(scopeId TEXT PRIMARY KEY, acquiredAt DATETIME)
describe("digest trigger", () => {
  it("fires only at/over threshold", () => {
    expect(shouldDigest(19, 20)).toBe(false);
    expect(shouldDigest(20, 20)).toBe(true);
  });
  it("second lock acquisition on the same scope fails until released", async () => {
    /* openStore 临时库；acquire → 再 acquire=false → release → acquire=true */
  });
});
```
（锁测试补全为可执行代码：用 Task 3 的 `openStore`，断言三步布尔值。）

- [ ] **Step 2: 确认失败** — `pnpm --filter statecore-mcp test -- --run digest-trigger` → FAIL。

- [ ] **Step 3: 实现**

`digest-lock.ts`：`DigestLock` 表加入 `packages/db/lite-bootstrap.sql`（手写一条 `CREATE TABLE IF NOT EXISTS "DigestLock"("scopeId" TEXT PRIMARY KEY, "acquiredAt" DATETIME NOT NULL)`；lite schema **不**加模型——这是 MCP 私有表，不进引擎数据模型）。`acquire` = `INSERT OR IGNORE` 后检查改动行数，附 30 分钟过期回收（`DELETE WHERE acquiredAt < datetime('now','-30 minutes')` 先行）；`release` = `DELETE`。

`digest.ts` 真实现：
1. `shouldDigest` 纯函数导出。
2. `maybeRunDigest`：`FEATURE_LLM !== "true"` 或缺 key → 直接 return（优雅降级）。`reason==="threshold"` 时统计 `memoryEvent.count({ where: { scopeId, type: "stream", suppressedAt: null, createdAt: { gt: lastDigest?.createdAt ?? new Date(0) } } })`，不足阈值 return；`reason==="startup"` 时同样统计但阈值取 `1`（有欠账即追）。
3. 拿锁失败 return（幂等追赶，跳过无害）；拿到后进程内单飞（模块级 `let running = false` 双保险），`try/finally` 释放。
4. 编排体复刻 `apps/worker/src/main.ts#runDigestScopeJob`（去 telegram/working-memory/BullMQ）：`resolveFacetPackForScope` → lookback 查询（复制 `apps/worker/src/digest-lookback.ts` 的 `selectDigestEventWindow` 至 `apps/mcp/src/digest-lookback.ts`，来源注释）→ forgotten keys/contents → `runDigestControlPipeline`（prompts 从 `@statecore/prompts` 同名导入，config 各值沿用 `apps/worker/src/env.ts` 的默认常量，逐项写死并注明来源）→ 复制 `apps/worker/src/digest-write.ts#createDigestWithSnapshot` 至 `apps/mcp/src/digest-write.ts` 落库。model provider 用 `createModelProvider`（core 导出），env 读取沿 worker 语义。
5. 全程 `try/catch`：失败仅 `console.error`（stdio 的 stderr 不污染 MCP 协议流），事件留库等下次追赶。

- [ ] **Step 4: 确认通过** — 触发器测试 PASS；`pnpm --filter statecore-mcp test` 全绿（embedded 测试仍 keyless 通过——`maybeRunDigest` 在无 key 下是 no-op）。

- [ ] **Step 5: Commit**

```bash
git add apps/mcp/src apps/mcp/tests packages/db/lite-bootstrap.sql
git commit -m "feat(mcp): threshold + startup-catchup digest with a lock table, keyless no-op"
```

---

### Task 6: MCP 协议层 — 五个工具 + stdio

**Files:**
- Create: `apps/mcp/src/main.ts`（入口：参数解析、后端选择、server 装配）
- Create: `apps/mcp/src/tools.ts`（工具注册，纯函数便于测试）
- Test: `apps/mcp/tests/tools.test.ts`

**Interfaces:**
- Consumes: `MemoryBackend`（Task 4 签名）
- Produces: CLI 行为 —— `statecore-mcp [--data <dir>] [--url <base>]`；env `STATECORE_SCOPE`、`STATECORE_DIGEST_THRESHOLD`、`MODEL_*`、`FEATURE_LLM`

- [ ] **Step 1: 失败测试**

用 SDK 的 `InMemoryTransport` 对（`@modelcontextprotocol/sdk` 提供 linked pair），client 连 server，断言：`tools/list` 返回恰好 `remember/recall/facts/why/forget` 五个；`remember`→`facts`→`why` 走通（后端用 Task 4 embedded + 临时目录）。

- [ ] **Step 2: 确认失败**，Run 同前。

- [ ] **Step 3: 实现**

`tools.ts`（描述文案是产品面,逐字入库）：
```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MemoryBackend } from "./backend";

export function registerTools(server: McpServer, backend: MemoryBackend): void {
  server.tool("remember",
    "Store a durable fact about this project or user. Use for preferences, decisions, constraints, and anything worth knowing next session. Deterministic and audit-tracked; set consolidate=true only for long conversational context that should be distilled in the background.",
    { text: z.string().min(1).max(2000), consolidate: z.boolean().optional() },
    async (args) => json(await backend.remember(args)));
  server.tool("recall",
    "Retrieve project memory relevant to a query, packed into a character budget. Returns the distilled digest, believed facts, recent events, and a budget report of what was left out. Call at the start of a session or before relying on past context.",
    { query: z.string().optional(), maxChars: z.number().int().positive().max(32000).optional() },
    async (args) => json(await backend.recall({ query: args.query, maxChars: args.maxChars ?? 4000 })));
  server.tool("facts",
    "List everything currently believed about this project, grouped, with fact ids. Use to review or audit the memory.",
    {}, async () => json(await backend.facts()));
  server.tool("why",
    "Explain why a fact is believed: its source evidence and the full version chain, including superseded and retired versions. Pass a factId from facts or recall.",
    { factId: z.string().min(1) },
    async (args) => json(await backend.why(args)));
  server.tool("forget",
    "Suppress a fact by factKey. The record is retired, not deleted — the audit chain is preserved.",
    { factKey: z.string().min(1) },
    async (args) => json(await backend.forget(args)));
}
const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });
```
（若安装的 SDK 主版本 API 为 `registerTool`/`server.addTool` 形态，按其 README 等价迁移，工具名与描述文案不变。）

`main.ts`：解析 `--data`（默认 `~/.statecore`）与 `--url`；`--url` 时用 Task 7 的 `createHttpBackend`，否则 embedded（scope 由 `resolveScopeName(process.cwd(), process.env)`）；`backend.init()` → `new McpServer({ name: "statecore", version: pkg.version })` → `registerTools` → `StdioServerTransport` connect。所有诊断输出走 `console.error`。

- [ ] **Step 4: 确认通过** + `pnpm lint && pnpm format:check`。

- [ ] **Step 5: Commit** — `git commit -m "feat(mcp): five-verb MCP surface over stdio"`。

---

### Task 7: HttpBackend（--url 模式）

**Files:**
- Create: `apps/mcp/src/http-backend.ts`
- Test: `apps/mcp/tests/http-backend.test.ts`

**Interfaces:**
- Consumes: `MemoryBackend`
- Produces: `createHttpBackend(opts: { baseUrl: string; userId: string; scopeName: string }): MemoryBackend`

- [ ] **Step 1: 失败测试** — 用 `node:http` 起桩 server 录请求，断言五个方法命中的路径/方法/头：`POST /v1/scopes`（init 时按名查建，`GET /v1/scopes` 先查）、`POST /v1/memory/notes` 与 `POST /v1/memory/events`（remember 两模式）、`POST /v1/memory/retrieve`（带 `maxChars`）、`GET /v1/memory/facts?scopeId=`、`GET /v1/memory/facts/:id/provenance?scopeId=`、`POST /v1/memory/facts/forget`；全部带 `x-user-id`。

- [ ] **Step 2: 确认失败。**

- [ ] **Step 3: 实现** — 全部走冻结 `/v1` 面（`fetch`，无第三方 HTTP 依赖）；非 2xx 抛带状态码与 body 前 200 字符的错误。`init` 幂等：list 后按 `name===scopeName` 匹配，无则 create（`template: "project"`）。digest 触发交给远端栈的 worker，本地不触发（注释说明）。

- [ ] **Step 4: 确认通过。**

- [ ] **Step 5: Commit** — `git commit -m "feat(mcp): --url mode speaks the frozen /v1 surface"`。

---

### Task 8: 端到端冒烟（子进程 + 双宿主配置产物）

**Files:**
- Create: `apps/mcp/tests/e2e.test.ts`
- Create: `apps/mcp/README.md`（含 dsh / Claude Code / Cursor 三段配置）

- [ ] **Step 1: e2e 测试** — `tsup` 产出 `dist` 后，用 SDK `Client` + `StdioClientTransport` spawn `node apps/mcp/dist/main.js --data <tmpdir>`（env 带 `STATECORE_SCOPE=e2e-scope`、无任何 key），执行：list tools（5 个）→ `remember` → `facts`（找回、取 factId）→ `why`（`evidenceId` 非空、chain≥1）→ `forget` → `facts` 不再含。测试内先 `execSync("pnpm --filter statecore-mcp bundle")`（或在 CI 前置步骤构建，测试检测 dist 缺失时 skip 并打印指引——选一种并注释理由）。

- [ ] **Step 2: 确认通过**（这是发布把关测试，必须真跑）。

- [ ] **Step 3: README** —— 首屏：一句定位（auditable memory for coding agents）、30 秒 keyless 演示命令块、三宿主配置：dsh overlay（`config.env` 里显式给 `MODEL_API_KEY` 并注释「dsh 会剥离环境凭证,必须写在这里」）、Claude Code `claude mcp add statecore -- npx -y statecore-mcp`、Cursor `mcpServers` JSON。降级矩阵表（无 key 有什么、有 key 多什么）。链接主仓与 spec。

- [ ] **Step 4: Commit** — `git commit -m "test(mcp): end-to-end keyless smoke over the built binary; host setup docs"`。

---

### Task 9: 发布准备

**Files:**
- Modify: `apps/mcp/package.json`（确认 `files`/`bin`/`prepublishOnly: "tsup"`）
- Modify: `CHANGELOG.md`（Unreleased 段新增条目）
- Modify: `README.md`（主仓：Features 加一行 + 新「Use it from your coding agent (MCP)」小节链接 `apps/mcp/README.md`）
- Create: `apps/mcp/schema.lite.prisma`（构建时从 packages/db 复制——在 `prepublishOnly` 里 `cp ../../packages/db/prisma/schema.lite.prisma . && cp ../../packages/db/lite-bootstrap.sql .`）

- [ ] **Step 1: 占名检查** — `npm view statecore-mcp` 期待 404（未占）。被占则改用 `@statecore/mcp` 并回填 Task 3 的 name（bin 名不变），在 npm 建 org。
- [ ] **Step 2: 本地安装演练** — `pnpm --filter statecore-mcp bundle && npm pack apps/mcp`，在**仓库外**空目录 `npm install <tarball>` 后 `npx statecore-mcp --data /tmp/sc-pack-probe` 配合 SDK 最小 client 走通 remember→facts（脚本临时,不入库）。此步验证 tsup 内联与 DDL 随包两个假设——失败即回改 Task 3/5。
- [ ] **Step 3: 主仓 README + CHANGELOG** — 措辞按 spec 降级矩阵；CHANGELOG Unreleased「Added: statecore-mcp — zero-deploy MCP server…」。
- [ ] **Step 4: 全量门禁** — `pnpm lint && pnpm format:check && pnpm --filter statecore-mcp test && pnpm --filter @statecore/api test`（api 全绿证明 Task 2 搬家无回归；docs-claims 守卫会顺带查 README 改动）。
- [ ] **Step 5: Commit** — `git commit -m "chore(mcp): publish readiness — pack probe, README, changelog"`。
- [ ] **Step 6（人工闸）: 发布与外联** — `npm publish`（首个公开包，`--access public`）打 tag；随后 dsh overlay PR（`examples/mcp-memory/statecore.cordis.yml`，钉发布版本+SHA，纯自托管）、awesome-mcp-servers PR、MCP registry。**此步须用户明确批准后执行，PR 文案先给用户过目。**

---

## Self-Review 记录

- Spec 覆盖：五工具 ✅（T6）；无 key 降级 ✅（T4 测试即卖点）；scope 映射 ✅（T3）；锁表/并发 ✅（T5）；阈值+追赶 ✅（T5）；--url 双模 ✅（T7）；npm 单包可安装 ✅（T9 pack 演练）；dsh overlay ✅（T9 人工闸）；推广清单中「作者亲自出面」项不进计划（非代码）。
- 探针清单归宿：lite 复活=T1；note 无 LLM=T4 测试；core 直调=T4/T5；SQLite 并发=T3 WAL + T5 锁测试；npm 占名=T9 Step1。probe 失败的回退在各任务内注明。
- 类型一致性：`MemoryBackend` 在 T4 定义，T6/T7 逐字消费；`maybeRunDigest` 签名 T4 桩=T5 实。
- 已知留白（刻意）：T4 的 repo/facts/forget 复刻以仓内现有文件为唯一蓝本（源文件行号已给），不在计划里重复 200 行已存在代码——这不是 placeholder，是防止计划与源码漂移。
