# Retrieve 上下文预算参数 — Design

> 日期:2026-08-08 ｜ 状态:设计已批准,待写计划
> 范围:仅 L1 StateCore(`packages/contracts` + `packages/core` + `apps/api`)。`POST /v1/memory/retrieve` 增加可选 `maxChars`,让调用方把上下文预算说出来;StateCore 在预算内装填并交代砍了什么。L2 网关零改动(原样转发),L3 接入另开。

## 1. 背景

2026-08-08 完成的 n=200 budget-aligned LongMemEval 对比(`memory-benchmarks/FAIR-REPORT.md`,StateCore commit `96b853d`)给出:

| 系统 | 4k | 16k | 64k |
|---|---|---|---|
| StateCore | 51.0% ±7.0 | 80.9% ±5.5 | 87.6% ±4.6 |
| mem0 OSS | 61.3% ±6.9 | 59.8% ±6.9 | 61.3% ±6.9 |
| 整语料塞进 prompt(天花板) | — | — | 70.1% ±6.4 |

16k/64k 显著领先,64k 甚至高过天花板。**4k 输 10 分**:窄预算下 StateCore 只装得进 4 个整会话 + 23 条事实,mem0 装进 142 条短记忆。

这暴露的**不是**排序质量问题,而是一个 API 缺口:

> `POST /v1/memory/retrieve` 只收 `limit`(条数 1–100),收不了预算。"这 4000 字符该给 4 个整会话还是给更多小块"这个取舍只有 StateCore 能做(它知道内容长什么样),而它今天做不了(不知道调用方有多少预算)。

调用方现状:`memory-benchmarks/budget.py` 自己写了 80 行在客户端裁剪;`assistant-backend/src/memory/memory.service.ts:46` 干脆不数,`facts.slice(0, 40)` 拍脑袋。

## 2. 明确的非目标

**本设计不会把 4k 那 10 分赢回来,不得以此验收。** 那个差距来自摄入粒度 —— harness 用 `--granularity session` 把整个会话当一条事件写入。切分事件会断掉 `evidenceId` 指向的溯源链,因此**预算只做选择与报告,不重新分块**。摄入粒度是调用方的选择(Remi 本来就是一轮一条,不受影响)。

同样不做:事实的 embedding 重排(需要事实向量,是新的存储与回填;热路径有 4s 超时)、把 `FACT_BUDGET_SHARE` 做成请求参数(冻结契约加进去就拿不掉)。

## 3. 代码现状(设计依据)

- `packages/core/src/index.ts:441` `retrieve(scopeId, limit, query)` —— events 有完整打分链路:`explainQueryScore` 启发式 + 可选向量召回 + embedding 重排,产出 `finalScore`,末尾 `.slice(0, limit)`。
- `apps/api/src/memory.controller.ts:856` —— 事实来自另一条路 `getLatestDigestState` → `getActiveFactRegistry`,**全量返回,不排序、不截断**。`limit` 完全不管事实。
- `packages/contracts/src/index.ts:123` `RetrieveInput` = `{scopeId, query?, limit?}`。
- `packages/contracts/src/index.ts:692` `PublicV1Contracts` 用 `RetrieveOutput.omit({retrieval:true})` —— 只表示 `retrieval` **不在冻结面内**;controller 照全量 `RetrieveOutput` parse 后返回,所以 `retrieval` 实际是发给调用方的(`docs/api.md:281` 明确写了这条)。
- `apps/gateway/src/proxy/proxy.controller.ts:55` 原样 `body: req.body` 转发,无字段白名单 → **L2 零改动**。
- `docs/api.md:267` 加性冻结规则:可选新字段合法,重新 bless snapshot 即可。

## 4. 契约变更

```ts
// packages/contracts/src/index.ts
RetrieveInput  += maxChars?: z.number().int().positive()
RetrieveOutput += budget?: BudgetReportSchema   // 顶层,紧随 factRegistry
```

