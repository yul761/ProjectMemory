# StateCore 核心可审计性重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把硬编码的个人生活分面本体论从核心抽成可替换的 profile pack，让核心只负责存储、写保护、取代链与检索；同时把所有静默丢弃变为可观测、可查询。

**Architecture:** 分四个阶段推进，顺序由依赖关系决定。阶段 A（可观测化）独立且便宜，先做，产出的丢弃率数据为后续设计提供依据。阶段 B（分面注册表）是真正的分叉，先把 5 份不同步的本体论副本合并成单一来源，再让它可注入。阶段 C（容量与淘汰）与 D（漂移观测）的形状依赖 B，随后跟进。阶段 E（可审计 API）把已存在于数据结构中的审计链暴露为可查询接口。

**Tech Stack:** TypeScript, NestJS, Prisma/Postgres, Vitest, pnpm + Turbo monorepo

## Global Constraints

- 包管理器为 **pnpm**；测试命令 `pnpm test:core`，类型检查 `pnpm lint`（= `tsc --noEmit`）
- 基线：`pnpm test:core` 为 **352 passed / 3 skipped**。任何任务结束时不得低于此数（新增测试只增不减）
- `/v1` 契约（`packages/contracts/src/index.ts:683` `PublicRuntimeRoutes`）**只允许增量添加可选字段**，不得修改或删除既有字段
- 下游（statecore-cloud console、assistant-backend）对 `factRegistry` 的解析是宽松的（`z.array(z.unknown())` / 字符串数组），不得依赖它们做校验
- 所有新增的 Prisma 字段必须可空（`?`），并配套 `prisma migrate dev` 生成的迁移文件
- 提交信息沿用仓库现有风格：`feat(scope): ...` / `fix(scope): ...` / `refactor(scope): ...`
- 保持向后兼容：既有 `DigestState.profile` 数据（以 7 个分面名为 key 的对象）必须在不迁移的情况下继续可读

---

## File Structure

**新建：**
- `packages/core/src/facet-registry.ts` — 分面注册表：单一来源的分面定义（名称、上限、写保护、展示组、描述），以及官方 personal profile pack
- `packages/core/src/drop-log.ts` — 丢弃记录的类型与构造函数，供 digest 各阶段统一记录

**修改：**
- `packages/core/src/digest-control.ts` — 移除 3 处硬编码分面表，改用注册表；淘汰改 retire；补丢弃记录
- `packages/core/src/memory-facts.ts` — 移除 `FACET_TO_GROUP`，改用注册表
- `packages/core/src/facet-consolidation.ts` — 移除 `CONSOLIDATION_DISPLAY_FACETS` 与 `FACET_DESCRIPTIONS`，改用注册表
- `packages/core/src/drift-metrics.ts` — 扩展观测范围至 profile / factRegistry
- `packages/core/src/index.ts` — 导出新增符号
- `packages/prompts/src/index.ts` — 分面清单改为由注册表生成
- `packages/contracts/src/index.ts` — `FactRegistryEntrySchema` 增加可选字段；新增审计查询的输入输出契约
- `packages/db/prisma/schema.prisma` — `Digest` 增加 `selectionLog Json?`
- `apps/worker/src/digest-write.ts` — 落库 selectionLog
- `apps/worker/src/main.ts` — 传递 selectionLog；drift 指标调用点
- `apps/worker/src/env.ts` — 分面上限与输入预算的环境变量
- `apps/api/src/memory.controller.ts` — 审计 API 端点

---

## 阶段 A：静默丢弃可观测化

独立于其余阶段，可单独交付。

### Task A1: 丢弃记录的类型与统一入口

**Files:**
- Create: `packages/core/src/drop-log.ts`
- Test: `packages/core/src/drop-log.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces: `DropReason` 类型、`DropRecord` 接口、`recordDrop(log, reason, detail)` 函数

- [ ] **Step 1: 写失败测试**

```ts
// packages/core/src/drop-log.test.ts
import { describe, it, expect } from "vitest";
import { recordDrop, type DropRecord } from "./drop-log";

