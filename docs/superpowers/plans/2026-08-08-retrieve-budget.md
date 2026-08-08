# Retrieve 上下文预算参数 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 `POST /v1/memory/retrieve` 加一个可选的 `maxChars` 上下文预算,让 StateCore 在预算内装填 digest / 事实 / events 并交代砍掉了什么。

**Architecture:** 三层职责分离。`packages/core/src/retrieve-budget.ts` 是一个纯函数模块(无 I/O、无类、依赖全部由参数注入),负责排序与装填;`RetrieveService` 只新增一个把已有私有打分器暴露出来的公开方法;`apps/api` 的 controller 是唯一的接线处 —— 因为事实来自 `getLatestDigestState`、events 来自 `retrieveService.retrieve()`,它是两半汇合的地方。

**Tech Stack:** TypeScript · NestJS · zod · Vitest · pnpm + Turbo

## Global Constraints

以下取自 spec `docs/superpowers/specs/2026-08-08-retrieve-budget-design.md`,每个任务都隐含包含:

- `FACT_BUDGET_SHARE = 0.4`,是常数,**不做成请求参数**。
- 封顶基数是 `maxChars` **全额**:事实额度 = `min(Math.floor(maxChars * 0.4), 装完 digest 后的剩余)`。
- `dropped` 明细**三类合计**上限 **100** 条,按 digest → fact → event 顺序填;`droppedCounts` 永不截断。
- **不传 `maxChars` 时,响应必须与今天逐字节相同** —— 事实不排序、不截断,events 不变。
- 绝不切断一条事实或一个 event。整条装或不装。
- 装不下的条目**跳过并继续往后看**,不是遇到第一个装不下的就停。
- digest 是原子的:装不下就整个不装,记 `digest_too_large`。
- 本次**不做**事实的 embedding 重排,**不做**事件重新分块。
- `/v1` 是加性冻结契约(`docs/api.md:267`):新字段一律可选;snapshot 用 `pnpm --filter @statecore/api test -- public-v1-contract -u` 重新 bless。
- 语言:代码注释用英文(与仓库现状一致),注释解释"为什么"而非复述断言。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `packages/core/src/retrieve-budget.ts`(新) | 纯装填器:排序事实、按三条规则装填、产出 drop 报告。无 I/O,依赖注入。 |
| `packages/core/src/retrieve-budget.test.ts`(新) | 装填器的行为测试。 |
| `packages/core/src/index.ts`(改) | `RetrieveService` 新增公开方法 `scoreText`,把已有私有打分器暴露给 controller。 |
| `packages/contracts/src/index.ts`(改) | `RetrieveInput` 加 `maxChars?`;新增 `BudgetReportSchema`;`RetrieveOutput.retrieval` 加 `budget?`。 |
| `apps/api/src/memory.controller.ts`(改) | 接线:传了 `maxChars` 就调装填器,否则走今天的老路。 |
| `apps/api/src/__snapshots__/public-v1-contract.snapshot.test.ts.snap`(改) | 重新 bless。 |
| `docs/api.md`(改) | 文档。 |

任务顺序:Task 1(纯装填器,零依赖,可独立测)→ Task 2(契约 + 打分器暴露)→ Task 3(接线 + snapshot + 文档)。

---

### Task 1: 纯装填器 `retrieve-budget.ts`

这是整个改动的全部策略所在,且不依赖契约或 controller,所以先做、独立可测。

**Files:**
- Create: `packages/core/src/retrieve-budget.ts`
- Test: `packages/core/src/retrieve-budget.test.ts`

**Interfaces:**
- Consumes: 无(纯函数,零内部依赖)
- Produces:
  ```ts
  export const FACT_BUDGET_SHARE = 0.4;
  export const MAX_DROP_DETAIL_ITEMS = 100;

  export type BudgetDropReason = "budget_exhausted" | "fact_share_cap" | "digest_too_large";

  export interface BudgetDrop {
    kind: "digest" | "fact" | "event";
    id: string | null;
    chars: number;
    reason: BudgetDropReason;
    score?: number;
  }

  export interface BudgetReport {
    maxChars: number;
    usedChars: number;
    digestChars: number;
    factChars: number;
    eventChars: number;
    factShareCap: number;
    droppedCounts: { digest: number; fact: number; event: number };
    dropped: BudgetDrop[];
    itemsOmitted: number;
  }

  export interface BudgetFact { id: string; content: string; confidence: number; addedAt: string }
  export interface BudgetEvent { id: string; content: string }

  export interface PackInput<F extends BudgetFact, E extends BudgetEvent> {
    digest: string | null;
    facts: F[];
    events: E[];
    maxChars: number;
    /** Returns a relevance score for one text. Absent when the caller had no query. */
    scoreFact?: (content: string) => number;
  }

  export interface PackResult<F, E> { digest: string | null; facts: F[]; events: E[]; budget: BudgetReport }

  export function packWithinBudget<F extends BudgetFact, E extends BudgetEvent>(
    input: PackInput<F, E>
  ): PackResult<F, E>;

  export function rankFacts<F extends BudgetFact>(facts: F[], scoreFact?: (content: string) => number): F[];
  ```