两处都可选,符合 `docs/api.md:267` 的加性冻结规则。

> **2026-08-08 全分支 review 后修订。** 本节原本把 `budget` 挂在不冻结的 `retrieval`
> 对象里,理由是不扩大冻结面。实现后 review 跑真实请求发现:`retrieve()` 在无 `query`
> 分支根本不返回 `retrieval`(该字段本就 `.optional()`),于是 `{ ...undefined, budget }`
> 展开成缺 7 个必填字段的对象,`parseOutput` 判为服务端 bug → **HTTP 500**。
>
> 预算总是存在(只要传了 `maxChars`),它的容器却不总是存在 —— 这个错配指向的结论是:
> 预算不是排序诊断信息,而是关于响应本身的声明,应当平级。改为顶层可选字段后,无 `query`
> 的路径不再有任何特殊情况。代价是冻结面多一个可选字段(加性合法,但加进去就拿不掉)。

**不传 `maxChars` 时输出与今天逐字节相同** —— 包括事实仍按 `getActiveFactRegistry` 原顺序全量返回、不排序。这是硬约束,有专门的测试挡着。

`limit` 与 `maxChars` 各管各的,谁先触发谁生效:

| 参数 | 管什么 | 变化 |
|---|---|---|
| `limit` | event **条数**上限 | 不变,仍默认 20 |
| `maxChars` | 三部分**总字符** | 新增 |

`limit` 依旧不影响事实。

## 5. 事实排序

事实第一次有分数。复用 events 已有的 `explainQueryScore(query, content)` —— 它只吃 query + 文本,事实直接可用。

排序键(降序):

1. `explainQueryScore(query, fact.content).score`
2. `fact.confidence`
3. `fact.addedAt`

**无 `query` 时**降级为 `confidence` → `addedAt` 降序(events 那边今天已有纯 recency 的无 query 分支,`index.ts:449`)。

排序**仅在传了 `maxChars` 时**发生,以满足第 4 节的逐字节兼容约束。

## 6. 装填器

新文件 `packages/core/src/retrieve-budget.ts` —— 纯函数,无 I/O,可独立测试。core 定策略,api 管接线:事实来自 controller 的 `getLatestDigestState`、events 来自 `retrieveService.retrieve()`,controller 是两半汇合处,由它调用本模块。

不放进 `packages/core/src/index.ts` 是因为该文件已经很大,而装填是一个边界清晰、可单独讲清楚的职责。

### 三条装填规则

1. **digest 原子** —— 装不下就整个不装,记 `digest_too_large`。半段摘要不是摘要。
2. **事实封顶** —— 事实最多占 `FACT_BUDGET_SHARE = 0.4` 的预算。保证 events 永远有位置:一个用了一年、几百条事实的 scope 不会把原始证据挤成零。常数,不做成参数。

   封顶基数是 **`maxChars` 全额**,不是扣掉 digest 后的余额 —— 即事实可用额度 = `min(floor(maxChars × 0.4), 装完 digest 后的剩余)`。取全额是为了让"事实最多占四成"这句话对调用方成立且可自行验算;取 `min` 是因为极小预算下余额可能比封顶还小。
3. **整条装,装不下跳过继续往后看** —— 绝不切断一条事实或一个 event,且**不是**遇到第一个装不下的就停。

第 3 条挡的是已发生过的缺陷:`budget.py` 原本用 `break`,一个大块挡住后面所有小块,让分数变成"谁返回的块小"的函数,实测 StateCore 4000 预算只填到 70%、recency 72%,而返回短条目的 mem0 从不触发 —— 不对称,直接污染结论。

### 装填顺序与示例

digest → facts(封顶内) → events(剩余全给)。

