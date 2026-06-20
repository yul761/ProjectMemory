# StateCore「遗忘边界」诊断探针 — 设计 spec

> 日期：2026-06-19
> 目的：把 §11 架构推演的「会忘 vs 不会忘」边界，从推理变成**可复现、可量化**的实测；并作为后续修复（中文分词 / embedding / 本体论骨架）的**回归守卫**。
> 关联：`/Users/yuchenlin/Quatium/StateCore/StateCore-记忆引擎-讨论记录.md` §11。

## 背景结论（来自 §11，已对代码核实）

每轮编译上下文只有 4 块；细节要被记住只有两条路：① 固化进 State 块那 6 个 PM 槽（每轮必在）；② 走 retrieval 窄路（runtime limit≈4、编译只显示 2 条、180 字符截断）。两类东西会忘：**随口提的没固化的细节**（note/noise，只能走 retrieval）、**文档里塞不进 PM 槽的细节**（被 digest 本体论压缩丢弃）。

## 关键测量约束（代码事实）

- `RetrieveService.retrieve` 的 `candidateSize = min(max(limit*4,40),200)`：默认 `limit:20` 会拉 ~80 条候选，事件少时**全部返回**——所以默认 limit 下观察不到"遗忘"。
- 真正的遗忘发生在 **runtime 预算**：retrieve `limit≈4`（`assistant-runtime` 默认）、`MAX_RETRIEVAL_SNIPPETS=2`、`MAX_SNIPPET_CHARS=180`。
- 启发式打分 `explainQueryScore`：中文 query 经 `tokenize`（`/[^a-z0-9\s]/g`）后 token 为空 → 所有事件 `score:0` → 排序退化为 `recency`。英文有共享词 → `score>0` → 压过 recency。
- 排序 `combined = score*0.8 + recency*0.2`。

**结论**：测量用**小 limit**（`/memory/retrieve` `limit:3`，镜像 runtime 预算）+ `/memory/fast-view` 的 `retrievalBlock`（真实 2-snippet 上下文），**不要**用默认 limit 20。

## 探针 A — 隔离「中文分词」根因（白盒，无 LLM）

**setup**（新建 scope，template=`personal`）：
1. 早期灌两条 stream 事实：EN `"I am allergic to peanuts"`、ZH `"我对花生过敏"`。
2. 之后灌 ~6 条无关中文 stream（如 `"今天去爬山了"`、`"昨天看了一部电影"`…），把两条事实挤出 recency 窗口。

**两个"共享词"查询**（都与对应事实有词重叠，只差语言）：

| 查询 | 与事实共享词 | 预期（`retrieve limit:3` & fast-view） |
|---|---|---|
| EN `"which foods am I allergic to"` | `allergic` | ✅ peanut 事实进 top-3 / 进 retrieval 块 |
| ZH `"我对什么过敏"` | `过敏`、`我对` | ❌ 花生事实不进 top-3 / 不进 retrieval 块 |

**判定**：同样有共享词、同样隔着 recency gap，**英文捞回、中文捞不回** → 病因锁定 `tokenize` 抹中文（而非"事实太旧"）。量化：目标事件是否在 `events[]`、其 rank；是否出现在 `fastLayerContext.retrievalBlock`。

**次要探针 A2（可选）**：再各加一条**无共享词的换说法**查询（EN `"is there anything I should not eat"` / ZH `"我有什么忌口"`）。预期**英文也失败** → 隔离出"无语义桥 / embedding 默认关"这条**独立**的病（区别于分词病）。

## 探针 B — 隔离「本体论压缩」根因（白盒为主，LLM 旁证）

**setup**：灌一份**中文简历**（`type:document`，带 key；内容由实现时生成，含公司名/年限/技能等具体事实）→ `POST /memory/digest` 固化。

**观测**：
- `GET /memory/fast-view?message=我在哪家公司工作过` → `stableStateBlock` 只含 goal/constraints/decisions/todos 残渣，**无**简历具体公司名/年限；`retrievalBlock` 即便命中也截到 180 字符。
- `GET /memory/stable-state` → 直接看固化结构里有没有简历细节。
- 旁证 `POST /memory/answer {question:"我在哪家公司工作过"}` → 模型能否答出具体公司。

**判定**：简历具体事实**不在编译上下文 State 块** → 证明 digest 把文档压进 PM 本体论时丢了细节（非 ChatGPT 式滚窗）。

## 形态

自包含 **Node ESM 脚本** `scripts/diagnostics/forgetting-probe.mjs`（用内置 `fetch`，无新依赖）：
- 流程：`建 scope → 灌事件 → digest → 跑探针 A/B → 打印裁决表`。
- 配置：`BASE_URL=http://localhost:3002`、`x-user-id: local-dev-user`（同 CLAUDE.md）。
- 输出：每个探针一行 `PASS/FAIL`（这里 PASS = "病按预期复现"），附 rank / 命中证据。
- 幂等：每次跑用新 scope（带时间戳 name），不污染既有数据。

## 修复验证（这就是把它做成脚本的理由）

- 修中文分词后重跑：探针 A 的 ZH 行应**转为命中**。
- 开 `RETRIEVE_USE_EMBEDDINGS=true` 后重跑：探针 A2 的换说法应**转为命中**。
- 改私人助理状态骨架后重跑：探针 B 的简历细节应进 State 块。

## 已定决策

- scope 模板 = `personal`（贴产品；引擎本体论与 project 相同，仅影响分类 prompt）。
- 简历内容由实现脚本内置生成（一份真实感的中文简历）。
- 测量用 `retrieve limit:3` + `fast-view`，非默认 limit 20。

## 非目标（YAGNI）

- 不接入 benchmark 框架、不改任何引擎代码（这是**诊断**，修复是后续独立工作）。
- 不测 `/memory/answer` 的 25-event 路径作为主判据（它与 runtime 预算不同；仅作旁证）。