- [ ] **Step 1: 写失败的测试**

创建 `packages/core/src/retrieve-budget.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  packWithinBudget,
  rankFacts,
  FACT_BUDGET_SHARE,
  MAX_DROP_DETAIL_ITEMS,
  type BudgetFact,
  type BudgetEvent
} from "./retrieve-budget";

function fact(id: string, content: string, confidence = 0.5, addedAt = "2026-01-01T00:00:00.000Z"): BudgetFact {
  return { id, content, confidence, addedAt };
}
function event(id: string, chars: number): BudgetEvent {
  // Distinguishable content so a test can tell which event a result carried.
  return { id, content: `${id}:${"x".repeat(Math.max(0, chars - id.length - 1))}` };
}
/** Counts the word "camera" — a stand-in for the real heuristic scorer. */
const cameraScorer = (content: string) => (content.match(/camera/g) ?? []).length;

describe("the budget packs whole items and says what it refused", () => {
  it("never cuts a fact in half", () => {
    // Half a fact is not a shortened fact, it is a false one: "Allergic to
    // penicillin" truncated at 12 chars reads "Allergic to". The rule is whole
    // items only, at every layer.
    const long = fact("f1", "x".repeat(400));
    const out = packWithinBudget({ digest: null, facts: [long], events: [], maxChars: 200 });
    expect(out.facts).toHaveLength(0);
    expect(out.budget.droppedCounts.fact).toBe(1);
  });

  it("never cuts an event in half", () => {
    const out = packWithinBudget({ digest: null, facts: [], events: [event("e1", 400)], maxChars: 200 });
    expect(out.events).toHaveLength(0);
    expect(out.budget.droppedCounts.event).toBe(1);
  });

  it("keeps looking after an item that does not fit", () => {
    // The defect this covers: the harness's build_prompt used `break`, so one
    // oversized item hid every smaller item ranked below it. That made the score
    // a function of item size rather than retrieval quality — measured at 70%
    // budget fill for StateCore while mem0, which returns short items, never hit
    // the wall at all.
    const out = packWithinBudget({
      digest: null,
      facts: [],
      events: [event("huge", 5000), event("small", 100)],
      maxChars: 1000
    });
    expect(out.events.map((e) => e.id)).toEqual(["small"]);
    expect(out.budget.droppedCounts.event).toBe(1);
  });

  it("drops the digest whole rather than truncating it", () => {
    // Half a summary is not a summary.
    const out = packWithinBudget({ digest: "d".repeat(500), facts: [], events: [], maxChars: 100 });
    expect(out.digest).toBeNull();
    expect(out.budget.dropped.map((d) => d.reason)).toContain("digest_too_large");
    expect(out.budget.droppedCounts.digest).toBe(1);
  });

  it("caps facts at the declared share so events always have room", () => {
    // A scope used for a year holds hundreds of facts. Without the cap they eat
    // the whole budget and the caller gets no raw evidence at all — the mirror
    // image of the 4k result, and just as bad.
    const facts = Array.from({ length: 300 }, (_, i) => fact(`f${i}`, "y".repeat(86)));
    const out = packWithinBudget({
      digest: null,
      facts,
      events: [event("e1", 1000)],
      maxChars: 16000
    });
    expect(out.budget.factChars).toBeLessThanOrEqual(Math.floor(16000 * FACT_BUDGET_SHARE));
    expect(out.events).toHaveLength(1);
    expect(out.budget.droppedCounts.fact).toBeGreaterThan(0);
    expect(out.budget.dropped.some((d) => d.reason === "fact_share_cap")).toBe(true);
  });

  it("does not invoke the cap when the facts already fit", () => {
    const facts = Array.from({ length: 5 }, (_, i) => fact(`f${i}`, "y".repeat(50)));
    const out = packWithinBudget({ digest: null, facts, events: [], maxChars: 16000 });
    expect(out.facts).toHaveLength(5);
    expect(out.budget.droppedCounts.fact).toBe(0);
  });

  it("accounts for every candidate: included plus dropped equals offered", () => {
    // The invariant that makes the report trustworthy. Anything that is neither
    // returned nor recorded has vanished silently, which is the exact defect
    // class this feature must not reintroduce.
    const facts = Array.from({ length: 40 }, (_, i) => fact(`f${i}`, "y".repeat(200)));
    const events = Array.from({ length: 40 }, (_, i) => event(`e${i}`, 500));
    const out = packWithinBudget({ digest: "d".repeat(100), facts, events, maxChars: 6000 });

    expect(out.facts.length + out.budget.droppedCounts.fact).toBe(40);
    expect(out.events.length + out.budget.droppedCounts.event).toBe(40);
    expect((out.digest ? 1 : 0) + out.budget.droppedCounts.digest).toBe(1);
  });

  it("never reports using more than the budget", () => {
    const facts = Array.from({ length: 40 }, (_, i) => fact(`f${i}`, "y".repeat(200)));
    const events = Array.from({ length: 40 }, (_, i) => event(`e${i}`, 500));
    const out = packWithinBudget({ digest: "d".repeat(100), facts, events, maxChars: 6000 });
    expect(out.budget.usedChars).toBeLessThanOrEqual(6000);
  });

  it("bounds the drop detail but says how much it bounded", () => {
    // A bounded report is not a silent one. The counts stay exact; only the
    // itemised list is capped, and the cap is stated.
    const facts = Array.from({ length: 400 }, (_, i) => fact(`f${i}`, "y".repeat(200)));
    const out = packWithinBudget({ digest: null, facts, events: [], maxChars: 1000 });
    expect(out.budget.dropped.length).toBe(MAX_DROP_DETAIL_ITEMS);
    expect(out.budget.droppedCounts.fact).toBe(400 - out.facts.length);
    expect(out.budget.itemsOmitted).toBe(out.budget.droppedCounts.fact - MAX_DROP_DETAIL_ITEMS);
  });

  it("reports zero omitted when every drop is itemised", () => {
    const out = packWithinBudget({ digest: null, facts: [], events: [event("e1", 5000)], maxChars: 100 });
    expect(out.budget.itemsOmitted).toBe(0);
    expect(out.budget.dropped).toHaveLength(1);
  });

  it("handles a scope with nothing in it", () => {
    // A new scope has no digest, no facts and no events. Empty is a legitimate
    // answer, not an error, and the report must still reconcile.
    const out = packWithinBudget({ digest: null, facts: [], events: [], maxChars: 4000 });
    expect(out.budget.usedChars).toBe(0);
    expect(out.budget.droppedCounts).toEqual({ digest: 0, fact: 0, event: 0 });
    expect(out.budget.dropped).toHaveLength(0);
    expect(out.budget.itemsOmitted).toBe(0);
  });

  it("never returns more events than it was offered", () => {
    // `limit` binds upstream: retrieve() already sliced its ranked events to
    // `limit` before the packer sees them, so the packer can only ever shrink
    // that list. This is the concrete meaning of "whichever binds first wins".
    const events = [event("e1", 10), event("e2", 10)];
    const out = packWithinBudget({ digest: null, facts: [], events, maxChars: 1_000_000 });
    expect(out.events).toHaveLength(2);
  });
});

describe("facts are ranked before they compete for the budget", () => {
  it("ranks by relevance when a scorer is given", () => {
    const facts = [
      fact("irrelevant", "Prefers oat milk"),
      fact("relevant", "Researching a trail camera, cellular and solar capable")
    ];
    expect(rankFacts(facts, cameraScorer).map((f) => f.id)).toEqual(["relevant", "irrelevant"]);
  });

  it("falls back to confidence then recency when there is no query", () => {
    // retrieve()'s query is optional. Without one there is no relevance signal,
    // and inventing one would be worse than admitting the fallback.
    const facts = [
      fact("old-sure", "a", 0.9, "2026-01-01T00:00:00.000Z"),
      fact("new-unsure", "b", 0.2, "2026-06-01T00:00:00.000Z"),
      fact("new-sure", "c", 0.9, "2026-06-01T00:00:00.000Z")
    ];
    expect(rankFacts(facts).map((f) => f.id)).toEqual(["new-sure", "old-sure", "new-unsure"]);
  });

  it("keeps the highest scoring facts when the cap binds", () => {
    const facts = [
      ...Array.from({ length: 50 }, (_, i) => fact(`dull${i}`, "y".repeat(86))),
      fact("hit", "camera ".repeat(12))
    ];
    const out = packWithinBudget({
      digest: null,
      facts,
      events: [],
      maxChars: 1000,
      scoreFact: cameraScorer
    });
    expect(out.facts.map((f) => f.id)).toContain("hit");
  });

  it("records the score on a drop so the refusal can be explained", () => {
    const facts = [
      fact("hit", "camera camera"),
      ...Array.from({ length: 50 }, (_, i) => fact(`dull${i}`, "y".repeat(200)))
    ];
    const out = packWithinBudget({ digest: null, facts, events: [], maxChars: 500, scoreFact: cameraScorer });
    const drop = out.budget.dropped.find((d) => d.kind === "fact");
    expect(drop?.score).toBe(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd packages/core && pnpm vitest run src/retrieve-budget.test.ts
```
Expected: FAIL — `Failed to resolve import "./retrieve-budget"`

