# 遗忘事实在 digest 中持久剪除（Forget-Prune-Digest）

> 记于 2026-06-26 ｜ 引擎层设计。让「遗忘」一条事实**真正生效**——不只是从记忆屏列表隐藏，而是从 digest 的结转状态 + summary 里彻底剪除，使其不再影响助手。
> 选定方案：**剪枝（不引入 provenance、不改 profile 数据结构、不迁移、不深动冻结的 digest 合并/生成算法）**。

## 背景：当前「遗忘」为什么不够

`forgetFact`（`apps/api/src/memory-facts.service.ts:10-32`）做两件事：① 写 `ForgottenFact(scopeId, factKey)`；② **仅当**该事实有 `evidenceId`（factRegistry 类）时把源 `MemoryEvent.suppressedAt` 标记掉。

问题：**没有任何路径把被遗忘的事实从 digest 的结转状态里移除**。

- digest 每轮把上一轮的 `state`（含 `state.profile` 各 facet 的字符串数组 + `state.factRegistry`）**结转**进 `protectedStateMerge`，所以一条事实一旦进了 state 就**一直在**，与是否还有新事件强化无关。
- summary 由 `generateDigestStage2`（`packages/core/src/digest-control.ts:2025-2235`）把整个 `state` JSON（`formatProtectedState`）喂给 LLM 生成 → **state 里的被遗忘事实会持续出现在 summary**。而 Remi 的 `buildContext` 正是吃 summary。

所以这是**持久泄漏**，对两类都成立：
- **裸 profile 事实**（`ongoing/relationships/followUps/style`，`PROFILE_FACET_ROUTING` 中非 writeProtected）：无 evidenceId，连源事件都压不掉，且结转不除。
- **有证据 profile 事实**（`identity/goals`，writeProtected → 有 factRegistry 条目 + evidenceId）：事件被压制只是**不再强化**，但 factRegistry 条目 + profile 值仍被结转，仍进 summary。

原始事件经 retrieve 的残留（`memoryRepo.listRecent`，`domain.service.ts:96`，已按 `suppressedAt:null` 过滤）属**短暂**渠道——随 lookback 窗口自然老化滚出，方案 1 接受之。

## 设计：digest 生成前剪除被遗忘事实

### 1. 纯函数 `pruneForgottenFacts`（`packages/core`）

新增纯函数，放 **`packages/core/src/memory-facts.ts`**（它已 import `DigestState` 并定义了 `computeFactKey`/`factToGroup`/`getActiveFactRegistry` 用法，无新增循环依赖）：
```
pruneForgottenFacts(state: DigestState, forgottenFactKeys: ReadonlySet<string>): void  // 原地修改 state（与 mergeProfileFacets 一致，返回 void）
```
逻辑：
- 对 `state.profile` 每个 facet 的每个值 `v`：`group = factToGroup(facet)`；若 `group != null && forgottenFactKeys.has(computeFactKey(group, v))` → 从该 facet 数组移除。
- 对 `state.factRegistry` 每个条目 `e`（有 `facet` 的 profile 类）：`group = factToGroup(e.facet)`；若 `group != null && forgottenFactKeys.has(computeFactKey(group, e.content))` → 移除该条目。
- key 计算与 forget/展示路径**完全一致**（`computeFactKey(factToGroup(facet), content)`，见 `memory-facts.ts:29` + `factToGroup`），天然对齐；只有 profile 类会命中（记忆屏本就只对 profile 类发 ForgottenFact）。
- 空集 → no-op。

### 2. 接入 `runDigestControlPipeline`（加性、向后兼容）

- `runDigestControlPipeline(...)` 增加**可选参数** `forgottenFactKeys?: ReadonlySet<string>`（默认 `undefined`/空集 → **行为与今天逐字一致**）。
- 在 `protectedStateMerge` 产出合并后 state **之后**、`generateDigestStage2` **之前**（探查确认的切入点，`digest-control.ts:~2197-2205`）调用 `pruneForgottenFacts(state, forgottenFactKeys)`。
- 这样：summary 从**已剪枝**的 state 生成（干净）；写入快照的 state 也已剪枝（不再结转被遗忘事实）。
- **不改 `protectedStateMerge` / `mergeProfileFacets` / `generateDigestStage2` 的算法本身**，只在两步之间插一个加性过滤。

### 3. worker 加载 keys 并传入（`apps/worker/src/main.ts`）

digest job 处理时（`main.ts:218-289`，事件查询附近）：
```
const forgotten = await prisma.forgottenFact.findMany({ where: { scopeId: data.scopeId }, select: { factKey: true } });
const forgottenFactKeys = new Set(forgotten.map(f => f.factKey));
```
传入 `runDigestControlPipeline(..., forgottenFactKeys)`。worker 已 import `prisma`；多一次轻查询。

### 4. 效果

- **持久泄漏（结转 state + summary）彻底消除**，对裸 + 有证据 profile 事实统一生效。每轮 digest 都用持久的 `ForgottenFact` 集重新剪枝 → 永久保持剪除。
- 原始事件短暂残留随窗口自愈（已接受）。
- 既有的 evidence 事件压制（forget 时）保留——对有证据事实额外关掉强化与原始事件渠道。

## 边界 / 不做

- **不引入 provenance**、不改 `DigestState.profile` 结构（仍 `string[]`）、不迁移旧快照。
- 不改 digest 合并/选择/生成算法；只加一个剪枝步骤 + 一个可选参数。
- 措辞改写边：若未来 digest 把某事实换了说法（factKey 变）→ 可能复现。与原记忆屏设计同一个已接受的边，v1 不处理。
- 无 schema 改动 → **无迁移**；不动 `/v1` 契约 / OpenAPI 快照（纯内部 digest 行为）。

## 测试

- `pruneForgottenFacts` 纯函数单测：含/不含被遗忘 key 的 profile 值 + factRegistry 条目；identity（factToGroup→null）等不被误删；空集 no-op；非 profile 内容不命中。
- pipeline 测试：`runDigestControlPipeline` 带 `forgottenFactKeys` → 产出 state + summary 不含该事实；**不带 → 与现有行为逐字一致**（保护现有 digest-control 测试不回归）。
- worker：加载 ForgottenFact keys + 传入（mirror 现有 worker 测试风格 / 真库集成）。
- 既有 `digest-control` 测试套件全绿（向后兼容验证）。

## 验证后

引擎层：单测绿 → `pnpm --filter @statecore/{core,worker} build` → push → 部署 **Droplet 1**（无迁移；重建 worker——它跑 digest；api 不变但可一并重建）。
