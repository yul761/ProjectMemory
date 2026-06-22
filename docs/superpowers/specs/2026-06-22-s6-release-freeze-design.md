# S6 — Release & Freeze(v1.1.0)

> 记于 2026-06-22 ｜ 隶属 [v1 开发路径](./2026-06-22-statecore-v1-dev-path-design.md) S6,冻结仪式。
> S1–S5 freeze-readiness 已全部完成并合入本地 main(+ 一个原子写 patch)。本步收口。

## 背景:审计结论

- **`v1.0.0` 已是 git tag**(CHANGELOG `## [1.0.0] - 2026-03-18`),**早于** S1–S5。故冻结发布用新版本 **v1.1.0**(minor:additive 特性 + 内部硬化,`/v1` 契约未破坏)。不移动旧 tag。
- **CHANGELOG `[Unreleased]` 过时**:列的是 `apps/adapter-mcp`/cli 等**已被大清理删除**的 app 的特性。必须重写。
- 6 个 package.json 均 `1.0.0`。`.changeset/config.json` 存在,但 CHANGELOG 是**手写**维护的("loosely follows Keep a Changelog")→ 本次走手动 bump + 手写 CHANGELOG + tag,与既有维护方式一致。
- 冷启动基建部分存在:`scripts/smoke-*.sh`(smoke-no-llm / smoke-llm / smoke-runtime / smoke-reminders / smoke-prod-compose)。`docker-compose.local.yml` 全栈。
- **无 `examples/` 目录、无 STABILITY.md**;README 已有 Quickstart + `/v1` 端点表。
- /v1 端点(auth header `x-user-id`):`POST /v1/scopes`、`POST /v1/memory/events`、`POST /v1/memory/digest`、`POST /v1/memory/retrieve`、`GET /v1/memory/stable-state`。

## 工作项

### 1. Worked example:`examples/quickstart.sh` + `examples/README.md`
- curl 脚本,走 `/v1`:建 scope → ingest 一个 document + 一个 stream 事件 → 触发 digest → 轮询/等待 → retrieve + `GET stable-state`,打印每步结果。
- base URL 与 `x-user-id` 经 env 可配(`STATECORE_URL` 默认 `http://localhost:3002`,`STATECORE_USER` 默认 `local-dev-user`——与 CLAUDE.md 本地约定一致)。
- 失败即退出(`set -euo pipefail`),依赖 `curl` + `jq`(在脚本头注明)。
- `examples/README.md`:前置(起栈 + 迁移 + health 绿)+ 怎么跑 + 期望输出。填上清理后"无用例"的洞。**兼作功能性冷启动验证**。

### 2. 冷启动验证(文档化,诚实范围)
- 在 `examples/README.md` 写明冷启动流程:`docker compose -f docker-compose.local.yml up`(或 `pnpm start`)→ Prisma 迁移应用 → `curl /health` 绿 → 跑 `quickstart.sh`;并指向现有 `scripts/smoke-*.sh`。
- **诚实范围**:真正的 live 冷启动跑需用户环境(Postgres/Redis/LLM key)。实现仅做可验证部分:脚本对 /v1 契约正确(端点/header/字段)、迁移链连贯、shellcheck 干净;**不假称跑过完整 live 栈**。

### 3. CHANGELOG 重写
- 删除过时的 `[Unreleased]`(已删除 app 的特性条目)。
- 新增 `## [1.1.0] - 2026-06-22`,如实记录自 1.0.0 以来本代码库实际发生的:
  - **Changed/Removed**:大清理——瘦身成 api+worker+packages(移除 demo-web/adapter-telegram/cli/adapter-mcp 及 demo 代码);移除进程内限流(归网关)。
  - **Added**:S1 漂移 property/fuzz + 对抗测试;S2 无状态/多实例(rebuild 分布式锁、setInterval→BullMQ repeatable jobs、有界 recall 缓存);S3 pgvector HNSW 索引 + 余弦算子修复 + 分项延迟日志;S5 请求体上限 + 413/400 映射;S4 每日 data_gc(digest/snapshot 历史、job 日志、终态提醒);digest+snapshot 原子写;`examples/quickstart.sh`;`STABILITY.md`。
  - **Fixed**:parseGoal 误报 goal_contradiction;HNSW 算子/opclass 不匹配。
- 旧 `[1.0.0] - 2026-03-18` 原样保留为历史。

### 4. STABILITY.md(新)+ README 链接
- 政策文本:自 **v1.1.0** 起 `/v1` 契约冻结——**additive-only**(只可加端点/可选字段,不可改/删既有契约语义),仅 **bug/安全** patch 级修复破例。
- 显式声明:digest/drift **算法**不在 `/v1` 契约内,留活,经**真实数据驱动**的 minor/patch 持续演进——这是唯一保留的实质改动面。
- 链接:README 加一行指向 STABILITY.md。

### 5. 版本 bump + tag
- 6 个 package.json `version` `1.0.0` → `1.1.0`。
- 全套件绿后,打**本地** annotated tag `v1.1.0`(消息含冻结声明摘要)。**不自动推送**(用户控制 push)。

## 测试 / 验证
- `examples/quickstart.sh`:`bash -n`(语法)+ `shellcheck`(若可用)干净;人工核对每个 curl 的端点/header/方法与 /v1 控制器一致(events/digest/retrieve POST、scopes POST、stable-state GET、`x-user-id`)。
- CHANGELOG / STABILITY.md / README:markdown 链接不悬空;无残留已删 app 引用(`grep -i "adapter-mcp\|demo-web\|adapter-telegram" CHANGELOG.md` 应只在历史 [1.0.0] 段或为空)。
- 全 api/worker/core 套件保持绿;**无 /v1 契约改动、OpenAPI 快照不变**(本步不碰运行时代码,只加 examples/docs + 版本号)。
- tag 创建后 `git tag` 含 `v1.1.0`,且旧 `v1.0.0` 未被移动。

## 不做(YAGNI)
- 不改运行时/契约代码(纯 docs/examples/版本)。
- 不引入 changeset 工作流(CHANGELOG 手写维护,保持一致)。
- 不自动 push tag 或提交到 origin(用户控制)。

## /v1 与兼容
- 纯新增 examples + docs + 版本号;无运行时/契约改动;快照不变。
- 本步**确立**冻结政策本身(STABILITY.md);从此 `/v1` 契约冻结。

## 执行
本 spec → writing-plans → subagent 执行(每任务双 review + final 全分支 review)→ 合并 → 打 tag。完成即 freeze。