- [ ] **Step 3: 实现装填器**

创建 `packages/core/src/retrieve-budget.ts`:

```ts
/**
 * Packs a retrieval into a caller-declared character budget.
 *
 * The n=200 budget-aligned LongMemEval run showed why this belongs in the
 * engine rather than in every caller: `POST /v1/memory/retrieve` took an item
 * count and no budget, so the "four whole sessions or twenty small units"
 * tradeoff — the one worth ten points at a 4k budget — was a decision only
 * StateCore could make and had no way to hear about. Callers filled the gap by
 * cutting on their own: the benchmark harness reimplemented it in eighty lines,
 * and assistant-backend simply took the first forty facts.
 *
 * Three rules carry the design:
 *
 * 1. Whole items only. Half a fact is not a shortened fact, it is a false one.
 * 2. An item that does not fit is skipped, and the fill continues. Stopping at
 *    the first oversized item makes the result a function of item size rather
 *    than of relevance.
 * 3. Everything refused is recorded. A response that quietly holds less than
 *    the caller asked for is the defect class this engine exists to remove.
 */

/** Facts may take at most this share of the budget, so raw evidence always fits. */
export const FACT_BUDGET_SHARE = 0.4;

/** Itemised drops are bounded; the counts never are. */
export const MAX_DROP_DETAIL_ITEMS = 100;

export type BudgetDropReason = "budget_exhausted" | "fact_share_cap" | "digest_too_large";

export interface BudgetDrop {
  kind: "digest" | "fact" | "event";
  id: string | null;
  chars: number;
  reason: BudgetDropReason;
  score?: number;
}

export interface BudgetReport {
  maxChars: number;
  usedChars: number;
  digestChars: number;
  factChars: number;
  eventChars: number;
  factShareCap: number;
  droppedCounts: { digest: number; fact: number; event: number };
  dropped: BudgetDrop[];
  itemsOmitted: number;
}

export interface BudgetFact {
  id: string;
  content: string;
  confidence: number;
  addedAt: string;
}

export interface BudgetEvent {
  id: string;
  content: string;
}

export interface PackInput<F extends BudgetFact, E extends BudgetEvent> {
  digest: string | null;
  facts: F[];
  events: E[];
  maxChars: number;
  /** Relevance score for one text. Absent when the caller supplied no query. */
  scoreFact?: (content: string) => number;
}

export interface PackResult<F, E> {
  digest: string | null;
  facts: F[];
  events: E[];
  budget: BudgetReport;
}

/**
 * Orders facts for budget competition.
 *
 * With a query, relevance leads. Without one there is no relevance signal, so
 * it falls back to confidence and then recency rather than inventing a ranking
 * that would look authoritative and mean nothing.
 */
export function rankFacts<F extends BudgetFact>(
  facts: F[],
  scoreFact?: (content: string) => number
): F[] {
  const scored = facts.map((fact) => ({
    fact,
    score: scoreFact ? scoreFact(fact.content) : 0
  }));
  scored.sort((a, b) => {
    if (scoreFact && b.score !== a.score) return b.score - a.score;
    if (b.fact.confidence !== a.fact.confidence) return b.fact.confidence - a.fact.confidence;
    return b.fact.addedAt.localeCompare(a.fact.addedAt);
  });
  return scored.map((entry) => entry.fact);
}

export function packWithinBudget<F extends BudgetFact, E extends BudgetEvent>(
  input: PackInput<F, E>
): PackResult<F, E> {
  const { digest, facts, events, maxChars, scoreFact } = input;

  const droppedCounts = { digest: 0, fact: 0, event: 0 };
  const dropped: BudgetDrop[] = [];
  let itemsOmitted = 0;

  // The detail list is bounded, the counts are not. Every drop increments the
  // count; only the first MAX_DROP_DETAIL_ITEMS get an entry, and the remainder
  // is stated rather than lost.
  const record = (drop: BudgetDrop) => {
    droppedCounts[drop.kind] += 1;
    if (dropped.length < MAX_DROP_DETAIL_ITEMS) dropped.push(drop);
    else itemsOmitted += 1;
  };

  let remaining = maxChars;

  // 1. Digest, atomic.
  let keptDigest: string | null = null;
  let digestChars = 0;
  if (digest) {
    if (digest.length <= remaining) {
      keptDigest = digest;
      digestChars = digest.length;
      remaining -= digestChars;
    } else {
      record({ kind: "digest", id: null, chars: digest.length, reason: "digest_too_large" });
    }
  }

  // 2. Facts, capped at a share of the WHOLE budget so the cap is a promise the
  //    caller can verify, then bounded again by what the digest left behind.
  const factShareCap = Math.floor(maxChars * FACT_BUDGET_SHARE);
  let factAllowance = Math.min(factShareCap, remaining);
  const ranked = rankFacts(facts, scoreFact);
  const keptFacts: F[] = [];
  let factChars = 0;
  for (const fact of ranked) {
    const cost = fact.content.length;
    if (cost <= factAllowance) {
      keptFacts.push(fact);
      factAllowance -= cost;
      factChars += cost;
      continue;
    }
    // Distinguishing the two reasons is the point of the report: hitting the cap
    // means the caller could raise the share, running out means raise the budget.
    const reason: BudgetDropReason =
      factChars + cost > factShareCap ? "fact_share_cap" : "budget_exhausted";
    record({
      kind: "fact",
      id: fact.id,
      chars: cost,
      reason,
      ...(scoreFact ? { score: scoreFact(fact.content) } : {})
    });
  }
  remaining -= factChars;

  // 3. Events take whatever is left, in the order retrieve() ranked them.
  const keptEvents: E[] = [];
  let eventChars = 0;
  for (const event of events) {
    const cost = event.content.length;
    if (cost <= remaining) {
      keptEvents.push(event);
      remaining -= cost;
      eventChars += cost;
      continue;
    }
    record({ kind: "event", id: event.id, chars: cost, reason: "budget_exhausted" });
  }

  return {
    digest: keptDigest,
    facts: keptFacts,
    events: keptEvents,
    budget: {
      maxChars,
      usedChars: digestChars + factChars + eventChars,
      digestChars,
      factChars,
      eventChars,
      factShareCap,
      droppedCounts,
      dropped,
      itemsOmitted
    }
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd packages/core && pnpm vitest run src/retrieve-budget.test.ts
```
Expected: PASS,15 个测试全绿。

