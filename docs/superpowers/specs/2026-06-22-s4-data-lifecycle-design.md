# S4 — 数据生命周期 / GC

> 记于 2026-06-22 ｜ 隶属 [v1 开发路径](./2026-06-22-statecore-v1-dev-path-design.md) S4。冻结就绪(S1–S5)的最后一块。
> 目标:用集群安全的 repeatable GC job 限制长跑膨胀,绝不删活跃状态或待发提醒。

## 背景:审计结论

会无界增长的表(均有时间戳):
- `Digest` / `DigestStateSnapshot` —— 每次 digest 运行各 +1 行,无过期。**最大膨胀源**。
- `DigestJobLog` —— 每个 digest job 一条;时间列是 **`completedAt`**(非 createdAt)。纯运维日志。
- `Reminder` —— terminal(sent/cancelled)残留;`scheduled` 是待发的。

关键事实:
- **活跃状态 = 每 scope 最新的 digest + 其 snapshot**。digest 管道与 rebuild(full / since_last_good)都只读 `findFirst orderBy createdAt desc` 的最新一条;更老的 digest/snapshot 只被 list-history API 读。→ **永不删每 scope 最新那条**即可安全 GC 更老的。
- `DigestStateSnapshot.digest` 关系**无 `onDelete: Cascade`**(默认 Restrict)→ 删 digest 前必须**先删其 snapshot**,否则 FK 报错。snapshot 是 `digestId @unique`(每 digest 一条)。
- `MemoryEvent.expiresAt` 扫描已由 S2 的 `expire_events` repeatable job 处理;`MemoryEventEmbedding` 是 `ON DELETE CASCADE`,随事件删除一起 GC。`expiresAt=null`(持久记忆)本就该长期保留。
- `WorkingMemorySnapshot` 是 `scopeId @unique`(每 scope 一条,upsert)→ 有界,**不 GC**。
- `ReminderStatus` 枚举 = `scheduled | sent | cancelled`。

## 工作项(全部:硬删、按龄窗口、env 可配;扩展 S2 的 `maintenance` worker)

### 1. Digest + snapshot 历史 GC(`DIGEST_RETENTION_DAYS`,默认 90)
- 每 scope **永远保留最新 digest**(= 活跃状态),无论多旧。
- 删 `createdAt < cutoff` 且**非该 scope 最新**的 digest;因无 FK 级联,**先删配对 snapshot 再删 digest**(FK-safe 顺序)。
- 实现路径(可 stub 单测):找有"过期 digest"的 scopeId 集 → 每个 scope `findFirst` 最新 digest id 加以保护 → 该 scope 下删 `createdAt<cutoff && id≠latestId` 的 `DigestStateSnapshot`(按这些 digestId)→ 再删这些 `Digest`。
- rebuildGroupId:按龄自然 GC 老的 rebuild group 历史;rebuild 只读最新,故无碍。

### 2. DigestJobLog GC(`JOB_LOG_RETENTION_DAYS`,默认 30)
- `deleteMany where completedAt < cutoff`(注意列名是 `completedAt`)。纯日志,直接删。

### 3. Reminder GC(`REMINDER_RETENTION_DAYS`,默认 30)
- `deleteMany where status in [sent, cancelled] AND createdAt < cutoff`。**保留 `scheduled`**(待发)无论多旧。

### 4. 事件过期扫描 —— 不动
- S2 的 `expire_events` 已扫 `expiresAt < now` 的 MemoryEvent;embedding 随之级联删。S4 不重复,仅在文档里点明它属于同一生命周期家族。

## 机制
- 提取可测函数:`runGcDigestsJob(prisma, retentionDays)`、`runGcJobLogsJob(prisma, retentionDays)`、`runGcRemindersJob(prisma, retentionDays)`(各返回删除计数)。
- 在 S2 的 `maintenance` worker 的 dispatch 里加一个 `data_gc` 分支,调用这三者并汇总计数日志。
- 注册一个**每日** repeatable scheduler(`upsertJobScheduler("data-gc-daily", { every: 24h }, { name: "data_gc", opts: { removeOnComplete, removeOnFail } })`),沿用 S2 模式。
- 三个保留天数 env 在 `apps/worker/src/env.ts`,默认 90/30/30。

## 测试(stub prisma,worker main.ts 不可单测)
- `runGcDigestsJob`:旧但最新 → 保留;窗口内 → 保留;旧且非最新 → 删,且**断言 snapshot 删除发生在 digest 删除之前**(FK-safe 顺序);多 scope 时各自保护自己的最新。
- `runGcJobLogsJob`:按 `completedAt < cutoff` 删,断言 where 用的是 completedAt。
- `runGcRemindersJob`:删 terminal(sent/cancelled)旧的;保留 scheduled(即便旧)与近期。
- 全 worker/core/api 套件保持绿;**无 schema/迁移改动**;OpenAPI 快照不变。

## 不做(YAGNI / 划出范围)
- 不 GC `MemoryEvent`(expiresAt 由 S2 处理;持久记忆该留)、不 GC `WorkingMemorySnapshot`(每 scope 一条)、不额外 GC embedding(cascade 已覆盖)。
- 不软删/不加 tombstone(历史/日志硬删即可,避免给即将冻结的核增复杂度)。
- 不加 schema 字段 / 不加迁移(纯删除查询 + env)。

## /v1 与兼容
- 纯 worker/DB GC;无契约 schema 改动、无迁移;快照不变。与已合并的 S1/S2/S3/S5 无冲突。

## 执行
本 spec → writing-plans → subagent 执行(每任务双 review + final 全分支 review)→ 合并。完成后 S1–S5 冻结就绪全部完成,下一步 S6 冻结。
