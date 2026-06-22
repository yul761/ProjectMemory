# S3 — 检索规模化 + 延迟可观测

> 记于 2026-06-22 ｜ 隶属 [v1 开发路径](./2026-06-22-statecore-v1-dev-path-design.md) S3。
> 目标:向量检索**规模就绪**(数据涨大不必重开核心)+ 修掉让索引失效的算子 bug + 给 retrieve/digest 加**分项延迟**,让将来的 perf 工作有数据可依。

## 背景:审计结论

- pgvector 迁移(`20260615020000_pgvector_embeddings`)里 HNSW 索引是**注释掉**的:`-- CREATE INDEX ON "MemoryEventEmbedding" USING hnsw (embedding vector_cosine_ops);`(注"超 ~5 万行再开")。
- **算子 / opclass 不匹配 bug**:`apps/api/src/vector-search.ts` 用 `embedding <-> ${v}::vector`(`<->` = L2 距离),而预留索引是 `vector_cosine_ops`(余弦)。Postgres 只在查询算子匹配索引 opclass 时才用 HNSW 索引 → 即便加了余弦索引,L2 查询也不会用它。
- 当前 p95(retrieve ~4.3s / digest ~12s,见 benchmark 报告)由 **LLM/网络主导**(embedding API 调用 + LLM rerank/生成),不是 pgvector 查询(小数据亚毫秒)。HNSW 索引解决**规模**,动不了当前 p95。
- 已有 benchmark runner:`scripts/benchmark/run-benchmark.mjs`(`pnpm benchmark`),docs/benchmarking.md 提及 p50/p95。
- digest-control 已有分项 metrics(`selectionMs/classificationMs/deltaMs/mergeMs/generationMs`)。

## 工作项

### 1. HNSW 索引(新 Prisma raw-SQL 迁移)
新增迁移 `packages/db/prisma/migrations/<timestamp>_hnsw_embedding_index/migration.sql`:
```sql
CREATE INDEX "MemoryEventEmbedding_embedding_hnsw_idx"
  ON "MemoryEventEmbedding" USING hnsw (embedding vector_cosine_ops);
```
现在就加(小表 HNSW 构建开销可忽略),让 schema 冻结前规模就绪。不编辑已应用的旧迁移(那行注释作废即可)。schema.prisma 不变(vector 列由 raw SQL 管理,Prisma 不建模)。

### 2. 算子对齐(`apps/api/src/vector-search.ts`)—— 修 bug
把 `embedding <-> ${vectorString}::vector` 改为 `embedding <=> ${vectorString}::vector`(余弦),匹配 `vector_cosine_ops`,索引才会被用。OpenAI embedding 单位归一化 → L2 与余弦排序等价,检索结果不变。实现时先 `grep -rn "<->" apps packages` 确认没有别处漏改。

### 3. 延迟分项仪表盘(测量,不优化)
- **retrieve**:在检索路径捕获分项耗时 —— embedding 生成 / 向量查询 / rerank —— 暴露为结构化字段(在 retrieve 结果的 metrics 或 benchmark 报告里),benchmark 报告输出这些分项。
- **digest**:确保 benchmark 报告呈现 digest-control 已有的分项 metrics(`selectionMs/classificationMs/deltaMs/mergeMs/generationMs`)。
- 实现以最小、聚焦为准:加 stage 计时 + 在 benchmark 报告里输出分项;不引入新依赖/重度框架。

## 不做(YAGNI / 划出范围)
- **不**降当前 p95(LLM 主导,另开;真实数据下的 LLM-路径优化是冻结后的事)。
- 不动 retrieve 的排序逻辑(算子改动是排序等价的 bug 修复)。
- 不引入新的 metrics/telemetry 框架——复用现有 metrics 结构与 benchmark runner。

## 测试
- **算子改动**:现有 `packages/core/src/retrieve-vector.test.ts` / `retrieve-embedding*.test.ts` 仍绿(排序等价)。grep 确认无遗漏 `<->`。
- **迁移**:`pnpm --filter @statecore/db ...` / `prisma migrate` 能干净应用(migration.sql 语法正确)。
- **"索引真被用"**:小数据 / CI 下 planner 可能仍 seq scan,难在单测断言 → 以"算子匹配 opclass(code review)+ 迁移可应用"为准;`EXPLAIN ANALYZE` 验证作为**可选手动步骤**写进 benchmarking 文档,不进 CI 门。
- **仪表盘**:单测分项计时字段如期产出(stage 计时函数 / metrics 形状),benchmark 报告含分项。
- 全 core/api 套件保持绿;OpenAPI 快照不变(检索内部改动,不碰契约)。

## /v1 与兼容
- 算子改动内部(排序等价);迁移是新增索引(additive);仪表盘是新增 metrics 字段(additive)——全非破坏 /v1。
- 与 S4(数据生命周期)共享 DB / embedding 层 → 串行:S3 先合,S4 紧随其后(off 合并后的 main)。

## 执行
本 spec → writing-plans → subagent 执行(每任务双 review + final 全分支 review)→ 合并。