- [ ] **Step 5: 从 core 的 barrel 导出**

`packages/core/src/index.ts` 顶部是一串**具名导出块**(`export { A, type B } from "./xxx";`,约 4–60 行),不是 `export *`。照这个风格在该串的末尾追加:

```ts
export {
  packWithinBudget,
  rankFacts,
  FACT_BUDGET_SHARE,
  MAX_DROP_DETAIL_ITEMS,
  type BudgetDrop,
  type BudgetDropReason,
  type BudgetReport,
  type BudgetFact,
  type BudgetEvent,
  type PackInput,
  type PackResult
} from "./retrieve-budget";
```

- [ ] **Step 6: 跑 core 全量测试 + 类型检查**

```bash
pnpm --filter @statecore/core test
pnpm --filter @statecore/core lint
```
Expected: 全绿,无新增 lint 错误。

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/retrieve-budget.ts packages/core/src/retrieve-budget.test.ts packages/core/src/index.ts
git commit -m "feat(core): pack a retrieval into a caller-declared character budget"
```

---

### Task 2: 契约字段 + 暴露打分器

**Files:**
- Modify: `packages/contracts/src/index.ts`(`RetrieveInput` 约 123 行、`RetrieveOutput` 约 131 行)
- Modify: `packages/core/src/index.ts`(`RetrieveService`,约 293–340 行)
- Test: `packages/core/src/retrieve-score-text.test.ts`(新)

**Interfaces:**
- Consumes: Task 1 的 `BudgetReport` 形状(字段名逐一对应)
- Produces:
  - `RetrieveInput.maxChars?: number`(正整数)
  - `RetrieveOutput.retrieval.budget?: BudgetReportSchema`
  - `RetrieveService.scoreText(query: string, content: string): number` —— 公开方法

- [ ] **Step 1: 写失败的测试**

创建 `packages/core/src/retrieve-score-text.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { RetrieveService } from "./index";