```
maxChars=16000,23 条事实的 scope
  digest    540   原子,装下了
  facts    2000   23 条全进,未触顶 6400
  events  13460   剩下的全给它

maxChars=16000,300 条事实的 scope
  digest    540
  facts    6400   触顶,只进分最高的 74 条
  events   9060   仍有原始证据
  dropped  226 facts(fact_share_cap)+ 装不下的 events(budget_exhausted),各带分数
```

**events 候选来自 `retrieve()` 的返回值,已被 `limit` 截过**(`index.ts` 末尾 `.slice(0, limit)`)。所以 `limit` 在上游先binding:`limit=20` 时预算再大也只有 20 条可装。这就是"谁先触发谁生效"的具体含义。

## 7. drop 报告

```ts
budget: {
  maxChars: number,
  usedChars: number,
  digestChars: number,
  factChars: number,
  eventChars: number,
  factShareCap: number,          // 生效的 FACT_BUDGET_SHARE,便于回溯
  droppedCounts: { fact: number, event: number, digest: number },
  dropped: Array<{
    kind: "digest" | "fact" | "event",
    id: string | null,           // digest 无 id
    chars: number,
    reason: "budget_exhausted" | "fact_share_cap" | "digest_too_large",
    score?: number               // 无 query 时缺省
  }>,
  itemsOmitted: number           // dropped 明细截掉了多少条
}
```

`droppedCounts` **永远完整,永不截断**;`dropped` 明细**三类合计**上限 100 条(按 digest → fact → event 顺序填),截掉多少由 `itemsOmitted` 明写。有界报告不等于静默丢弃 —— 后者(stage 2 只看前 60k 字符、facts 在降级路径上无声消失)正是 2026-08-08 这一轮修掉的缺陷类型,不能在新功能里复活。

## 8. 错误与降级

| 情形 | 行为 |
|---|---|
| `maxChars` 非正整数 | zod 拒绝 → 400,与其他输入校验一致 |
| `maxChars` 小到连 digest 都装不下 | 返回空 events + 空 facts + `digest_too_large`,不报错。空结果是合法答案 |
| 无 digest / 无事实 / 无 events | 各自跳过,`droppedCounts` 相应为 0 |
| 无 `query` | 事实按 confidence→addedAt 排,events 走既有 recency 分支,`dropped[].score` 缺省 |

预算装填不引入新的失败模式:它只做选择,不调用外部服务。

## 9. 测试

照 `packages/core/src/fact-length-bound.test.ts` 与 `stage2-chunking.test.ts` 的路子 —— 每个测试的注释写清它挡的是哪个缺陷,而不是复述断言。

新增 `packages/core/src/retrieve-budget.test.ts`:

1. 不传 `maxChars` → 输出与今天完全一致(事实顺序、条数、events 全部不变)
2. 绝不切断一条事实(半条事实是**假**事实)
3. 绝不切断一个 event
4. 一个超大 event 之后,小的还能进 —— 挡 `break` 缺陷复发
5. digest 装不下时整个不装,并记 `digest_too_large`
6. 事实封顶生效:300 条事实的 scope,events 仍有位置
7. 事实装得下时不触发封顶(不无谓丢弃)
8. **对账不变式**:每个候选要么在结果里、要么在 `droppedCounts` 里,总数对得上 —— 不允许任何东西凭空消失
9. `dropped` 明细超 100 条时 `itemsOmitted` 数字正确
10. 有 query 时事实按相关性排,无 query 时按 confidence→addedAt 排
11. `limit` 与 `maxChars` 同时给,谁先触发谁生效

`apps/api` 侧:冻结 snapshot 重新 bless(`pnpm --filter @statecore/api test -- public-v1-contract -u`),并确认 15 个端点数量断言不变(本变更不新增端点)。

## 10. 文档

`docs/api.md` 的 retrieve 段落补 `maxChars` 与顶层 `budget`,并写明:不传则行为不变;事实排序仅在传了预算时发生;`FACT_BUDGET_SHARE` 是常数不可调;预算以字符而非 token 计,因为 token 数是模型特定的。
