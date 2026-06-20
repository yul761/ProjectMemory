# CJK Bigram 分词（RetrieveService）— 设计 spec

> 日期：2026-06-20
> 背景接续：`StateCore-记忆引擎-讨论记录.md` §12.4 / §12.7 / §13.3 / §13.4 第 2 项。
> 这是 §12 留的「下一锤」：在不依赖 embedding API 的启发式检索层，让中日韩获得词级召回。

## 1. 问题

检索分词器 `\\s`→`\s` 修复后（§12.5），空格分隔语言（英/欧）恢复词级检索，但 **CJK（中日韩）仍退化为 recency-only**：

- `RetrieveService.tokenize`（`packages/core/src/index.ts:291-297`）用 `.replace(/[^a-z0-9\s]/g, " ")` 把所有 CJK 字符替成空格 → `split(/\s+/)` 得到空 token → `length > 2` 过滤后 `queryTokens` 为空 → `explainQueryScore` 对所有事件返回 `score: 0` → 排序退化为 `createdAt` 倒序。
- 后果：中文查询召不回老事实；开 embedding 可救近义查询（§12.7），但 ① 有 API 成本/延迟，② embedding 只 rerank 启发式选出的 top-24 recency 候选，大历史下老的中文事实可能进不了那 24 个窗口（§12.7 遗留 caveat）。

## 2. 目标 / 非目标

**目标**

1. 中日韩在**启发式层**获得词级召回，不依赖 embedding API。
2. 让 recent-N 候选里排序靠后的老 CJK 事实，被 bigram 评分抬进 embedding 的 top-24 重排窗（补 §12.7 caveat）。
3. 彻底锁死 §12.2 的「字数假阳性」回归（`我喜欢打篮球` 不得匹配 `我对花生过敏`）。
4. 覆盖主流语言（中、英、日、韩、欧洲）；偏门小语种不管（§13.3）。

**非目标（YAGNI）**

- 不加中文 `queryAliases` / 语义桥（如 `简历↔CV`、`忌口↔过敏`）。零词重叠的松散换说法是 embedding 的活，已在 §12.7 结论；alias 手维护易腐。
- 不动打分公式、不动 embedding 路径、不动 `digest-control.ts` 的 Jaccard 分词器（§12.3：防漂移不受影响，保持隔离）。
- 不解决「零词/零 bigram 重叠的换说法」——明确写为已知边界，不过度承诺。

## 3. 改动面

**唯一改动**：`packages/core/src/index.ts` 的 `RetrieveService.tokenize`（291-297）。

不动：`queryAliases`（284-289，仍只英文）、`explainQueryScore` 打分逻辑、`rerankWithEmbeddings`、`digest-control.ts:343` 的独立 `tokenize`。

## 4. 算法

`tokenize(text)` 改为两路产出、合并进同一 token 数组：

### 4.1 ASCII / 拉丁路（保留现有行为）

```
text.toLowerCase()
  .replace(/[^a-z0-9\s]/g, " ")   // 现有：非 ASCII 字母数字 → 空格
  .split(/\s+/)
  .filter(token => token.length > 2)
```

空格分隔语言（英/欧）行为完全不变。

### 4.2 CJK 路（新增）

1. 用 Unicode 区段正则抽出 CJK 连续字符串。覆盖区段：
   - 中文（含统一表意文字）：`一-鿿`
   - 日文假名：`぀-ヿ`（平假名 + 片假名）
   - 韩文音节：`가-힯`
   - 正则：`/[一-鿿぀-ヿ가-힯]+/g`
2. 对每个连续段：
   - 长度 ≥ 2：生成相邻 **bigram**（`花生过敏` → `花生, 生过, 过敏`）。
   - 长度 == 1：保留该单字 **unigram**（避免漏掉真·单字查询，如查「钱」）。
3. CJK token **不经过** `length > 2` 过滤（bigram 长度 2、单字长度 1）。

### 4.3 合并

两路 token 合并进同一 `Set`/数组返回。混合脚本（`上传resume`）自然两路各取：ASCII 路出 `resume`，CJK 路抽出 `上传`（≥2 字 → bigram `上传`）。

### 4.4 为什么不碰打分

现有 `score = min(1, overlap / queryTokens.size + phraseBoost)` 是 Jaccard 式重叠率，bigram 作为普通 token 直接进集合即工作：

- `我对花生过敏` 的 bigram 集 = {我对, 对花, 花生, 生过, 过敏}
- query `我对什么过敏` = {我对, 对什, 什么, 么过, 过敏} → overlap {我对, 过敏}=2，size=5 → score 0.4 ✅ 召回
- query `我喜欢打篮球` = {我喜, 喜欢, 欢打, 打篮, 篮球} → overlap 0 → score 0 ✅ 假阳性死

注：`phraseBoost`（`content.toLowerCase().includes(token)`）对 CJK bigram 仍有效——bigram 是原文相邻子串，`includes` 命中合理。

## 5. 测试策略（TDD：先写失败测试）

纯单元测试，喂中文直接打 `tokenize` / `explainQueryScore`，零成本、不起服务（§11.6 场景 A）。位置：`packages/core/src/index.test.ts`（或新建 `retrieve-cjk.test.ts`，跟随现有测试风格）。

| # | 测试 | 断言 |
|---|---|---|
| 1 | bigram 生成 | `tokenize('我对花生过敏')` 含 `花生`、`过敏`，非空 |
| 2 | 中文真召回 | `explainQueryScore('我对什么过敏','我对花生过敏').score > 0` |
| 3 | 字数假阳性已死（§12.2 回归锁） | `explainQueryScore('我喜欢打篮球','我对花生过敏').score === 0` |
| 4 | 英文不退化（防回归） | 现有英文用例 score 不变 |
| 5 | 混合脚本 | `tokenize('上传resume')` 同时含 `resume` 和 `上传` |
| 6 | 单字 CJK | `tokenize('钱')` 含 `钱`（unigram 保留） |
| 7 | 日/韩冒烟 | 各一条 bigram 生成断言 |

**端到端验证**：重跑 `node scripts/diagnostics/forgetting-probe.mjs`，**关 embedding**（`RETRIEVE_USE_EMBEDDINGS=false`）验证中文在纯启发式层词级召回。预期：§12.7 表里「不开 embedding 时 recency-only」的中文近义查询，现在靠 bigram 重叠进 top-2。

## 6. 已知边界（不声称解决）

- 零 bigram 重叠的松散换说法（`忌口` ↔ `过敏`）：bigram 救不了，仍需 embedding（§12.7 已结论）。spec 显式承认，避免过度承诺。
- runtime tight 窗口仍是 2 snippet（§9 有界上下文的刻意选择，§12.7 调大已 revert）；bigram 改善的是「能不能排进候选/top-2」，不是窗口大小。

## 7. 验收标准

- [ ] 测试 1-7 全绿。
- [ ] 现有 `index.test.ts` / `retrieve-embedding*.test.ts` 不回归。
- [ ] 探针在关 embedding 下，中文近义查询召回排名较修复前提升（量化记录进讨论记录）。
- [ ] `digest-control` Jaccard 分词器未被改动（防漂移隔离）。
