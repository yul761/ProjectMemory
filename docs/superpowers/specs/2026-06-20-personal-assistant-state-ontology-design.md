# 私人助理状态骨架（P1）— 设计 spec

> 日期：2026-06-20
> 背景接续：`StateCore-记忆引擎-讨论记录.md` §4 / §7.3 / §11.3 / §15。
> 这是 §4「状态骨架被焊死成项目管理本体论」的修复，由探针 B2（§15）量化坐实：简历细节进不了运行时 State 块。
> 前序已完成：P0 检索（`\s` 修复 + embedding + CJK bigram，§12/§14）；探针 B2 闭环（§15）。

## 1. 问题（已量化）

StateCore 的稳定状态骨架是一套**项目管理本体论**：`stableFacts={goal,constraints,decisions}` + `todos` + `workingNotes={openQuestions,risks}`。运行时 State 块（`StateLayerView`，`working-memory.compiler.ts:45-87`）只渲染 6 个槽，**无一个装持久个人事实/档案**。

后果（探针 B2，§15，已排除 recency 混淆）：

| 路径（简历被挤出 recency） | 公司名 `字节跳动`? |
|---|---|
| State 块 | ❌（本体论压缩：简历塞不进 PM 槽） |
| 运行时 Retrieval 块 (2×180) | ❌（被挤出窗口） |
| `/answer` 大召回 (limit≈25) | ✅（非运行时路径，大历史下也会失效） |

且分类器**已经产出**丰富的 personal 实体类型（`personal_detail`/`life_decision`/`person_note`/`experience`/`commitment`/`feeling`/`emotional_pattern`，`domain-configs/personal.ts:7-25`），写进 `classifiedType` 列——但 **digest 全部无视**，只认 7 个通用 kind（`extractKind`）。`classifiedType` 只有 `relationship-context.ts` 读。这是 §4.1 的「阻抗失配」：上游懂领域、下游不懂。

## 2. 目标 / 非目标

**目标**

1. 给引擎一套**私人助理状态骨架**：身份/档案、人际、正在经历、目标、待跟进。
2. 让 digest **消费 `classifiedType`**，修阻抗失配。
3. 档案文档（简历）的持久事实进运行时 State 块、每轮都在 → 修探针 B2 缺口。
4. 新槽复用现有防漂移机制（fact-registry 写保护 / 证据分级 / Jaccard 取代）。

**非目标（YAGNI）**

- **不做配置驱动的通用本体论抽象**（§7.3：只有一个产品，过早抽象会抽错）。新骨架**直接硬编码**进引擎，因为「这一个产品本身需要」。4 个死配置字段（`driftProtected` 等）本 spec 不复活。
- **不替换/不破坏现有 6 个 PM 槽**（增量、benchmark 安全）。project 模板行为不变。
- **不重写** `relationship-context.ts` 的情绪/近期路径；`feeling`/`emotional_pattern` 不进 profile。
- 不动检索层（P0 已处理）。

## 3. 落地方式（已定：增量式个人层，分阶段）

在 `DigestState` 新增 `profile` 结构，与 `stableFacts`/`todos`/`workingNotes` 并列。现有 6 槽保留。分 3 阶段落地（§7），每阶段 benchmark 非回归 + 探针验证。

被否方案：彻底替换 6 槽（爆炸半径大、破坏 PM benchmark）；语义重映射（半吊子）。

## 4. Schema（完整 5 facet）

`DigestState.profile`（全可选、全 `string[]`、各有上限，守 §9 有界上下文）：

```ts
profile?: {
  identity?: string[];       // 身份/档案：持久个人事实 + 档案文档抽出的事实   cap 15
  relationships?: string[];  // 人际：某人是谁、关系、状态                       cap 10
  ongoing?: string[];        // 正在经历的事：找工作中 / 减肥中                  cap 8
  goals?: string[];          // 目标(复数)：减肥、找工作                         cap 8
  followUps?: string[];      // 待跟进：我妈下周一过生日、跟进简历投递           cap 10
}
```

每条是自包含事实行（如 `工作经历: 字节跳动 后端工程师 2019-2022`），与现有 `constraints[]`/`decisions[]` 渲染一致。

**`classifiedType` → facet 映射 + 保护级别：**

| personal.ts entityType | 保护级别 | → facet |
|---|---|---|
| `personal_detail`（permanent, driftProtected） | 写保护 | identity |
| `life_decision`（permanent, driftProtected） | 写保护 | goals |
| `goal`（long-term, driftProtected） | 写保护 | goals |
| `person_note`（long-term） | 半 | relationships |
| `experience`（60d） | volatile | ongoing |
| `commitment`（long-term） | 半 | followUps |
| `feeling`（7d） | — | ❌ 不进 profile |
| `emotional_pattern`（90d） | — | ❌ 不进 profile |

Zod 契约（`packages/contracts/src/index.ts` 的 `DigestState`/`StateLayerView`）同步加 `profile`（可选）。DB 无需迁移——稳定状态是 `DigestStateSnapshot.state` 单 JSON blob。

## 5. digest 路由 + 防漂移

**(a) 接 `classifiedType` 进管线。** 事件行已有 `classifiedType` 列；一路带进 `protectedStateMerge`（纯加字段）。

