# S2 — 无状态化 / 多实例安全

> 记于 2026-06-22 ｜ 隶属 [v1 开发路径](./2026-06-22-statecore-v1-dev-path-design.md) S2。
> 目标:让 `apps/api` 与 `apps/worker` 能安全多副本运行——去掉/修复所有假设单实例的进程内状态。

## 背景:多实例审计结论

已确认的问题(file:line):
- **进程内限流** `rateBuckets` Map(`apps/api/src/main.ts:37`):N 副本 = N 倍限额;无清理循环 = 内存泄漏。
- **`rebuild_digest_chain` 绕过分布式锁**(`apps/worker/src/main.ts:501`):与 `digest_scope` 对同一 scope 并发会写出冲突的 digest 行。
- **3 个 `setInterval` 直接调 DB/LLM**(`apps/worker/src/main.ts:618-643`):`expire_events`(6h,inline `prisma.deleteMany`)、`daily_remind`(24h,`runDailyRemindJob`)、`detect_emotional_patterns`(7d,`runDetectEmotionalPatternsJob`)——每副本各自触发 → 重复执行;对 `daily_remind`/`detect_emotional_patterns`(LLM+写,可能发提醒)是有害重复。
- **recall 缓存无界**(`packages/core/src/assistant-runtime.ts:429-436`):`runtimeRecallCache`/`runtimeResolvedRecallCache` 无清理 → 慢内存泄漏(非正确性问题)。
- **lite-mode InMemoryQueue**(`apps/api/src/queue.ts`):副本间不共享 job,仅限单实例/开发。

已经安全(不动):`digest_scope` 的 `withDigestLock`(Redis 分布式锁,CAS 释放,300s TTL);`send_reminders_tick`(固定 jobId,BullMQ 去重);Prisma 单例;无状态 header auth;OpenAPI 文档缓存(不可变)。

基础设施:Redis(`ioredis` + BullMQ,`REDIS_URL`)、Postgres/Prisma 均在。

## 工作项

### 1. 去掉进程内限流(api)
删除 `rateLimitMiddleware` + `rateBuckets` + `consumeRateLimit`(`apps/api/src/main.ts`),其 `app.use` 注册,`env.ts` 的 `RATE_LIMIT_*`/`TURN_RATE_LIMIT_*`(schema 行 61-64、parsed 行 177-180),以及相关测试与文档/`.env*` 示例引用。限流归托管网关。
- **契约**:`429`/限流**不在** OpenAPI 文档或冻结的 `__snapshots__` 快照里(仅在中间件),故快照保持字节不变——实现任务须验证快照 diff 为空。

### 2. 补 `rebuild_digest_chain` 的分布式锁(worker)
把 `runRebuildDigestChainJob` 包进 `withDigestLock(lockRedis, scopeId, …)`,**复用同一把 `digest-lock:<scopeId>` 锁**(与 `digest_scope` 互斥,二者都写 digest 行)。rebuild 可能更慢 → 用更长 TTL(如 900s),通过 `withDigestLock` 的 TTL 参数传入。

### 3. 三个 `setInterval` 直接调用 → BullMQ repeatable jobs(worker)
将 `expire_events`(6h)、`daily_remind`(24h)、`detect_emotional_patterns`(7d)改为 **BullMQ repeatable jobs**(`queue.add(name, {}, { repeat: { every: <ms> }, jobId/ repeat key 固定 })` 或 `upsertJobScheduler`)。
- **为何 repeatable 而非分桶 jobId**:BullMQ 调度器按 repeat key 在 Redis 中去重,集群内每周期只触发一次——对非幂等的 `daily_remind`/`detect_emotional_patterns` 必须保证单次。分桶 jobId 在"未同步 interval 落入同一桶 + job 完成即被移除"时仍有重复残余,不够。
- 移除这 3 个 `setInterval` 直接调用;handler 接进 worker 的 job-name dispatch(`expire_events` 现为 inline `prisma.deleteMany`,提取成一个 job handler 函数 `runExpireEventsJob(prisma)`;另两个 handler 已存在)。
- `send_reminders_tick`(已安全)**保持不动**,避免无谓扩面。
- LLM 缺失时(`!llm`)job 内保持原有的 no-op 守卫。

### 4. recall 缓存有界化(packages/core)
给 `runtimeRecallCache`/`runtimeResolvedRecallCache` 加**有界 + 机会性清理**,不引入库级 `setInterval`(避免 import 副作用):写入时先删过期项,若仍超硬上限(如 500 条/cache)则驱逐最旧。保持 15s TTL 语义不变。

### 5. lite-mode 单实例约束(文档)
在 `apps/api/src/queue.ts`(InMemoryQueueAdapter 处)加注释,并在一处面向运维的文档(如 `deploy.md` 或 README)写明:`STATECORE_MODE=lite` 仅限单实例/开发;多副本部署必须用 full(Redis)模式。

## 测试(不依赖 live Redis,CI 友好)
- **rebuild 锁**:用 fake redis stub(实现 `set …NX` 与 `eval` CAS)单测 `withDigestLock` 包裹——锁被占时 rebuild 跳过/不执行写;正常路径释放是 CAS。
- **repeatable schedulers**:mock queue,断言三个 job 以正确的 `repeat.every` 注册;断言对应 handler 被 dispatch。`runExpireEventsJob` 单测删除过期事件、保留未过期。
- **recall 缓存**:单测大小有界(超上限驱逐最旧)+ 过期项被清理 + 未过期命中。
- **限流移除**:删除其测试;断言中间件已不在请求路径(可保留一个测试:超额请求不再返回 429)。
- 全 api/worker/core 套件保持绿;OpenAPI 快照 diff 为空。

## /v1 与兼容
- 去限流是行为变更但非 /v1 契约语义变更(端点/schema/错误模型不变),且 429 不在 OpenAPI 契约里;现处冻结前(S6 才冻结),允许。
- 锁与调度改动是 worker 内部,不碰 /v1。
- recall 缓存有界化对调用方透明(命中/未命中语义不变)。

## 产出
- api/worker 可安全多副本:无进程内限流、无单实例调度、并发 worker 下 digest/rebuild 互斥正确、缓存内存有界。
- 托管版扩容不必重开核心。

## 执行
本 spec → writing-plans → subagent 执行(每任务双 review + final 全分支 review)→ 合并。
