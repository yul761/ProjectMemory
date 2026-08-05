# 核心现状底账 — 2026-08-05

重新设计前的事实清单。**只记录已在代码中核实的内容**，不含改进方案。
行号对应 2026-08-05 当天的 `main`。

起因：LongMemEval 对比测试（StateCore 88.0% vs mem0 55.5%）经核查为无效结果——
`--granularity session --top-k 50` 撞上语料本身只有约 50 个 session，检索退化为全量返回，
喂给答题模型的 prompt 达到整个语料的 1.44 倍。分数来自 gpt-5 通读全文，记忆层未进入因果链。
排查该问题时连带发现了以下核心设计事实。

---

## 0. 跨条目结论

### 0.1 下游几乎零耦合

| 消费方 | 对分面/事实结构的依赖 |
|---|---|
| `statecore-cloud/apps/console/src/lib/api.ts:154` | `factRegistry: z.array(z.unknown())`，注释明写「NOT in the frozen contract — keep permissive」 |
| `assistant-backend/src/memory/statecore.client.ts:78` | 仅按字符串数组读取 |
| `remi-ios` | 零引用 |
| `packages/contracts/src/index.ts:133` | `facet: z.string().optional()` — 开放 |

**分面本体论从未进入冻结契约。** 下述所有改动的爆炸半径收敛在
`packages/core` + `packages/prompts` + `apps/worker` + `apps/api` 内部。

### 0.2 同一套本体论有 5 份不同步的副本

| 位置 | 形状 | 作用 |
|---|---|---|
| `core/src/digest-control.ts:1229` `DISPLAY_FACETS` | `Set` of 7 | 准入闸门 |
| `core/src/digest-control.ts:1230` `PROFILE_FACET_CAPS` | 7 → 数字 | 容量上限 |
| `core/src/digest-control.ts:1153` `PROFILE_FACET_ROUTING` | 7 种 delta kind → `{facet, cap, writeProtected}` | 路由 + 保护标记 |
| `core/src/memory-facts.ts:14` `FACET_TO_GROUP` | 6 → 5 个展示组 | 展示分组 |
| `core/src/facet-consolidation.ts:127` `CONSOLIDATION_DISPLAY_FACETS` + `FACET_DESCRIPTIONS` | 数组 + 描述 | 合并 |

外加 `packages/prompts/src/index.ts:8-16`：整套分面语义（含中文示例）内嵌在 stage2 系统提示中。

### 0.3 审计数据已计算，但被丢弃

`digest-control.ts` 全程向 `rationale` 记录选择与丢弃原因
（`dedup_near:`、`selected_docs:`、`selected_stream:`、`[truncated for digest budget]`）。

去向：`apps/worker/src/main.ts:350` 一行 `logger.info(..., "Digest debug details")`。

`apps/worker/src/digest-write.ts` 落库的是 `summary / changes / state / consistency`——
**`rationale` 不落库，API 不可见。**

---

## 1. 分面开放化

### 现状

```ts
// digest-control.ts:1229
const DISPLAY_FACETS = new Set(["identity","style","goals","relationships","followUps","ongoing","notes"]);

// digest-control.ts:1252
if (!value || !DISPLAY_FACETS.has(facet)) continue;   // 非白名单分面静默丢弃
```

Zod schema 层开放（`digest-control.ts:169` `facet: z.string()`），LLM 可以抽出任意分面，
丢弃发生在下游。提示词中的示例为个人生活场景（减肥、妈妈住在上海、盲盒生意、看牙医）。

另一处同类丢弃：`memory-facts.ts:47` `flattenScopeFacts` 中
`const group = ...; if (!group) continue;` — 不在 `FACET_TO_GROUP` 的分面不进展示层。

### 影响面

0.2 表中 5 处 + 提示词 + `digest-control.test.ts` 中约 100 处分面引用（该文件 4600+ 行）。

### 改动量：大

非配置项修改，需引入新概念（分面 schema 注册表：声明方式、生效时机、迁移路径）。
核心难点：已落库的 `DigestState.profile` 以分面名为对象 key，开放化必然涉及存量数据迁移。

### 依赖关系

**会改变第 2、3 条的形状**（容量按分面定义，保护标记按分面路由）。先做 2 或 3 有返工风险。

---

## 2. 容量与淘汰

### 现状

```ts
// digest-control.ts:1230
identity:15, relationships:10, ongoing:8, goals:8, followUps:10, style:6, notes:30
```

**硬上限合计 87 条。** 淘汰逻辑两处：

- `digest-control.ts:1206-1217` `mergeProfileFacets`：满则 `splice(0,1)` 淘汰最旧；
  若该分面全为保护事实，则 `continue` **丢弃新进事实**
- `digest-control.ts:1345` `addNoteFact`：notes 满则淘汰最旧

### 与审计机制冲突

`getActiveFactRegistry`（`:1090`）按 `supersededBy` 过滤，被取代的事实**保留在 state 中**，
审计链完整。但容量淘汰走的是另一条路径：

```ts
// digest-control.ts:1345 附近
if (ri !== -1) state.factRegistry.splice(ri, 1);   // 硬删除，非 supersede
```

**容量淘汰绕过 supersession，直接抹除记录。** 与 supersession 的设计意图冲突。

### 输入侧闸门

`apps/worker/src/env.ts:160-161`：
- `DIGEST_EVENT_BUDGET_TOTAL` 默认 **40**
- `DIGEST_CHAR_BUDGET_TOTAL` 默认 **240_000**