**(b) 新增 `mergeProfileFacets(state, events)`**（在 `protectedStateMerge` 后跑）：
- 按 §4 映射，`classifiedType` 命中 facet → 事实行 append。
- **去重/取代**：复用 `digest-control.ts:357` 正确 `\s` 分词器的 Jaccard，同 facet 内 ≥0.6 视为同一事实，新的取代旧的（不叠加）。
- **上限淘汰**：超 cap 时 volatile facet 按 importance+新近度淘汰最弱；写保护项不淘汰。

**(c) 防漂移覆盖新槽——复用 fact-registry，加 `facet` 标签：**
- 写保护（identity/goals）：进 `factRegistry`、打 `facet` 标签；stream 事件无权删除，除非更高权威证据显式取代（同 constraint/decision 机制，`:1135-1215`）。
- 半/volatile（relationships/ongoing/followUps）：不进 registry，可取代、可按 `autoExpireAfterDays` 淘汰。

**(d) 档案文档 → identity（修探针 B2 核心）：** 扩展 digest LLM 输出 schema，加 `profileFacts: { facet: string, value: string }[]`，让 LLM 从文档正文抽持久身份事实行（教育/工作经历/技能/联系方式）。文档证据权威 0.85（沿用 `:949`），进 identity 且写保护。这是本设计最重、benchmark 最易波动的一块 → 放 Stage 1 单独验。

**(e) 一致性校验**：现有 digest 后一致性校验扩展到也覆盖 profile 写保护项——profile.identity/goals 与 registry 矛盾时同样打回重生成。

## 6. State 块渲染

- `StateLayerView`（`working-memory.compiler.ts:25`）加 5 个可选 profile 字段；`compileStateLayerView` 从 `DigestState.profile` 取值。
- `formatStateLayerView`（`:77`）加渲染段：`你是谁/档案`(identity)、`人际`(relationships)、`正在经历`(ongoing)、`目标`(goals)、`待跟进`(followUps)。
- 无需模板分支：`pushSection` 已跳过空段。personal 填 profile、project 不填 → 自动不渲染（非破坏证明）。
- 有界：§4 per-facet cap 即上界（identity 15 大头，必要时收 10）。personal 下 PM 槽基本空，净增量可控。

## 7. 分阶段落地（完整骨架为目标，分批上）

| 阶段 | 内容 | 验收 |
|---|---|---|
| **Stage 1 — 身份/档案** | schema + `classifiedType` 接进 digest + `mergeProfileFacets`(仅 identity) + 文档→identity LLM 抽取 + identity 渲染 + identity 写保护 + Zod 契约 | benchmark 不掉分；重跑探针 B2 公司名进 State 块（§15 表 ❌→✅）；新单测 |
| **Stage 2 — 目标 + 正在经历** | 路由 `goal`/`life_decision`→goals、`experience`→ongoing + 渲染 | benchmark 不掉分；新单测 |
| **Stage 3 — 人际 + 待跟进** | 路由 `person_note`→relationships、`commitment`→followUps + 渲染 + 划清与 relationship-context 边界 | benchmark 不掉分；relationship-context 不重复 |

Stage 1 是硬骨头（含 LLM schema 改动）；2/3 是顺势增量路由。每阶段独立 plan + benchmark 非回归门。

> 人际重叠：`relationship-context.ts` 管动态情绪/近期层；`profile.relationships` 只装持久「谁是谁」事实。`person_note` 有交集 → Stage 3 精确划界（Stage 1/2 不碰人际）。

## 8. 测试策略

**单元（TDD、不起服务，路由/合并是纯函数）：**
1. facet 路由：各 `classifiedType` → 正确 facet；`feeling`/`emotional_pattern` 不进 profile。
2. 防漂移：identity 写保护项扛住矛盾 stream（删不掉）；volatile ongoing 可被取代。
3. facet 内 Jaccard 去重（≥0.6 合一、新胜）。
4. 上限淘汰：volatile 超 cap 淘汰最弱；写保护不淘汰。
5. State 块渲染：`compileStateLayerView` 取 profile；`formatStateLayerView` 渲 5 段；空 facet 跳过（project 无 profile 段）。
6. 文档→identity：mock `DigestOutput.profileFacts` 测路由/合并。

**集成 / E2E：**
- digest 集成测试：personal 模板灌简历 → digest → 断言 `profile.identity` 含公司名。
- 重跑探针 B2：公司名在 State 块 ❌→✅（Stage 1 北极星）。
- benchmark 非回归：`consistencyPassRate` / retention 不掉。

**非回归**：现有 27 个 core 测试文件 + 6 个 PM 槽行为不变。

## 9. 验收标准（整体）

- [ ] 三阶段全部落地，每阶段 benchmark 不掉分。
- [ ] 探针 B2：简历公司名进运行时 State 块（§15 metric 翻正）。
- [ ] `classifiedType` 被 digest 消费（阻抗失配修复，可由路由单测证明）。
- [ ] project 模板行为不变（6 PM 槽 + 无 profile 段）。
- [ ] `relationship-context.ts` 情绪路径未被破坏、人际不重复渲染。

## 10. 风险与缓解

- **LLM digest schema 改动（5d）波动 benchmark** → 隔离在 Stage 1、benchmark 门把关、可单独回滚。
- **State 块膨胀破坏 §9 有界** → per-facet cap 硬上界；identity 可收到 10。
- **人际与 relationship-context 重复** → 延到 Stage 3、显式划界。
- **profile 写保护与现有 registry 冲突** → 复用同一 registry + `facet` 标签，不新造机制。
