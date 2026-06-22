# S1 — 漂移控制鲁棒性:property/fuzz + 合成对抗加固

> 记于 2026-06-22 ｜ 隶属 [v1 开发路径](./2026-06-22-statecore-v1-dev-path-design.md) 的第一段(★最高杠杆)。
> 目标:把"低漂移"从 happy-path 断言变成**扛压的性质**。

## 范围

只覆盖 `packages/core/src/digest-control.ts` 的**纯确定性函数**——不调 LLM、不跑完整 pipeline。
理由:这些函数才是漂移控制的真正逻辑,可复现、快、无需 mock LLM,最高杠杆。

被测面:
- `normalizeDigestState`
- `selectEventsForDigest`
- `detectDeltas`
- `protectedStateMerge`(L1295–1844,核心)
- `consistencyCheck`(L1845–1982)
- CJK 守卫:`sameFactCjkAware` / `asciiContentDiverges` / `jaccardSimilarity` / `tokenize`

**不在范围**:`runDigestControl` 全管道、LLM 调用、真实数据(真实数据是冻结后的主反哺循环,见 v1 路径文档)。

## 已知障碍 → 前置小重构(非破坏 /v1)

`protectedStateMerge` 经 `promoteToFactRegistry`/`supersedeFact` 用
`Date.now()` + `Math.random()` 生成 fact id(L1014、L1038),破坏 property 测试的
确定性与复现,且快循环下有 id 碰撞风险。

**处理**:给 `protectedStateMerge` 注入一个可选的 `idFactory`(默认保留现有行为,
向后兼容);内部 id 生成改走它。property 测试传入基于 `evidence id + 单调计数器`
的确定性工厂,使同输入 → 同输出。这是算法内部改动,对 `/v1` 契约非破坏。

## 工具

- 新增 devDependency:`fast-check`(packages/core)。
- 新增测试文件:
  - `packages/core/src/digest-control.property.test.ts` —— 性质 + fast-check 生成器(广度/fuzz)。
  - `packages/core/src/digest-control.adversarial.test.ts` —— 手写锡点 fixture(已知最难场景,回归锚点)。
- 沿用 vitest;现有 `digest-control.test.ts`(举例式)保留不动。

## 不变量(property 断言核心)

| 函数 | 关键不变量 |
|---|---|
| `normalizeDigestState` | 幂等:`normalize(normalize(s))` 深等于 `normalize(s)`;各 facet ≤ 其 cap;任意 type-valid 输入不抛、输出恒为合法 `DigestState` |
| `selectEventsForDigest` | 预算上限恒守(`selected ≤ eventBudgetTotal`,`docs ≤ eventBudgetDocs`);**durable(decision/constraint/todo)stream 事件不被预算挤掉**;确定性(同输入同输出,稳定排序) |
| `detectDeltas` | decision/constraint 无视 novelty 必留;novelty 阈值单调(阈值↑ ⇒ deltas 为子集) |
| `protectedStateMerge` ★ | (a) **写保护事实不被 stream 事件静默删除/覆盖**——仅 document/更高权威能动;(b) **goal 防横跳**:低于阈值的 stream 事件永不覆盖已有 goal;(c) 幸存值的 provenance 不被清空;(d) cap 淘汰先淘 unprotected,protected 幸存;(e) 注入 idFactory 后:同输入 → 同输出 |
| `consistencyCheck` | 声称的矛盾类(goal/constraint/decision/todo/profile)能被抓到;一个干净/刚合并出的一致状态零误报 |
| CJK 守卫 | ASCII 内容 token 不相交的两条事实(如 `我决定用PostgreSQL` vs `我决定用MySQL`)**永不被合并**;纯 CJK 内容不因 normalizeText 归零而误判同一 |

## 5 类合成对抗 ↔ 不变量映射

| 对抗模式 | 形式 | 主要打的不变量 |
|---|---|---|
| 矛盾轰炸 | 同 facet 反复灌入互斥事实 | consistencyCheck 抓矛盾 + protectedStateMerge 矛盾处理 |
| 目标反复横跳 | 交替灌入不同 goal 的 stream 事件 | goal 防横跳(b) |
| 噪声干扰 | 大量 noise/低重要度事件淹没 durable | noise 过滤 + durable 预算保全 |
| 文档版本 churn | 同 key 文档多版本反复 upsert | `mergeDocumentBackedList` 的 remove/re-add 正确性 |
| 多语言混合 | 中英混排、纯 CJK、CJK+ASCII 分歧 | CJK 守卫 |

对抗以**两种形式**落地:
1. fast-check arbitraries 把上述 5 类编码成随机生成器(广度 + shrink 找最小反例)。
2. 手写一组已知最难场景作为确定性回归锚点。

## 失败处置

property/fixture 暴露的每个违例,先判定"真 bug vs 故意行为":
- 真 bug → 当场修(算法内部改动,非破坏 /v1)。
- 故意行为 → 把不变量收紧成符合实际的形式,并注释原因(避免把现有正确行为误判为 bug)。

## 产出

- digest 控制核心的可复现性质测试 + 对抗回归集。
- `protectedStateMerge` 的确定性 id 注入。
- 修掉对抗暴露的真实漂移 bug。
- 这是后续敢用真实数据反哺算法的安全网。

## 执行

走既有流程:本 spec → writing-plans → subagent 执行(每任务双 review + final 全分支 review)→ 合并 + push。