超限时 `applyCharBudget` 截断并打 `[truncated for digest budget]` 标记；
`digest_ok` 仍为 true，调用方无感知。

**文档类事件受保护**：`digest-control.ts:726` `docSelected` 得分固定为 1 且排在数组首位，
`.slice(0, eventBudgetTotal)` 优先保留文档。

### 改动量：中

硬删除改 supersede + 上限可配置 = 小改动。
「87 换成什么策略」是设计问题，取决于第 1 条。

---

## 3. 不漂移 vs 不遗忘

### 现状缺口

`core/src/drift-metrics.ts` 观测对象为
`stableFacts.decisions` / `stableFacts.constraints` / `stableFacts.goal` / `todos`。

**未观测 `profile` 分面，未观测 `factRegistry`。**

即：用户事实实际存放的位置，漂移指标看不到。`stabilityScore` 无法支撑「不漂移」主张。

管道本身是通的——`apps/worker/src/main.ts:497` 将 `driftMetrics` 写入 job 记录。缺的是被测对象。

### 取舍点定位

```ts
// digest-control.ts:1210-1213
if (writeProtected) {
  const unprotectedIdx = facetFacts.findIndex((fact) => !isProtectedInFacet(facet, fact));
  if (unprotectedIdx === -1) continue;   // ← 全为保护事实时，丢弃新事实
  facetFacts.splice(unprotectedIdx, 1);
}
```

**「不漂移」与「不遗忘」的冲突在此被解决，方向是保旧弃新，不可配置、不可观测。**

### 改动量：小到中

扩展 drift 指标覆盖 profile/factRegistry 为独立小改动。
取舍策略可配置化依赖第 1、2 条。

---

## 4. 静默丢弃的可观测化

### 丢弃点清单

| 丢弃点 | 位置 | 已记入 rationale |
|---|---|---|
| 240k 字符截断 | `applyCharBudget` | ✅ 截断标记 |
| 40 事件数闸门 | `digest-control.ts:728` | ✅ `selected_*` |
| 近重复去重 (jaccard ≥ 0.92) | `digest-control.ts:~600` | ✅ `dedup_near:` |
| 非白名单分面丢弃 | `digest-control.ts:1252` | ❌ |
| 分面容量淘汰 | `digest-control.ts:1206`, `:1345` | ❌ |
| 保护满时丢弃新事实 | `digest-control.ts:1212` | ❌ |
| 展示层无 group 丢弃 | `memory-facts.ts:47` | ❌ |
| 合并阶段非白名单跳过 | `facet-consolidation.ts:133` | ❌ |

### 改动量：小，价值/成本比最高

补 4 处 `rationale.push` + `rationale` 落库 + digest/retrieve 输出开字段。
**不依赖其他三条。**

附带收益：完成后可得到真实丢弃率数据，使第 1 条的设计决策有据可依。

---

## 5. 简历场景（产品原始动机）的实现路径

原始动机：上传简历 → 一个半月后再次请求 → 模型遗忘或给出错误信息。

该路径在代码中是**被专门加固过的**，逐项核实如下：

| 机制 | 位置 | 效果 |
|---|---|---|
| 文档类型 + 按 key upsert | `digest-control.ts:613` `latestDocumentsByKey` | 重传简历替换而非堆积 |
| 文档在选择阶段优先 | `:726` `score: 1`，排在数组首位 | 不被 40 条事件闸门挤掉 |
| `identity` 写保护 | `:1154` `writeProtected: true` | 聊天内容无法覆盖文档来源事实 |
| 文档权威更高 | `:1259` `authority = 0.85`（对话为 0.6） | 冲突时文档胜出 |
| `identity` 免于淘汰 | `:1290` `if (facet === "identity") continue` | 不因容量被驱逐 |
| 证据引用 | `:1257` `docEvidence` | 每条事实可回溯到源文档 |
| 进入检索输出 | `memory.controller.ts:717` `getActiveFactRegistry` | 无分组过滤，identity 可达 |

**结论：这是整个代码库中最完整的一条路径。**

已知限制：

- `identity` cap = 15（`:1231`，另见 `:326` 的 `.slice(0, 15)`）。一份完整简历的事实数通常超过 15。
- `applyCharBudget` 的 240k 上限同样作用于文档；简历叠加其他文档时仍可能被截断。
- `memory-facts.ts:20` `// identity: intentionally omitted (never shown)` —
  identity 不进 `flattenScopeFacts` 展示路径。这是 App 侧的隐私/展示决策，
  **不影响 `/v1/memory/retrieve`**，两条路径不同。

---

## 6. 未审计范围

以下内容本次未检查，相关结论为空：

- 检索层（`retrieve-*`）的排序与召回质量
- event store 与 pgvector 索引
- `assistant-runtime.ts`（1220 行）
- working-memory 子系统
- 防漂移机制的正确性（仅定位了取舍点，未验证保护逻辑本身）

---

## 7. 建议顺序

```
第 4 条 → 独立、便宜，立即兑现「可审计」；产出真实丢弃率数据
第 1 条 → 真正的分叉。先合并 5 份本体论副本，再谈开放
第 2、3 条 → 形状取决于第 1 条
```

工作量判断基于代码阅读，未实际动手验证。
测试改造成本（尤其第 1 条约 100 处引用）容易被低估。