describe("drop-log", () => {
  it("records a drop with reason and detail", () => {
    const log: DropRecord[] = [];
    recordDrop(log, "facet_not_registered", { facet: "legal_matter", value: "案件 A 已结案" });
    expect(log).toEqual([
      { reason: "facet_not_registered", detail: { facet: "legal_matter", value: "案件 A 已结案" } }
    ]);
  });

  it("truncates long values to 200 chars so the log cannot blow up state size", () => {
    const log: DropRecord[] = [];
    recordDrop(log, "cap_evicted", { facet: "notes", value: "x".repeat(500) });
    expect((log[0].detail as { value: string }).value).toHaveLength(200);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @statecore/core exec vitest run src/drop-log.test.ts`
Expected: FAIL — `Cannot find module './drop-log'`

- [ ] **Step 3: 实现**

```ts
// packages/core/src/drop-log.ts

/**
 * Why a piece of information did not make it into the digest or the state.
 *
 * Every one of these was previously a silent `continue` or `splice`. An engine
 * that claims auditable memory must be able to say what it dropped and why —
 * losing data is survivable, losing it silently is not.
 */
export type DropReason =
  | "facet_not_registered"   // facet outside the active pack
  | "cap_evicted"            // facet at capacity, oldest entry retired
  | "cap_rejected_incoming"  // facet at capacity and fully write-protected
  | "no_display_group"       // facet has no display group mapping
  | "consolidation_skipped"; // facet not eligible for consolidation

export interface DropRecord {
  reason: DropReason;
  detail: Record<string, unknown>;
}

const MAX_VALUE_CHARS = 200;

export function recordDrop(
  log: DropRecord[],
  reason: DropReason,
  detail: Record<string, unknown>
): void {
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(detail)) {
    safe[k] = typeof v === "string" && v.length > MAX_VALUE_CHARS ? v.slice(0, MAX_VALUE_CHARS) : v;
  }
  log.push({ reason, detail: safe });
}
```

- [ ] **Step 4: 导出并运行测试**

在 `packages/core/src/index.ts` 中加入：

```ts
export { recordDrop, type DropReason, type DropRecord } from "./drop-log";
```

Run: `pnpm --filter @statecore/core exec vitest run src/drop-log.test.ts && pnpm lint`
Expected: PASS，lint 无错

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/drop-log.ts packages/core/src/drop-log.test.ts packages/core/src/index.ts
git commit -m "feat(core): add structured drop log for digest information loss"
```

### Task A2: 在 4 个静默丢弃点记录原因

**Files:**
- Modify: `packages/core/src/digest-control.ts:1252`（分面白名单）、`:1206-1217`（容量淘汰）
- Modify: `packages/core/src/memory-facts.ts:47`（无展示组）
- Modify: `packages/core/src/facet-consolidation.ts:133`（合并跳过）
- Test: `packages/core/src/digest-control.drops.test.ts`

**Interfaces:**
- Consumes: Task A1 的 `recordDrop`、`DropRecord`
- Produces: `applyProfileFactsFromDigest` 新增可选末位参数 `dropLog?: DropRecord[]`；`flattenScopeFacts(state, dropLog?)`

- [ ] **Step 1: 写失败测试**

```ts
// packages/core/src/digest-control.drops.test.ts
import { describe, it, expect } from "vitest";
import { applyProfileFactsFromDigest, type DigestState } from "./digest-control";
import type { DropRecord } from "./drop-log";

function emptyState(): DigestState {
  return { stableFacts: {}, factRegistry: [] } as unknown as DigestState;
}

describe("digest drop recording", () => {
  it("records facet_not_registered instead of dropping silently", () => {
    const state = emptyState();
    const dropLog: DropRecord[] = [];
    applyProfileFactsFromDigest(
      state,
      [{ facet: "legal_matter", value: "案件 A 已结案" }],
      [],
      null,
      () => "id-1",
      () => "2026-08-05T00:00:00.000Z",
      dropLog
    );
    expect(dropLog).toHaveLength(1);
    expect(dropLog[0].reason).toBe("facet_not_registered");
    expect(dropLog[0].detail).toMatchObject({ facet: "legal_matter" });
  });

  it("still accepts registered facets without logging a drop", () => {
    const state = emptyState();
    const dropLog: DropRecord[] = [];
    applyProfileFactsFromDigest(
      state,
      [{ facet: "goals", value: "想减肥" }],
      [],
      null,
      () => "id-2",
      () => "2026-08-05T00:00:00.000Z",
      dropLog
    );
    expect(dropLog).toHaveLength(0);
    expect(state.profile?.goals).toContain("想减肥");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @statecore/core exec vitest run src/digest-control.drops.test.ts`
Expected: FAIL — `applyProfileFactsFromDigest` 只接受 6 个参数，`dropLog` 未被填充

- [ ] **Step 3: 实现**

`packages/core/src/digest-control.ts` 顶部加入 import：

```ts
import { recordDrop, type DropRecord } from "./drop-log";
```

修改 `applyProfileFactsFromDigest` 签名（原 `:1234`），追加末位可选参数：

```ts
export function applyProfileFactsFromDigest(
  state: DigestState,
  profileFacts: { facet: string; value: string }[],
  documents: MemoryEvent[],
  streamEvidence: DigestEvidenceRef | null,
  makeId: () => string,
  makeNow: () => string = createDefaultNowFactory(),
  dropLog?: DropRecord[]
): void {
```

把原 `:1252` 的静默丢弃：

```ts
    if (!value || !DISPLAY_FACETS.has(facet)) continue;
```

改为：

```ts
    if (!value) continue;
    if (!DISPLAY_FACETS.has(facet)) {
      if (dropLog) recordDrop(dropLog, "facet_not_registered", { facet, value });
      continue;
    }
```

把原 `:1210-1213` 的保护满丢弃：

```ts
        const unprotectedIdx = facetFacts.findIndex((fact) => !isProtectedInFacet(facet, fact));
        if (unprotectedIdx === -1) continue;
        facetFacts.splice(unprotectedIdx, 1);
```

改为：

```ts
        const unprotectedIdx = facetFacts.findIndex((fact) => !isProtectedInFacet(facet, fact));
        if (unprotectedIdx === -1) {
          if (dropLog) recordDrop(dropLog, "cap_rejected_incoming", { facet, value: incomingValue, cap });
          continue;
        }
        const [evictedProtected] = facetFacts.splice(unprotectedIdx, 1);
        if (dropLog) recordDrop(dropLog, "cap_evicted", { facet, value: evictedProtected, cap });
```

把同段 volatile 分支：

```ts
      } else {
        // Volatile: evict first (index 0 = weakest/oldest)
        facetFacts.splice(0, 1);
      }
```

改为：

```ts
      } else {
        // Volatile: evict first (index 0 = weakest/oldest)
        const [evicted] = facetFacts.splice(0, 1);
        if (dropLog) recordDrop(dropLog, "cap_evicted", { facet, value: evicted, cap });
      }
```

`packages/core/src/memory-facts.ts` 中 `flattenScopeFacts` 签名改为：

```ts
export function flattenScopeFacts(state: DigestState, dropLog?: DropRecord[]): DisplayFact[] {
```

并把 `:47` 的 `if (!group) continue;` 改为：

```ts
    if (!group) {
      if (dropLog) recordDrop(dropLog, "no_display_group", { facet: entry.facet, value: entry.content });
      continue;
    }
```

`packages/core/src/facet-consolidation.ts` 中 `runConsolidation` 的 `:133`：

```ts
    if (!CONSOLIDATION_DISPLAY_FACETS.includes(facet)) continue;
```

改为（同样追加可选 `dropLog` 参数到 `runConsolidation` 签名）：

```ts
    if (!CONSOLIDATION_DISPLAY_FACETS.includes(facet)) {
      if (dropLog) recordDrop(dropLog, "consolidation_skipped", { facet });
      continue;
    }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test:core && pnpm lint`
Expected: 新测试 PASS，既有 352 个测试仍全绿（`dropLog` 为可选参数，既有调用点不受影响）

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/digest-control.ts packages/core/src/memory-facts.ts \
        packages/core/src/facet-consolidation.ts packages/core/src/digest-control.drops.test.ts
git commit -m "feat(core): record why facts are dropped instead of discarding silently"
```

### Task A3: 把 selection rationale 与 dropLog 落库

**Files:**
- Modify: `packages/db/prisma/schema.prisma:107-121`（Digest 模型）
- Create: `packages/db/prisma/migrations/<timestamp>_digest_selection_log/migration.sql`（由 prisma 生成）
- Modify: `apps/worker/src/digest-write.ts`
- Modify: `apps/worker/src/main.ts:299-310`
- Test: `apps/worker/src/digest-write.test.ts`

**Interfaces:**
- Consumes: Task A1 的 `DropRecord`
- Produces: `CreateDigestWithSnapshotInput` 新增可选字段 `selectionLog?: unknown`

- [ ] **Step 1: 写失败测试**

```ts
// apps/worker/src/digest-write.test.ts
import { describe, it, expect, vi } from "vitest";
import { createDigestWithSnapshot } from "./digest-write";

describe("createDigestWithSnapshot", () => {
  it("persists selectionLog on the digest row", async () => {
    const digestCreate = vi.fn().mockResolvedValue({ id: "d1" });
    const snapshotCreate = vi.fn().mockResolvedValue({});
    const prisma = {
      $transaction: async (fn: any) =>
        fn({ digest: { create: digestCreate }, digestStateSnapshot: { create: snapshotCreate } })
    };

    await createDigestWithSnapshot(prisma as any, {
      scopeId: "s1",
      summary: "sum",
      changes: "- c",
      nextSteps: [],
      state: {},
      consistency: {},
      selectionLog: { rationale: ["selected_docs:2"], drops: [{ reason: "cap_evicted", detail: {} }] }
    });

    expect(digestCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        selectionLog: { rationale: ["selected_docs:2"], drops: [{ reason: "cap_evicted", detail: {} }] }
      })
    });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @statecore/worker exec vitest run src/digest-write.test.ts`
Expected: FAIL — `selectionLog` 不在 `data` 中

- [ ] **Step 3: 实现**

`packages/db/prisma/schema.prisma` 的 `Digest` 模型增加一行：

```prisma
model Digest {
  id             String   @id @default(uuid())
  scopeId        String
  summary        String
  changes        String
  nextSteps      Json
  selectionLog   Json?
  rebuildGroupId String?
  createdAt      DateTime @default(now())

  scope          ProjectScope        @relation(fields: [scopeId], references: [id])
  stateSnapshot  DigestStateSnapshot?

  @@index([scopeId, createdAt])
  @@index([scopeId, rebuildGroupId])
}
```

生成迁移：

```bash
pnpm --filter @statecore/db exec prisma migrate dev --name digest_selection_log
```

`apps/worker/src/digest-write.ts` 的输入类型与写入：

```ts
export interface CreateDigestWithSnapshotInput {
  scopeId: string;
  summary: string;
  changes: string;
  nextSteps: unknown;
  state: unknown;
  consistency: unknown;
  selectionLog?: unknown;
  rebuildGroupId?: string;
}
```

```ts
    const digest = await tx.digest.create({
      data: {
        scopeId: input.scopeId,
        summary: input.summary,
        changes: input.changes,
        nextSteps: input.nextSteps,
        ...(input.selectionLog !== undefined ? { selectionLog: input.selectionLog } : {}),
        ...(input.rebuildGroupId ? { rebuildGroupId: input.rebuildGroupId } : {})
      } as any
    });
```

`apps/worker/src/main.ts` 中 `createDigestWithSnapshot` 调用处（原 `:302`）传入：

```ts
  const createdDigest = await createDigestWithSnapshot(prisma, {
    scopeId: data.scopeId,
    summary: result.digest.summary,
    changes: result.digest.changes.map((c) => `- ${c}`).join("\n"),
    nextSteps: result.digest.nextSteps,
    state: result.state,
    consistency: result.consistency,
    selectionLog: { rationale: result.selection.rationale, drops: result.dropLog ?? [] }
  });
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @statecore/worker exec vitest run src/digest-write.test.ts && pnpm test:core && pnpm lint`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add packages/db/prisma apps/worker/src/digest-write.ts apps/worker/src/digest-write.test.ts apps/worker/src/main.ts
git commit -m "feat(worker): persist digest selection rationale and drop log"
```

---

## 阶段 B：分面注册表（profile pack）

### Task B1: 建立单一来源的分面注册表

**Files:**
- Create: `packages/core/src/facet-registry.ts`
- Test: `packages/core/src/facet-registry.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces: `FacetDefinition`、`FacetPack`、`PERSONAL_PROFILE_PACK`、`getFacetPack()`、`setFacetPack(pack)`、`isRegisteredFacet(facet)`、`getFacetCap(facet)`、`getFacetDisplayGroup(facet)`、`getFacetDescription(facet)`、`isWriteProtectedFacet(facet)`、`listFacets()`

- [ ] **Step 1: 写失败测试**

```ts
// packages/core/src/facet-registry.test.ts
import { describe, it, expect, afterEach } from "vitest";
import {
  PERSONAL_PROFILE_PACK, getFacetPack, setFacetPack, isRegisteredFacet,
  getFacetCap, getFacetDisplayGroup, listFacets, type FacetPack
} from "./facet-registry";

afterEach(() => setFacetPack(PERSONAL_PROFILE_PACK));

describe("facet registry", () => {
  it("defaults to the personal profile pack with the historical 7 facets", () => {
    expect(listFacets().sort()).toEqual(
      ["followUps", "goals", "identity", "notes", "ongoing", "relationships", "style"]
    );
  });

  it("preserves the historical caps", () => {
    expect(getFacetCap("identity")).toBe(15);
    expect(getFacetCap("notes")).toBe(30);
    expect(getFacetCap("style")).toBe(6);
  });

  it("reports unknown facets as unregistered under the default pack", () => {
    expect(isRegisteredFacet("legal_matter")).toBe(false);
  });

  it("accepts a replacement pack so the core carries no domain ontology", () => {
    const legalPack: FacetPack = {
      name: "legal",
      facets: [
        { name: "matter", cap: 100, writeProtected: true, displayGroup: "Matters", description: "case matters" }
      ]
    };
    setFacetPack(legalPack);
    expect(isRegisteredFacet("matter")).toBe(true);
    expect(isRegisteredFacet("identity")).toBe(false);
    expect(getFacetDisplayGroup("matter")).toBe("Matters");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @statecore/core exec vitest run src/facet-registry.test.ts`
Expected: FAIL — `Cannot find module './facet-registry'`

- [ ] **Step 3: 实现**

```ts
// packages/core/src/facet-registry.ts

/**
 * Single source of truth for profile facets.
 *
 * Before this file the same 7-facet ontology was duplicated in five places
 * (DISPLAY_FACETS, PROFILE_FACET_CAPS, PROFILE_FACET_ROUTING, FACET_TO_GROUP,
 * CONSOLIDATION_DISPLAY_FACETS) plus the stage-2 prompt. The duplicates drifted
 * and, worse, hard-wired a personal-life ontology into an engine that is meant
 * to be domain-neutral. The core now stores, protects, supersedes and retrieves;
 * what the facets *mean* is supplied by a pack.
 */
export interface FacetDefinition {
  name: string;
  cap: number;
  writeProtected: boolean;
  /** null = never surfaced in the display API (e.g. identity stays private). */
  displayGroup: string | null;
  description: string;
}

export interface FacetPack {
  name: string;
  facets: FacetDefinition[];
}

/**
 * The historical StateCore ontology, preserved verbatim so that existing
 * DigestState.profile data keeps working without migration.
 */
export const PERSONAL_PROFILE_PACK: FacetPack = {
  name: "personal",
  facets: [
    { name: "identity", cap: 15, writeProtected: true, displayGroup: null,
      description: "durable personal facts from documents (resume/bio): 工作经历, 教育, 技能, 联系方式." },
    { name: "style", cap: 6, writeProtected: false, displayGroup: "Style",
      description: "the user's tastes, communication preferences and working style." },
    { name: "goals", cap: 8, writeProtected: true, displayGroup: "Projects",
      description: "things the user wants to achieve." },
    { name: "relationships", cap: 10, writeProtected: false, displayGroup: "People",
      description: "important people (and pets) in the user's life." },
    { name: "followUps", cap: 10, writeProtected: false, displayGroup: "Schedule",
      description: "commitments or things to remember/do, with any date/time." },
    { name: "ongoing", cap: 8, writeProtected: false, displayGroup: "Projects",
      description: "projects or activities in progress." },
    { name: "notes", cap: 30, writeProtected: false, displayGroup: "Notes",
      description: "durable, useful non-personal information worth keeping long-term." }
  ]
};

let activePack: FacetPack = PERSONAL_PROFILE_PACK;
let byName: Map<string, FacetDefinition> = indexPack(PERSONAL_PROFILE_PACK);

function indexPack(pack: FacetPack): Map<string, FacetDefinition> {
  return new Map(pack.facets.map((f) => [f.name, f]));
}

export function setFacetPack(pack: FacetPack): void {
  activePack = pack;
  byName = indexPack(pack);
}

export function getFacetPack(): FacetPack {
  return activePack;
}

export function listFacets(): string[] {
  return activePack.facets.map((f) => f.name);
}

export function isRegisteredFacet(facet: string): boolean {
  return byName.has(facet);
}

export function getFacetCap(facet: string): number {
  return byName.get(facet)?.cap ?? 8;
}

export function isWriteProtectedFacet(facet: string): boolean {
  return byName.get(facet)?.writeProtected ?? false;
}

export function getFacetDisplayGroup(facet: string): string | null {
  return byName.get(facet)?.displayGroup ?? null;
}

export function getFacetDescription(facet: string): string {
  return byName.get(facet)?.description ?? "";
}
```

- [ ] **Step 4: 导出并运行测试**

`packages/core/src/index.ts` 加入：

```ts
export {
  PERSONAL_PROFILE_PACK, getFacetPack, setFacetPack, listFacets, isRegisteredFacet,
  getFacetCap, isWriteProtectedFacet, getFacetDisplayGroup, getFacetDescription,
  type FacetDefinition, type FacetPack
} from "./facet-registry";
```

Run: `pnpm --filter @statecore/core exec vitest run src/facet-registry.test.ts && pnpm lint`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/facet-registry.ts packages/core/src/facet-registry.test.ts packages/core/src/index.ts
git commit -m "feat(core): add facet registry as single source of truth for profile ontology"
```

### Task B2: digest-control 改用注册表

**Files:**
- Modify: `packages/core/src/digest-control.ts:1229`（`DISPLAY_FACETS`）、`:1230`（`PROFILE_FACET_CAPS`）、`:1290`
- Test: 既有 `packages/core/src/digest-control.test.ts` 必须继续全绿

**Interfaces:**
- Consumes: Task B1 的 `isRegisteredFacet`、`getFacetCap`、`getFacetDisplayGroup`

- [ ] **Step 1: 写失败测试**

```ts
// 追加到 packages/core/src/facet-registry.test.ts
import { applyProfileFactsFromDigest, type DigestState } from "./digest-control";

it("digest-control honours a replacement pack rather than the hardcoded set", () => {
  setFacetPack({
    name: "legal",
    facets: [{ name: "matter", cap: 2, writeProtected: false, displayGroup: "Matters", description: "" }]
  });
  const state = { stableFacts: {}, factRegistry: [] } as unknown as DigestState;
  applyProfileFactsFromDigest(
    state,
    [{ facet: "matter", value: "案件 A 已结案" }, { facet: "goals", value: "想减肥" }],
    [], null, () => "id", () => "2026-08-05T00:00:00.000Z"
  );
  expect((state.profile as Record<string, string[]>).matter).toContain("案件 A 已结案");
  expect((state.profile as Record<string, string[]>).goals).toBeUndefined();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @statecore/core exec vitest run src/facet-registry.test.ts`
Expected: FAIL — `matter` 被丢弃（仍走硬编码 `DISPLAY_FACETS`），`goals` 反而被接受

- [ ] **Step 3: 实现**

`digest-control.ts` 顶部加入 import：

```ts
import { isRegisteredFacet, getFacetCap, getFacetDisplayGroup } from "./facet-registry";
```

删除 `:1229-1232` 的两个常量：

```ts
const DISPLAY_FACETS = new Set([...]);
const PROFILE_FACET_CAPS: Record<string, number> = {...};
```

把 `applyProfileFactsFromDigest` 内的白名单判断改为：

```ts
    if (!isRegisteredFacet(facet)) {
      if (dropLog) recordDrop(dropLog, "facet_not_registered", { facet, value });
      continue;
    }
```

把 `const cap = PROFILE_FACET_CAPS[facet] ?? 8;` 改为：

```ts
    const cap = getFacetCap(facet);
```

`:1290` 的 identity 硬编码特例改为按注册表的写保护标记判断：

```ts
      if (isWriteProtectedFacet(facet)) continue; // protected facets are not evicted to make room
```

`addNoteFact`（`:1345` 附近）中 `PROFILE_FACET_CAPS.notes ?? 30` 改为 `getFacetCap("notes")`。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test:core && pnpm lint`
Expected: 新测试 PASS，既有 352 个全绿（默认 pack 与原硬编码值逐项一致）

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/digest-control.ts packages/core/src/facet-registry.test.ts
git commit -m "refactor(core): drive digest facet gating and caps from the registry"
```

### Task B3: memory-facts 与 facet-consolidation 改用注册表

**Files:**
- Modify: `packages/core/src/memory-facts.ts:14-21`（`FACET_TO_GROUP`、`GROUP_ORDER`）
- Modify: `packages/core/src/facet-consolidation.ts:120-127`（`FACET_DESCRIPTIONS`、`CONSOLIDATION_DISPLAY_FACETS`）

**Interfaces:**
- Consumes: Task B1 的 `getFacetDisplayGroup`、`getFacetDescription`、`listFacets`
- Produces: `DisplayGroup` 由固定联合类型放宽为 `string`

- [ ] **Step 1: 写失败测试**

```ts
// 追加到 packages/core/src/facet-registry.test.ts
import { factToGroup } from "./memory-facts";

it("display grouping follows the active pack", () => {
  setFacetPack({
    name: "legal",
    facets: [{ name: "matter", cap: 5, writeProtected: false, displayGroup: "Matters", description: "" }]
  });
  expect(factToGroup("matter")).toBe("Matters");
  expect(factToGroup("relationships")).toBeNull();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @statecore/core exec vitest run src/facet-registry.test.ts`
Expected: FAIL — `factToGroup("matter")` 返回 `null`

- [ ] **Step 3: 实现**

`memory-facts.ts`：删除 `FACET_TO_GROUP` 与 `GROUP_ORDER` 常量，`DisplayGroup` 改为 `string`：

```ts
import { getFacetDisplayGroup, listFacets } from "./facet-registry";

export type DisplayGroup = string;

export function factToGroup(facet: string): DisplayGroup | null {
  return getFacetDisplayGroup(facet);
}

function groupOrder(): string[] {
  const seen: string[] = [];
  for (const facet of listFacets()) {
    const g = getFacetDisplayGroup(facet);
    if (g && !seen.includes(g)) seen.push(g);
  }
  return seen;
}
```

`groupFactsForDisplay` 中原先引用 `GROUP_ORDER` 的位置改为调用 `groupOrder()`。

`facet-consolidation.ts`：删除 `FACET_DESCRIPTIONS` 与 `CONSOLIDATION_DISPLAY_FACETS`，改为：

```ts
import { getFacetDescription, isRegisteredFacet, listFacets } from "./facet-registry";
```

`consolidateOne` 中 `FACET_DESCRIPTIONS[facet] ?? ""` 改为 `getFacetDescription(facet)`；
siblings 循环的 `for (const f of CONSOLIDATION_DISPLAY_FACETS)` 改为 `for (const f of listFacets())`；
`runConsolidation` 的 `if (!CONSOLIDATION_DISPLAY_FACETS.includes(facet))` 改为 `if (!isRegisteredFacet(facet))`。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test:core && pnpm lint`
Expected: 全绿

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/memory-facts.ts packages/core/src/facet-consolidation.ts packages/core/src/facet-registry.test.ts
git commit -m "refactor(core): drive display grouping and consolidation from the registry"
```

### Task B4: DigestState.profile 放宽为 Record

**Files:**
- Modify: `packages/core/src/digest-control.ts:60-68`（`profile` 类型）、`:1153-1161`（`PROFILE_FACET_ROUTING` 的 `keyof` 约束）

**Interfaces:**
- Produces: `DigestState["profile"]?: Record<string, string[]>`

- [ ] **Step 1: 写失败测试**

```ts
// 追加到 packages/core/src/facet-registry.test.ts
it("stores facets from a replacement pack under their own keys", () => {
  setFacetPack({
    name: "legal",
    facets: [{ name: "matter", cap: 5, writeProtected: false, displayGroup: "Matters", description: "" }]
  });
  const state = { stableFacts: {}, factRegistry: [] } as unknown as DigestState;
  applyProfileFactsFromDigest(state, [{ facet: "matter", value: "案件 B 立案" }], [], null,
    () => "id", () => "2026-08-05T00:00:00.000Z");
  expect(Object.keys(state.profile ?? {})).toEqual(["matter"]);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm lint`
Expected: FAIL — `profile` 的固定 7 键类型不接受 `matter`

- [ ] **Step 3: 实现**

`digest-control.ts:60-68` 改为：

```ts
  factRegistry?: FactRegistryEntry[];
  /**
   * Facet name → fact lines. Keys are supplied by the active facet pack, not by
   * this type — the engine must not know what the facets mean.
   */
  profile?: Record<string, string[]>;
}
```

`PROFILE_FACET_ROUTING` 的类型约束由 `keyof NonNullable<DigestState["profile"]>` 改为 `string`：

```ts
const PROFILE_FACET_ROUTING: Record<string, { facet: string; cap: number; writeProtected: boolean }> = {
```

`:326` 的 `identity: (...).slice(0, 15)` 改为按注册表上限：

```ts
          identity: ((base as DigestState).profile?.identity ?? []).slice(0, getFacetCap("identity")),
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test:core && pnpm lint`
Expected: 全绿。既有数据（7 键对象）天然满足 `Record<string, string[]>`，**无需数据迁移**

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/digest-control.ts packages/core/src/facet-registry.test.ts
git commit -m "refactor(core): widen DigestState.profile to an open facet record"
```

### Task B5: 提示词分面清单由注册表生成

**Files:**
- Modify: `packages/prompts/src/index.ts:1-17`
- Modify: `apps/worker/src/main.ts`（传入生成的分面段落）
- Test: `packages/core/src/facet-registry.test.ts`

**Interfaces:**
- Produces: `buildFacetPromptSection(): string`（置于 `facet-registry.ts`）

- [ ] **Step 1: 写失败测试**

```ts
// 追加到 packages/core/src/facet-registry.test.ts
import { buildFacetPromptSection } from "./facet-registry";

it("generates the prompt facet list from the active pack", () => {
  setFacetPack({
    name: "legal",
    facets: [{ name: "matter", cap: 5, writeProtected: false, displayGroup: "Matters", description: "case matters" }]
  });
  const section = buildFacetPromptSection();
  expect(section).toContain('- "matter": case matters');
  expect(section).not.toContain("identity");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @statecore/core exec vitest run src/facet-registry.test.ts`
Expected: FAIL — `buildFacetPromptSection` 未导出

- [ ] **Step 3: 实现**

`facet-registry.ts` 追加：

```ts
export function buildFacetPromptSection(): string {
  return activePack.facets.map((f) => `  - "${f.name}": ${f.description}`).join("\n");
}
```

`packages/prompts/src/index.ts` 把 `digestStage2SystemPrompt` 由常量改为函数，分面段落用占位符：

```ts
export function buildDigestStage2SystemPrompt(facetSection: string): string {
  return `You are a long-term memory engine. Create a concise and faithful digest.
Rules:
- Output JSON only.
- goal must be a single short line (the scope goal, verbatim or lightly refined).
- summary must be <= 120 words.
- changes must be <= 3 bullets.
- nextSteps must be 1-3 concrete actionable tasks.
- profileFacts: array of {facet, value} pairs extracted from the conversation (Delta candidates) AND any documents. Aggressively capture durable things the user reveals. Allowed facets:
${facetSection}
  Each value is a self-contained fact line in the user's own language. Do NOT include internal identifiers (reminder IDs, UUIDs, database ids) in a value. When the user corrects or updates a fact, output ONLY the latest value — never also emit the superseded older version. Do not invent facts not present in the evidence.
- Do not invent facts not present in the provided evidence.`;
}

/** Back-compat: the default pack's rendering, for callers that have not migrated. */
export const digestStage2SystemPrompt = buildDigestStage2SystemPrompt(
  `  - "identity": durable personal facts from documents (resume/bio): 工作经历, 教育, 技能, 联系方式.
  - "style": the user's tastes, communication preferences and working style.
  - "goals": things the user wants to achieve.
  - "relationships": important people (and pets) in the user's life.
  - "followUps": commitments or things to remember/do, with any date/time.
  - "ongoing": projects or activities in progress.
  - "notes": durable, useful non-personal information worth keeping long-term.`
);
```

`apps/worker/src/main.ts` 中传入 `digestStage2SystemPrompt` 的位置改为
`buildDigestStage2SystemPrompt(buildFacetPromptSection())`。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test:core && pnpm lint`
Expected: 全绿。既有引用 `digestStage2SystemPrompt` 的测试因保留了常量而不受影响

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/facet-registry.ts packages/prompts/src/index.ts apps/worker/src/main.ts packages/core/src/facet-registry.test.ts
git commit -m "feat(prompts): generate the facet list from the active pack"
```

---

## 阶段 C：容量淘汰改为可追溯

### Task C1: FactRegistryEntry 增加 retired 标记

**Files:**
- Modify: `packages/core/src/digest-control.ts:1090`（`getActiveFactRegistry`）、`FactRegistryEntry` 类型
- Modify: `packages/contracts/src/index.ts:124-134`
- Test: `packages/core/src/fact-retire.test.ts`

**Interfaces:**
- Produces: `FactRegistryEntry.retiredAt?: string`、`.retiredReason?: string`；`retireFact(state, content, reason, makeNow)`

- [ ] **Step 1: 写失败测试**

```ts
// packages/core/src/fact-retire.test.ts
import { describe, it, expect } from "vitest";
import { getActiveFactRegistry, retireFact, type DigestState } from "./digest-control";

describe("fact retirement", () => {
  it("keeps a retired fact in the registry but out of the active set", () => {
    const state = {
      stableFacts: {},
      factRegistry: [{
        id: "f1", content: "旧事实", type: "profile", confidence: 0.7,
        addedAt: "2026-01-01T00:00:00.000Z", evidenceId: "e1", evidenceType: "event", facet: "notes"
      }]
    } as unknown as DigestState;

    retireFact(state, "旧事实", "cap_evicted", () => "2026-08-05T00:00:00.000Z");

    expect(state.factRegistry).toHaveLength(1);
    expect(state.factRegistry![0].retiredAt).toBe("2026-08-05T00:00:00.000Z");
    expect(state.factRegistry![0].retiredReason).toBe("cap_evicted");
    expect(getActiveFactRegistry(state)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @statecore/core exec vitest run src/fact-retire.test.ts`
Expected: FAIL — `retireFact` 未导出

- [ ] **Step 3: 实现**

`digest-control.ts` 的 `FactRegistryEntry` 增加两个可选字段：

```ts
export interface FactRegistryEntry {
  id: string;
  content: string;
  type: "decision" | "constraint" | "profile";
  confidence: number;
  addedAt: string;
  evidenceId: string;
  evidenceType: "event" | "document";
  supersededBy?: string;
  facet?: string;
  /** Set when the fact left the active set without being replaced (capacity, explicit forget). */
  retiredAt?: string;
  retiredReason?: string;
}
```

`getActiveFactRegistry` 增加过滤：

```ts
export function getActiveFactRegistry(state: DigestState): FactRegistryEntry[] {
  return (state.factRegistry ?? []).filter((entry) => !entry.supersededBy && !entry.retiredAt);
}
```

新增导出函数：

```ts
/**
 * Retire a fact instead of deleting it.
 *
 * Capacity eviction used to `splice()` the registry record out, which destroyed
 * the very audit chain supersession exists to provide. A retired fact stays on
 * the record with a timestamp and a reason; it simply stops being active.
 */
export function retireFact(
  state: DigestState,
  content: string,
  reason: string,
  makeNow: () => string = createDefaultNowFactory()
): void {
  if (!state.factRegistry) return;
  const target = state.factRegistry.find(
    (entry) => !entry.supersededBy && !entry.retiredAt && sameFactCjkAware(entry.content, content, 0.6)
  );
  if (!target) return;
  target.retiredAt = makeNow();
  target.retiredReason = reason;
}
```

`packages/contracts/src/index.ts` 的 `FactRegistryEntrySchema` 追加：

```ts
  retiredAt: z.string().optional(),
  retiredReason: z.string().optional()
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test:core && pnpm lint`
Expected: 全绿

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/digest-control.ts packages/core/src/fact-retire.test.ts packages/contracts/src/index.ts
git commit -m "feat(core): retire facts instead of deleting their registry records"
```

### Task C2: 容量淘汰改用 retireFact

**Files:**
- Modify: `packages/core/src/digest-control.ts:1345`（`addNoteFact` 硬删除）
- Test: `packages/core/src/fact-retire.test.ts`

**Interfaces:**
- Consumes: Task C1 的 `retireFact`

- [ ] **Step 1: 写失败测试**

```ts
// 追加到 packages/core/src/fact-retire.test.ts
import { addNoteFact, getFacetCap } from "./digest-control";

it("capacity eviction retires the registry record rather than deleting it", () => {
  const state = { stableFacts: {}, factRegistry: [], profile: { notes: [] } } as unknown as DigestState;
  let n = 0;
  const cap = 30;
  for (let i = 0; i < cap + 1; i++) {
    addNoteFact(state, `note ${i}`, () => `id-${n++}`, () => "2026-08-05T00:00:00.000Z");
  }
  const retired = state.factRegistry!.filter((e) => e.retiredAt);
  expect(retired).toHaveLength(1);
  expect(retired[0].content).toBe("note 0");
  expect(retired[0].retiredReason).toBe("cap_evicted");
  expect(getActiveFactRegistry(state)).toHaveLength(cap);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @statecore/core exec vitest run src/fact-retire.test.ts`
Expected: FAIL — 记录被 `splice` 删除，`retired` 为空且 `factRegistry` 长度为 30

- [ ] **Step 3: 实现**

`addNoteFact` 中原先的硬删除块：

```ts
  const cap = PROFILE_FACET_CAPS.notes ?? 30;
  if (notes.length >= cap) {
    const [evicted] = notes.splice(0, 1);
    if (evicted && state.factRegistry) {
      const ri = state.factRegistry.findIndex(
        (e) => e.type === "profile" && e.facet === "notes" && !e.supersededBy && norm(e.content) === norm(evicted)
      );
      if (ri !== -1) state.factRegistry.splice(ri, 1);
    }
  }
```

改为：

```ts
  const cap = getFacetCap("notes");
  if (notes.length >= cap) {
    const [evicted] = notes.splice(0, 1);
    if (evicted) retireFact(state, evicted, "cap_evicted", makeNow);
  }
```

同时在 `applyProfileFactsFromDigest` 的两处 `splice` 淘汰后补上 `retireFact(state, evicted, "cap_evicted", makeNow)`。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test:core && pnpm lint`
Expected: 全绿

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/digest-control.ts packages/core/src/fact-retire.test.ts
git commit -m "fix(core): stop capacity eviction from destroying the audit chain"
```

### Task C3: 分面上限与输入预算可配置

**Files:**
- Modify: `apps/worker/src/env.ts:160-163`
- Modify: `apps/worker/src/main.ts`（启动时按环境变量覆盖 pack 上限）
- Test: `packages/core/src/facet-registry.test.ts`

**Interfaces:**
- Produces: `overrideFacetCaps(caps: Record<string, number>)`

- [ ] **Step 1: 写失败测试**

```ts
// 追加到 packages/core/src/facet-registry.test.ts
import { overrideFacetCaps } from "./facet-registry";

it("allows per-facet cap overrides without replacing the pack", () => {
  overrideFacetCaps({ identity: 60 });
  expect(getFacetCap("identity")).toBe(60);
  expect(getFacetCap("notes")).toBe(30);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @statecore/core exec vitest run src/facet-registry.test.ts`
Expected: FAIL — `overrideFacetCaps` 未导出

- [ ] **Step 3: 实现**

`facet-registry.ts` 追加：

```ts
export function overrideFacetCaps(caps: Record<string, number>): void {
  for (const [name, cap] of Object.entries(caps)) {
    const def = byName.get(name);
    if (def) def.cap = cap;
  }
}
```

`apps/worker/src/env.ts` 增加：

```ts
  DIGEST_FACET_CAPS: z.string().optional(),   // 形如 "identity=60,notes=100"
```

```ts
  digestFacetCaps: parseFacetCaps(env.DIGEST_FACET_CAPS),
```

并在同文件加入解析函数：

```ts
function parseFacetCaps(raw?: string): Record<string, number> {
  if (!raw) return {};
  const out: Record<string, number> = {};
  for (const pair of raw.split(",")) {
    const [name, value] = pair.split("=");
    const n = Number(value);
    if (name && Number.isFinite(n) && n > 0) out[name.trim()] = n;
  }
  return out;
}
```

`apps/worker/src/main.ts` 启动时调用一次：

```ts
overrideFacetCaps(workerEnv.digestFacetCaps);
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test:core && pnpm lint`
Expected: 全绿

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/facet-registry.ts apps/worker/src/env.ts apps/worker/src/main.ts packages/core/src/facet-registry.test.ts
git commit -m "feat(worker): make facet caps configurable via DIGEST_FACET_CAPS"
```

---

## 阶段 D：漂移观测覆盖事实库

### Task D1: computeDriftMetrics 覆盖 profile 与 factRegistry

**Files:**
- Modify: `packages/core/src/drift-metrics.ts`
- Test: `packages/core/src/drift-metrics.test.ts`（既有 7 个测试必须继续通过）

**Interfaces:**
- Produces: `DriftMetrics` 增加 `factsAdded`、`factsRetired`、`factsSuperseded`、`profileFactsChanged`

- [ ] **Step 1: 写失败测试**

```ts
// 追加到 packages/core/src/drift-metrics.test.ts
import { computeDriftMetrics } from "./drift-metrics";
import type { DigestState } from "./digest-control";

function withFacts(entries: unknown[]): DigestState {
  return { stableFacts: {}, factRegistry: entries } as unknown as DigestState;
}

it("observes the fact registry, not just stableFacts", () => {
  const before = withFacts([
    { id: "a", content: "旧", type: "profile", confidence: 0.7, addedAt: "x", evidenceId: "e", evidenceType: "event" }
  ]);
  const after = withFacts([
    { id: "a", content: "旧", type: "profile", confidence: 0.7, addedAt: "x", evidenceId: "e", evidenceType: "event", retiredAt: "y", retiredReason: "cap_evicted" },
    { id: "b", content: "新", type: "profile", confidence: 0.7, addedAt: "y", evidenceId: "e", evidenceType: "event" }
  ]);
  const m = computeDriftMetrics(before, after);
  expect(m.factsAdded).toBe(1);
  expect(m.factsRetired).toBe(1);
  expect(m.factsSuperseded).toBe(0);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @statecore/core exec vitest run src/drift-metrics.test.ts`
Expected: FAIL — `factsAdded` 等字段不存在

- [ ] **Step 3: 实现**

`drift-metrics.ts` 的接口与实现追加：

```ts
export interface DriftMetrics {
  goalChanged: boolean;
  decisionsAdded: number;
  decisionsRemoved: number;
  constraintsAdded: number;
  constraintsRemoved: number;
  todosAdded: number;
  todosRemoved: number;
  stabilityScore: number;
  /** Fact-registry observation. The profile facets are where user facts actually
   *  live; drift measured only over stableFacts could not see them at all. */
  factsAdded: number;
  factsRetired: number;
  factsSuperseded: number;
}
```

在 `computeDriftMetrics` 的两个返回点补上计算：

```ts
  const beforeIds = new Set((before?.factRegistry ?? []).map((e) => e.id));
  const afterEntries = after.factRegistry ?? [];
  const factsAdded = afterEntries.filter((e) => !beforeIds.has(e.id)).length;
  const beforeById = new Map((before?.factRegistry ?? []).map((e) => [e.id, e]));
  const factsRetired = afterEntries.filter((e) => e.retiredAt && !beforeById.get(e.id)?.retiredAt).length;
  const factsSuperseded = afterEntries.filter((e) => e.supersededBy && !beforeById.get(e.id)?.supersededBy).length;
```

`before === null` 的早返回分支中三者均为 `after.factRegistry?.length ?? 0` / `0` / `0`。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test:core && pnpm lint`
Expected: 既有 7 个 drift 测试 + 新测试全绿

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/drift-metrics.ts packages/core/src/drift-metrics.test.ts
git commit -m "feat(core): extend drift metrics to observe the fact registry"
```

---

## 阶段 E：可审计 API

### Task E1: 事实溯源端点

**Files:**
- Modify: `packages/contracts/src/index.ts`（新增 `FactProvenanceOutput`）
- Modify: `apps/api/src/memory.controller.ts`
- Test: `apps/api/src/memory.controller.provenance.spec.ts`

**Interfaces:**
- Produces: `GET /v1/memory/facts/:factId/provenance` → `{ fact, chain, evidence }`

- [ ] **Step 1: 写失败测试**

```ts
// apps/api/src/memory.controller.provenance.spec.ts
import { describe, it, expect } from "vitest";
import { buildFactProvenance } from "./memory.controller";
import type { DigestState } from "@statecore/core";

describe("buildFactProvenance", () => {
  it("returns the supersession chain oldest-first", () => {
    const state = {
      factRegistry: [
        { id: "v1", content: "后端工程师", type: "profile", confidence: 0.7, addedAt: "t1",
          evidenceId: "doc1", evidenceType: "document", supersededBy: "v2", facet: "identity" },
        { id: "v2", content: "资深后端工程师", type: "profile", confidence: 0.85, addedAt: "t2",
          evidenceId: "doc2", evidenceType: "document", facet: "identity" }
      ]
    } as unknown as DigestState;

    const result = buildFactProvenance(state, "v2");
    expect(result).not.toBeNull();
    expect(result!.chain.map((c) => c.id)).toEqual(["v1", "v2"]);
    expect(result!.fact.content).toBe("资深后端工程师");
  });

  it("returns null for an unknown fact id", () => {
    expect(buildFactProvenance({ factRegistry: [] } as unknown as DigestState, "nope")).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @statecore/api exec vitest run src/memory.controller.provenance.spec.ts`
Expected: FAIL — `buildFactProvenance` 未导出

- [ ] **Step 3: 实现**

`memory.controller.ts` 新增导出函数与端点：

```ts
export function buildFactProvenance(state: DigestState, factId: string) {
  const registry = state.factRegistry ?? [];
  const fact = registry.find((e) => e.id === factId);
  if (!fact) return null;

  // Walk backwards to the oldest ancestor, then forward along supersededBy.
  const bySuperseded = new Map(registry.filter((e) => e.supersededBy).map((e) => [e.supersededBy!, e]));
  let root = fact;
  while (bySuperseded.has(root.id)) root = bySuperseded.get(root.id)!;

  const byId = new Map(registry.map((e) => [e.id, e]));
  const chain: typeof registry = [];
  let cursor: typeof fact | undefined = root;
  while (cursor) {
    chain.push(cursor);
    cursor = cursor.supersededBy ? byId.get(cursor.supersededBy) : undefined;
  }
  return { fact, chain };
}
```

```ts
  @Get(["/memory/facts/:factId/provenance", "/v1/memory/facts/:factId/provenance"])
  async factProvenance(@Req() req: RequestWithUser, @Param("factId") factId: string, @Query("scopeId") scopeId: string) {
    const scope = await this.domain.projectService.getScope(req.userId, scopeId);
    if (!scope) throw new NotFoundException("Scope not found");
    const snapshot = await this.domain.getLatestDigestState(scopeId);
    if (!snapshot) throw new NotFoundException("No digest state");
    const result = buildFactProvenance(snapshot.state as DigestState, factId);
    if (!result) throw new NotFoundException("Fact not found");
    return result;
  }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @statecore/api exec vitest run src/memory.controller.provenance.spec.ts && pnpm lint`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/contracts/src/index.ts apps/api/src/memory.controller.ts apps/api/src/memory.controller.provenance.spec.ts
git commit -m "feat(api): expose fact provenance and supersession chain"
```

### Task E2: digest 选择日志查询端点

**Files:**
- Modify: `apps/api/src/memory.controller.ts`
- Test: `apps/api/src/memory.controller.provenance.spec.ts`

**Interfaces:**
- Produces: `GET /v1/memory/digest/:digestId/selection` → `{ rationale, drops }`

- [ ] **Step 1: 写失败测试**

```ts
// 追加到 apps/api/src/memory.controller.provenance.spec.ts
import { normalizeSelectionLog } from "./memory.controller";

describe("normalizeSelectionLog", () => {
  it("returns empty arrays when the digest predates the feature", () => {
    expect(normalizeSelectionLog(null)).toEqual({ rationale: [], drops: [] });
  });

  it("passes through a recorded log", () => {
    expect(normalizeSelectionLog({ rationale: ["selected_docs:2"], drops: [{ reason: "cap_evicted", detail: {} }] }))
      .toEqual({ rationale: ["selected_docs:2"], drops: [{ reason: "cap_evicted", detail: {} }] });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @statecore/api exec vitest run src/memory.controller.provenance.spec.ts`
Expected: FAIL — `normalizeSelectionLog` 未导出

- [ ] **Step 3: 实现**

```ts
export function normalizeSelectionLog(raw: unknown): { rationale: string[]; drops: unknown[] } {
  if (!raw || typeof raw !== "object") return { rationale: [], drops: [] };
  const r = raw as { rationale?: unknown; drops?: unknown };
  return {
    rationale: Array.isArray(r.rationale) ? r.rationale.filter((x): x is string => typeof x === "string") : [],
    drops: Array.isArray(r.drops) ? r.drops : []
  };
}
```

```ts
  @Get(["/memory/digest/:digestId/selection", "/v1/memory/digest/:digestId/selection"])
  async digestSelection(@Req() req: RequestWithUser, @Param("digestId") digestId: string) {
    const digest = await this.domain.getDigestForUser(req.userId, digestId);
    if (!digest) throw new NotFoundException("Digest not found");
    return normalizeSelectionLog((digest as { selectionLog?: unknown }).selectionLog ?? null);
  }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test:core && pnpm lint`
Expected: 全绿

- [ ] **Step 5: 提交**

```bash
git add apps/api/src/memory.controller.ts apps/api/src/memory.controller.provenance.spec.ts
git commit -m "feat(api): expose digest selection rationale and drop log"
```

---

## Self-Review 记录

- **Spec 覆盖**：底账第 1 条 → 阶段 B；第 2 条 → 阶段 C；第 3 条 → 阶段 D；第 4 条 → 阶段 A；可审计 API → 阶段 E；简历场景 identity cap → Task C3（`DIGEST_FACET_CAPS`）。
- **未覆盖且需单独决策**：`DIGEST_CHAR_BUDGET_TOTAL` 对文档的截断（底账 §5 已知限制之二）。该项涉及"文档是否应豁免字符预算"的产品判断，不在本计划内。
- **类型一致性**：`recordDrop` / `DropRecord` 贯穿 A1→A2→A3；`getFacetCap` 贯穿 B1→B2→B4→C2→C3；`retireFact` 贯穿 C1→C2；`FactRegistryEntry.retiredAt` 贯穿 C1→C2→D1→E1。
