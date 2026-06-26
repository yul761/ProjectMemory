# 记忆「事实」可展示 + 可遗忘（Memory Facts & Forget）

> 记于 2026-06-26 ｜ 引擎层（Layer 1）设计。服务于 Remi（assistant-backend）的「记忆屏」：分组展示用户的记忆事实 + 左滑 forget。
> 自底向上三层中的**第一层**：StateCore 引擎 → statecore-cloud（`/v1` 开放）→ assistant-backend（消费）。本 spec 只覆盖**引擎层**。
> forget 语义已拍板 = **压制（suppression）**：从展示隐藏 + Remi 不再使用；原始事件保留（可审计/可恢复），不硬删、不强制重建 digest。

## 背景：事实在引擎里的真实形态

记忆「事实」**已持久化**，但散在 digest 状态里，由 digest worker 周期生成，不是每事件即时产生。两种形态：

- **factRegistry**（`packages/core/src/digest-control.ts:56-77`）：`{ id, content, type(decision|constraint|profile), confidence, addedAt, evidenceId(→MemoryEvent.id), facet?, supersededBy? }`。存于 `DigestStateSnapshot.state.factRegistry`（JSON）。`getActiveFactRegistry(state)` 过滤掉 `supersededBy` 的，得 active 集。
  - ⚠️ `id` 形如 `fact-${Date.now()}-${rand}`，弱且每次 digest 可能重生 → **不能当稳定删除目标**。
- **profile facets**（`PROFILE_FACET_ROUTING`，`digest-control.ts:1065-1078`）：六组 `identity / goals / ongoing / relationships / followUps / style`，存于 `DigestStateSnapshot.state.profile.<facet>[]`，**是裸字符串数组，没有 id、没有时间戳**。
- 事件分类 `MemoryEvent.classifiedType`（`apps/worker/src/classify-job.ts`）：personal_detail/goal/life_decision/experience/person_note/commitment/style_preference… 决定路由到哪个 facet。

**关键约束（决定 forget 怎么落地）**：下游（Remi 的 `assistant-backend/src/memory/memory.service.ts:19 buildContext`）喂进 LLM 的是 **`retrieve` 返回的 digest summary + 原始 events**，**不是 factRegistry**。所以"让 Remi 不再用某事实"**不能只过滤 factRegistry**——必须管住 ① 原始事件、② digest summary 这两条进 prompt 的路。

相关现状：
- `GET /memory/events`（`apps/api/src/memory.controller.ts:441-470`）：游标分页列原始事件。
- `POST /memory/retrieve`（同文件 `:672-695`）：返回 `{digest, events[], factRegistry[], retrieval?}`（contract `packages/contracts/src/index.ts:114-161`）。
- 唯一的删除是内部 TTL 过期（`apps/worker/src/expire-events.ts`，`deleteMany where expiresAt<now`）。无任何用户级 delete/forget。

## forget 语义（已定）

左滑 forget 一条事实 = **压制**，不是硬删：
1. 该事实从记忆屏列表消失（立即）。
2. Remi 立即不再从**原始事件**拿到它；factRegistry 立即过滤掉它。
3. **不强制触发 digest 重建** → digest `summary`（缓存的一段文字）要到**下次 digest** 才不再提它。接受这个滞后窗口（原始事件已立即停喂，影响有限；省算力）。
4. 原始事件保留（软标记 `suppressedAt`，可审计/可恢复）。

## 工作项（引擎层）

### 1. 数据模型（`packages/db/prisma/schema.prisma`）

新增 `ForgottenFact`（每 scope 的压制集）：
```prisma
model ForgottenFact {
  id              String   @id @default(uuid())
  userId          String
  scopeId         String
  factKey         String   // 稳定指纹，见 §2
  contentSnapshot String   // 遗忘时的原文，便于展示「已遗忘」/审计/恢复
  forgottenAt     DateTime @default(now())

  @@unique([scopeId, factKey])
  @@index([userId, scopeId])
}
```
给 `MemoryEvent` 加软标记：
```prisma
suppressedAt    DateTime?   // 被 forget 牵连的源事件：保留但不再进 retrieve / 不再喂 digest
```
（迁移：`prisma migrate` 加表 + 加列，均 nullable / 新表，无破坏性。）

### 2. 事实身份：`factKey`（稳定指纹）

因 factRegistry id 弱、profile facets 无 id，定义一个**两端一致**的稳定 key：
```
factKey = sha256(normalize(group) + "|" + normalize(content)).slice(0, 16)
```
- `normalize` = trim + 小写 + 折叠连续空白。
- list 端（§3）算出来随每条事实返回；forget 端（§4）拿同一个 key 回来。
- 对 factRegistry 条目和 profile facets 裸字符串**都适用**，且**完全不改 digest 生成逻辑**。
- 软边：若 digest 改写措辞 → key 变 → 可能复现。v1 接受（罕见；改写后视作新表述）。
- 放在 `packages/core` 里做成纯函数 `computeFactKey(group, content)`，引擎与（将来）测试共用。

### 3. 读：`GET /memory/facts?scopeId=`（新端点）