// The packer needs a relevance score for facts, but the scorer lives as a
// private method on the service. Exposing one narrow public method is smaller
// than duplicating the tokenizer and its alias table into a second place, where
// the two would drift apart.
describe("RetrieveService.scoreText", () => {
  const service = new RetrieveService({} as never, {} as never, {} as never);

  it("scores a matching text above a non-matching one", () => {
    const hit = service.scoreText("trail camera", "Researching a trail camera, solar capable");
    const miss = service.scoreText("trail camera", "Prefers oat milk in coffee");
    expect(hit).toBeGreaterThan(miss);
  });

  it("returns a finite number for an empty query rather than throwing", () => {
    expect(Number.isFinite(service.scoreText("", "anything"))).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd packages/core && pnpm vitest run src/retrieve-score-text.test.ts
```
Expected: FAIL — `service.scoreText is not a function`

> 若构造函数参数个数与 `{} as never` 三个不符,读 `packages/core/src/index.ts:293` 处的 `constructor` 并按实际参数补齐 `{} as never`;`scoreText` 不触碰这些依赖。

- [ ] **Step 3: 加公开方法**

在 `packages/core/src/index.ts` 的 `private scoreByQuery(...)` 之前插入:

```ts
  /**
   * Relevance of one text to a query, on the same scale events are ranked by.
   *
   * Facts are ranked for the context budget outside this class, and the scorer
   * they need is this one. Exposing it beats copying the tokenizer and the
   * alias table into a second implementation that would drift.
   */
  scoreText(query: string, content: string): number {
    return this.scoreByQuery(query, content);
  }
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd packages/core && pnpm vitest run src/retrieve-score-text.test.ts
```
Expected: PASS

- [ ] **Step 5: 加契约字段**

在 `packages/contracts/src/index.ts` 中,`RetrieveInput` 改为:

```ts
export const RetrieveInput = z.object({
  scopeId: z.string().uuid(),
  query: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  // Optional by contract rule: /v1 is an additively-compatible freeze, so a new
  // field is never required. Absent means "behave exactly as before".
  maxChars: z.number().int().positive().optional()
});
```

在 `RetrieveOutput` 之前插入:

```ts
export const BudgetDropSchema = z.object({
  kind: z.enum(["digest", "fact", "event"]),
  id: z.string().nullable(),
  chars: z.number().int().min(0),
  reason: z.enum(["budget_exhausted", "fact_share_cap", "digest_too_large"]),
  score: z.number().optional()
});

export const BudgetReportSchema = z.object({
  maxChars: z.number().int().min(0),
  usedChars: z.number().int().min(0),
  digestChars: z.number().int().min(0),
  factChars: z.number().int().min(0),
  eventChars: z.number().int().min(0),
  factShareCap: z.number().int().min(0),
  // Counts are exact and never truncated; `dropped` is the bounded detail.
  droppedCounts: z.object({
    digest: z.number().int().min(0),
    fact: z.number().int().min(0),
    event: z.number().int().min(0)
  }),
  dropped: z.array(BudgetDropSchema),
  itemsOmitted: z.number().int().min(0)
});
```

在 `RetrieveOutput` 的 `retrieval` 对象里,`matches` 之后追加一行:

```ts
    budget: BudgetReportSchema.optional()
```

- [ ] **Step 6: 跑 contracts 与 core 测试**

```bash
pnpm --filter @statecore/contracts test
pnpm --filter @statecore/core test
```
Expected: 全绿。`apps/api` 的 snapshot 测试此时**预期会红**(契约面变了),留到 Task 3 一并 bless。

- [ ] **Step 7: Commit**

```bash
git add packages/contracts/src/index.ts packages/core/src/index.ts packages/core/src/retrieve-score-text.test.ts
git commit -m "feat(contracts): add optional maxChars and a budget report to retrieve"
```

---

### Task 3: 接线 controller + bless snapshot + 文档

**Files:**
- Modify: `apps/api/src/memory.controller.ts:856-879`(`retrieve` handler)
- Modify: `apps/api/src/__snapshots__/public-v1-contract.snapshot.test.ts.snap`
- Modify: `docs/api.md`(retrieve 段落)
- Test: `apps/api/src/test/retrieve-budget.integration.test.ts`(新)

**Interfaces:**
- Consumes: Task 1 的 `packWithinBudget`、`FACT_BUDGET_SHARE`;Task 2 的 `RetrieveInput.maxChars`、`RetrieveService.scoreText`
- Produces: 无(终点任务)

- [ ] **Step 1: 写失败的测试**

这一层必须走真实的 HTTP 路径 —— 只校验 schema 的测试在 controller 改动前就会通过,挡不住任何东西。照抄 `apps/api/src/test/retrieve-no-query.integration.test.ts` 的搭法。

创建 `apps/api/src/test/retrieve-budget.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { createTestApp } from "./setup";
import { clearDatabase } from "./helpers";

const USER = "retrieve-budget-user";

describe("POST /memory/retrieve with maxChars", () => {
  let app: INestApplication;
  beforeAll(async () => { app = await createTestApp(); }, 30000);
  beforeEach(async () => { await clearDatabase(); });
  afterAll(async () => { await app.close(); });

  async function seedScope(): Promise<string> {
    const scopeRes = await request(app.getHttpServer())
      .post("/scopes").set("x-user-id", USER).send({ name: "s" });
    expect(scopeRes.status).toBe(201);
    const scopeId = scopeRes.body.id as string;

    // Six events of 400 chars each: more than a 1000-char budget can hold, so
    // the packer has to refuse some and say so.
    for (let i = 0; i < 6; i += 1) {
      await request(app.getHttpServer())
        .post("/memory/events").set("x-user-id", USER)
        .send({ scopeId, type: "stream", source: "api", content: `event ${i} ${"x".repeat(390)}` });
    }
    return scopeId;
  }

  it("stays within the budget and reports what it dropped", async () => {
    const scopeId = await seedScope();
    const res = await request(app.getHttpServer())
      .post("/memory/retrieve").set("x-user-id", USER)
      .send({ scopeId, query: "event", limit: 10, maxChars: 1000 });

    expect(res.status).toBe(201);
    const budget = res.body.retrieval.budget;
    expect(budget).toBeDefined();
    expect(budget.maxChars).toBe(1000);
    expect(budget.usedChars).toBeLessThanOrEqual(1000);
    // Six events were offered; each returned or dropped event is accounted for.
    expect(res.body.events.length + budget.droppedCounts.event).toBe(6);
    expect(budget.droppedCounts.event).toBeGreaterThan(0);
  });

  it("omits the budget and returns everything when maxChars is absent", async () => {
    // The compatibility guarantee: a caller that never heard of this feature
    // must see exactly what it saw before the feature existed.
    const scopeId = await seedScope();
    const res = await request(app.getHttpServer())
      .post("/memory/retrieve").set("x-user-id", USER)
      .send({ scopeId, query: "event", limit: 10 });

    expect(res.status).toBe(201);
    expect(res.body.retrieval.budget).toBeUndefined();
    expect(res.body.events).toHaveLength(6);
  });

  it("rejects a non-positive maxChars rather than silently ignoring it", async () => {
    const scopeId = await seedScope();
    const res = await request(app.getHttpServer())
      .post("/memory/retrieve").set("x-user-id", USER)
      .send({ scopeId, query: "event", maxChars: 0 });

    expect(res.status).toBe(400);
  });

  it("applies limit and maxChars together, whichever binds first", async () => {
    // limit binds upstream, inside retrieve(); maxChars binds after. With a
    // budget large enough for everything, limit is what shows.
    const scopeId = await seedScope();
    const res = await request(app.getHttpServer())
      .post("/memory/retrieve").set("x-user-id", USER)
      .send({ scopeId, query: "event", limit: 2, maxChars: 1_000_000 });

    expect(res.status).toBe(201);
    expect(res.body.events).toHaveLength(2);
    expect(res.body.retrieval.budget.droppedCounts.event).toBe(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @statecore/api test -- retrieve-budget.integration
```
Expected: FAIL — 第一个用例在 `expect(budget).toBeDefined()` 处失败,因为 controller 还没接线,`retrieval.budget` 是 `undefined`。(第二个用例此时会通过 —— 它断言的正是尚未改变的现状。)

> 若 `createTestApp()` 需要数据库而本机没起,按 `apps/api/src/test/setup.ts` 顶部的说明先起 Postgres;这批测试与 `retrieve-no-query.integration.test.ts` 依赖完全相同。

- [ ] **Step 3: 接线 controller**

在 `apps/api/src/memory.controller.ts` 顶部的 `@statecore/core` import 里加入 `packWithinBudget`。

把 `retrieve` handler(约 856 行)替换为:

```ts
  @Post(["/memory/retrieve", "/v1/memory/retrieve"])
  async retrieve(@Req() req: RequestWithUser, @Body() body: unknown) {
    const input = RetrieveInput.parse(body);
    const scope = await this.domain.projectService.getScope(req.userId, input.scopeId);
    if (!scope) {
      throw new NotFoundException("Scope not found");
    }
    const limit = input.limit ?? 20;
    const [result, snapshot] = await Promise.all([
      this.domain.retrieveService.retrieve(input.scopeId, limit, input.query),
      this.domain.getLatestDigestState(input.scopeId)
    ]);
    const activeFactRegistry = snapshot ? getActiveFactRegistry(snapshot.state) : [];
    const digest = result.digest ? result.digest.summary : null;
    const events = result.events.map((event) => ({
      id: event.id,
      content: event.content,
      createdAt: event.createdAt.toISOString()
    }));

    // Without a budget the response must be byte-identical to what callers got
    // before this feature existed — same fact order, same count, same events.
    if (input.maxChars === undefined) {
      return parseOutput(RetrieveOutput, {
        digest,
        events,
        factRegistry: activeFactRegistry,
        retrieval: result.retrieval
      });
    }

    const query = input.query?.trim();
    const packed = packWithinBudget({
      digest,
      facts: activeFactRegistry,
      events,
      maxChars: input.maxChars,
      // No query means no relevance signal; the packer falls back to confidence
      // and recency rather than pretending to rank by relevance.
      scoreFact: query
        ? (content: string) => this.domain.retrieveService.scoreText(query, content)
        : undefined
    });

    return parseOutput(RetrieveOutput, {
      digest: packed.digest,
      events: packed.events,
      factRegistry: packed.facts,
      retrieval: { ...result.retrieval, budget: packed.budget }
    });
  }
```

- [ ] **Step 4: 跑接线测试确认通过**

```bash
pnpm --filter @statecore/api test -- retrieve-budget.integration
```
Expected: PASS,4 个用例全绿。

- [ ] **Step 5: 重新 bless 冻结 snapshot**

```bash
pnpm --filter @statecore/api test -- public-v1-contract -u
```

然后**人工检查 diff**,确认它只是加性的:

```bash
git diff apps/api/src/__snapshots__/public-v1-contract.snapshot.test.ts.snap
```

Expected: 只出现新增 —— `RetrieveInput` 多一个可选 `maxChars`,`RetrieveOutput` 里 `retrieval` 多一个可选 `budget`。**若 diff 里出现任何字段被删除、改名、改类型,或新字段进了 `required` 数组,停下**:那是破坏性变更,`docs/api.md:267` 禁止在 `/v1` 下发布。端点数量断言仍应是 15。

- [ ] **Step 6: 跑全量测试**

```bash
pnpm test
pnpm lint
```
Expected: 全绿。

- [ ] **Step 7: 写文档**

在 `docs/api.md` 的 `POST /v1/memory/retrieve` 段落补入:

```markdown
`maxChars`(可选,正整数)声明本次调用愿意在记忆上花费的字符预算。传了它,
StateCore 会在预算内装填并在 `retrieval.budget` 里交代砍掉了什么;不传则行为
与本字段引入前完全一致。

装填顺序是 digest → 事实 → events。digest 是原子的(装不下就整个不装)。事实
最多占 `maxChars` 的 40%,以保证原始证据总有位置;这个比例是常数,不可通过请求
调整。条目一律整条装入,装不下的会被跳过,但装填不会就此停止 —— 排在后面的较小
条目仍有机会进入。

事实的排序只在传了 `maxChars` 时发生:有 `query` 时按相关性,无 `query` 时按
confidence 再按新近度。

`retrieval.budget.droppedCounts` 永远是精确计数;`retrieval.budget.dropped`
是上限 100 条的明细,被略去的条数写在 `itemsOmitted`。

预算以**字符**而非 token 计:token 数是模型特定的,StateCore 不假装知道调用方
用的是哪个 tokenizer。
```

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/memory.controller.ts apps/api/src/test/retrieve-budget.integration.test.ts \
        apps/api/src/__snapshots__/public-v1-contract.snapshot.test.ts.snap docs/api.md
git commit -m "feat(api): honour a maxChars budget on retrieve and report what it dropped"
```

---

## 验收

三个任务完成后应满足:

1. `pnpm test` 与 `pnpm lint` 全绿。
2. 不传 `maxChars` 的调用,响应与本变更前一致(由 Task 3 的第二个接线测试与 Task 1 的兼容性约束共同保证)。
3. 冻结 snapshot 的 diff 纯加性,端点数仍为 15。
4. `docs/api.md` 写明了预算语义、40% 封顶不可调、以及为何用字符而非 token。

**明确不在验收范围内:** benchmark 4k 那 10 分。那个差距来自摄入粒度(harness 用 `--granularity session` 把整个会话作为一条事件写入),本变更做的是预算内的选择与报告,不重新分块 —— 见 spec 第 2 节。