`apps/api/src/memory.controller.ts` 加路由。流程：
1. 读最新 `DigestStateSnapshot.state`（复用 `domain.getLatestDigestState(scopeId)`）。无 snapshot → 返回空分组。
2. 铺平：`getActiveFactRegistry(state)` 的条目 + `state.profile.<facet>[]` 的字符串，归一成统一项 `{ factKey, text, group, createdAt }`。
3. **分组映射**（§6）。
4. 时间戳：factRegistry 用 `addedAt`；profile facets 无 → 回退用其证据事件 `createdAt`，再不行用该 snapshot 的 digest `createdAt`。
5. 算 `factKey`，**滤掉** `ForgottenFact`（按 `scopeId+factKey`）。
6. 去重（同 factKey 取其一）。返回：
```ts
{ groups: Array<{ group: string; items: Array<{ factKey: string; text: string; createdAt: string }> }> }
```
contract 加到 `packages/contracts/src/index.ts`。

### 4. 写：`POST /memory/facts/forget`（新端点）

body `{ scopeId: string; factKey: string }`：
1. 在最新 snapshot 里按 factKey 反查该事实（拿 `content` 存 `contentSnapshot`，拿 `evidenceId` 若有）。
2. upsert `ForgottenFact`（`@@unique([scopeId, factKey])`，幂等）。
3. 若该事实有 `evidenceId`（factRegistry 才有）→ 把对应 `MemoryEvent.suppressedAt = now`。profile facets 无证据链 → 仅靠 factKey 在读路径过滤（见 §5）。
返回 `{ ok: true }`。

### 5. 压制生效（让 Remi 真的不再用）—— 三处过滤

1. **retrieve 的 events**（`memory.controller.ts:672-695` 调的 `retrieveService.retrieve`）：查询 `MemoryEvent` 处加 `where suppressedAt: null` → **原始事件立刻不再进 prompt**。`GET /memory/events` 同样排除（除非显式 `includeSuppressed`，留给 console）。
2. **retrieve 的 factRegistry**：`getActiveFactRegistry` 之后，按该 scope 的 `ForgottenFact.factKey` 再滤一层（用 §2 同一函数对每条算 key 比对）。
3. **下次 digest**（`apps/worker/src/main.ts:229-252` 选事件处）：选取 recentEvents 时排除 `suppressedAt != null` → summary 重建时不含、且不再重提（不再 promote 进 factRegistry/profile）。

> profile facets 本身不直接进 Remi 的 prompt（`buildContext` 只用 summary + events），它们只通过塑造 digest summary 间接影响 Remi。故遗忘一条 profile fact = **列表立即隐藏（§3.5 的 ForgottenFact 持久过滤，即使下次 digest 用相同文本重新派生，仍按 factKey 被滤）** + **对 Remi 的影响走 summary 滞后窗口**。
>
> 滞后窗口：digest summary 是缓存文本，§5.3 只在**下次 digest 运行**后生效。期间 summary 可能仍提一句。已决定**不**为此强制即时重建。

### 6. 分组映射（引擎 facets/types → 设计稿 4 组）

| 展示分组 | 来源 |
|---|---|
| **People** | facet `relationships`；classifiedType `person_note` |
| **Preferences** | facet `style`；classifiedType `style_preference` |
| **Projects** | facet `goals` / `ongoing` |
| **Schedule** | facet `followUps`；classifiedType `commitment` |
| **（不展示）** | facet `identity`（姓名等隐私基础信息）v1 不进列表 |

实现成 `packages/core` 里一张可调映射表 + 一个 `factToGroup(facetOrType)` 纯函数。映射偏经验，留作可微调。

**只展示「profile 类」事实**（六组 facets + factRegistry 中 `type=profile`）。generic 的 `decision/constraint` 类 factRegistry 是内部推理产物、非用户语义的「记忆」，**v1 不进记忆屏**（避免引入「这条 decision 算 Schedule 吗」的判定歧义，且无结构化时间字段可依）。

### 7. API 表面（引擎，本层产出）

- `GET  /memory/facts?scopeId=` → 分组事实（§3）
- `POST /memory/facts/forget` `{scopeId, factKey}` → 压制（§4）
- 现有 `retrieve` / `GET /memory/events` 行为变更：默认排除 `suppressedAt`（§5.1）

（下一层 statecore-cloud 把这两个新端点经 `/v1` 开放，含鉴权透传；再下层 assistant-backend 加 `StateCoreClient.listFacts/forgetFact` + memory controller。均不在本 spec。）

### 8. 测试

- `computeFactKey`：归一化稳定性（大小写/空白/措辞同→key 同；措辞变→key 变）。
- `factToGroup`：各 facet/type 落到预期分组；identity 不出现。
- `GET /memory/facts`：拼 snapshot 状态 → 期望分组与时间戳；ForgottenFact 命中被滤。
- `POST /forget`：写 ForgottenFact 幂等；有 evidenceId 时源事件被标 `suppressedAt`。
- 压制三处：retrieve events / factRegistry / digest 选取 都排除被压制项。
- 迁移：新表 + 新列存在，旧行为不破。

## 不做（守边界）

- 不硬删事件、不级联删事实、不强制 digest 重建。
- 不动 digest **生成/合并**逻辑（只在「选事件」入口加一处过滤）。
- 不做 profile facet 的逐条 id 化改造（用 factKey 寻址即可）。
- identity 组、撤销遗忘（undo）UI、跨 scope —— 本层不做。

## 验证后

引擎层：单测绿 → `pnpm build` → push `feat/memory-facts-forget` → 部署 **Droplet 1**（StateCore + cloud 同机，含 `prisma migrate deploy`）。然后进第二层 statecore-cloud。
