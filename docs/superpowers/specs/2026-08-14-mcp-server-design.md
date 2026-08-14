# MCP Server — 内嵌 lite 引擎的零部署记忆服务

> 记于 2026-08-14 ｜ 独立设计（brainstorming 全程结论）。
> 目标：借 DeepSeek Harness 发布窗口为 StateCore OSS 引擎获取开发者关注（stars/心智）。
> 转化目标已明确排序：**OSS 知名度**（主）> 真实使用数据（副产品）> Cloud 收入（不在本期优化）。

## 决策记录（已确认）

| 决策点 | 结论 |
|---|---|
| 转化目标 | A：OSS 知名度。一切默认配置指向自托管；Cloud 只出现在主仓 README，不进任何对外 PR |
| 投入预算 | B：1–2 周，含 lite mode 修缮做到 `npx` 零部署试用 |
| 原生 dsh 插件（自动摄入/注入） | 推迟到 dsh 出 tagged release 后再议（阶段 C），本期只做 MCP |
| 架构 | 方案二：**内嵌引擎 + HTTP 双模**。默认进程内直调 `@statecore/core`（SQLite + 进程内队列，无 NestJS 无 Redis）；`--url` 切换为对完整栈 `/v1` 的 HTTP 客户端 |
| 代码位置 | StateCore monorepo 新包 `apps/mcp`；dsh 仓库只收 ~15 行 overlay 参考配置的 PR |

## 为什么是这个形状

- dsh 没有跨会话持久记忆能力（`session-query` 是原始日志检索，`compaction` 是压缩丢弃）——真空位。
- dsh 官方已收录三个第三方记忆系统的 MCP 参考配置（`examples/mcp-memory/`：Memorix、MCP reference、Engram），姿态明确：只收配置、不管部署。MCP 是被认可的接入类别。
- MCP 是通用协议：同一个 server 同时服务 dsh / Claude Code / Cursor——漏斗不押注单一新平台。
- 零部署（`npx`）是 stars 转化的质变点；现有对手全是单命令启动。要求内嵌而非 HTTP 桥——纯桥模式下 `npx` 起的进程仍需另跑完整栈，故被否决。
- 许可无障碍：dsh 为 MIT（无传染义务），且 MCP 是进程边界 + 协议通信，任何许可证都穿不透。开源胶水 + open-core 指向与既有四层架构一致。

## 工具面（五个动词）

克制原则：工具越多模型用得越差。server 名 `statecore`，宿主内呈现为 `mcp__statecore__<tool>`。

| 工具 | 作用 | 引擎路径 |
|---|---|---|
| `remember` | 写入。默认走**确定性 note 路径**（精确去重、立即成为持久事实、无需 LLM）；`consolidate: true` 时作为 stream event 进 digest 管道 | `addNoteFact` / events |
| `recall` | 带预算检索：`query` + `maxChars`（默认 ~4000），返回 digest+facts+events 与 budget 报告 | retrieve（含 1.5.0 预算装填） |
| `facts` | 当前相信的事实清单，分组、带 factId | memory-facts |
| `why` | **差异化卖点**。factId → 证据 + 完整版本链（含被取代/被退役的历史） | provenance |
| `forget` | 按 factKey 压制；引擎侧 retire 而非删除，审计链保留 | facts/forget |

命名注记：`why` 是刻意的——工具列表里一眼即论点（"why do you believe this"），不用 `get_provenance` 式官腔。

**无 LLM key 降级矩阵**（关键卖点）：`remember`(note)/`facts`/`forget`/`why` 全部照常——note 是确定性写入器、带 evidenceId、落 fact registry。降级仅两项：对话流自动蒸馏（digest 需 key）、语义检索（lite 无 pgvector，剩关键词 + CJK bigram）。README 措辞：「不带 key：确定性记忆 + 完整审计；带 key：外加自动蒸馏」。

**不做**：`digest_now` 工具、MCP resources/prompts（宿主支持参差，v1 靠工具描述引导）、批量导入工具（`ingest:docs` 已存在）。

## scope 映射与落盘

- **身份**：内嵌模式固定单用户 `local`；`--url` 模式凭证走 env。
- **scope = 项目**：`git rev-parse --show-toplevel`，失败则 cwd；归一化绝对路径为 scope 名，首次自动建。`STATECORE_SCOPE` 环境变量可覆盖。与宿主 per-project 逻辑同构。
- **落盘**：单一共享库 `~/.statecore/statecore.db`（`--data` 可改），一库多 scope——不做 per-project 库，保住跨项目用户级事实与未来整库迁移两条路。facet pack 用现成 `project` 域，零改动。
- **并发**：每宿主会话一个 stdio 进程，多进程共写一个 SQLite。WAL + busy_timeout 处理读写；同 scope 并发 digest 用**库内 digest 锁表**防（完整栈用 Redis 锁，lite 无 Redis）；拿锁失败即跳过本轮——digest 是幂等追赶型，跳过无害。
- **不进 v1**：reminders / worker 进程 / 多用户 / pgvector。

## digest 触发（无 worker）

1. **阈值触发（主）**：`consolidate: true` 落库后，scope 未蒸馏事件数过阈值（默认 20，可配）即进程内异步起 digest。fire-and-forget，不堵工具返回；进程内并发钉死 1，跨进程靠锁表。
2. **启动追赶（兜底）**：server 启动检查各 scope 积压并补齐。兜住 SIGKILL 未蒸馏、上次失败、`ingest:docs` 批量灌入三种情况；1.5.0 的 `ingestedAt` 修复保证老事件不被 lookback 窗口漏掉。

不做：退出时触发（进程退出不可靠 + digest 是分钟级 LLM 工作）、空闲定时器。

失败面：无 key → digest 永不触发，note 路径照常，优雅降级非报错；有 key 失败 → 走引擎现成重试 + 一致性门，事件留库等追赶。成本是用户自己的 key，阈值天然限频。

**dsh 侧关键细节**：dsh mcp-client 启动子进程时主动剥除凭证形环境变量——`MODEL_API_KEY` 必须显式写进 overlay 的 `config.env`，此点必须写进 example 配置注释。digest 路径默认不发 `reasoning_effort`，key 指 DeepSeek API 可用（对 dsh 用户是「一 key 两用」卖点）。

## 发布与推广（按依赖排序）

0. **抢名（立即）**：查占 npm `statecore-mcp` / `@statecore` scope——全链条唯一有被抢风险的资产。
1. **构建 + 发 npm v0.1**：本仓第一个公开包（现全部 `private: true`）。
2. **主仓 README 首屏**：30 秒 asciinema（npx → remember ×2 → 改口 → `why` 吐证据链——演示即论点）；LongMemEval 表上提；dsh / Claude Code / Cursor 三段配置并排（漏斗不做 dsh 单口）。
3. **dsh examples PR（时间敏感）**：现在列表仅 3 项，做第 4 项显眼。照其格式：钉版本 + commit SHA、纯自托管、附可复现测试步骤；一行事实描述，无营销话术。**依赖已发布版本，顺序为硬**。
4. **MCP 生态**：`awesome-mcp-servers`（Knowledge & Memory 类）PR；MCP 官方 registry 发布——Claude Code/Cursor 用户的实际入口，池子大于 dsh。
5. **作者亲自出面**：dsh Discord 展示帖、r/LocalLLaMA / r/ClaudeAI、Medium 系列续篇。
6. **不做**：给本仓打 `dsh-plugin` topic——那是原生 dsh 插件的标签，MCP server 不算；C 阶段做了原生插件再打。

## 实现前必须验证的假设（探针清单）

按风险排序，任何一条不成立需回到设计：

1. **lite 路径还能跑**：`schema.lite.prisma` + `STATECORE_MODE=lite` 曾被搁置（W4 标记 shelved），与当前 core（facet registry、drop log、retire、chunked stage 2）的兼容性未验证。探针：lite 模式下走通 ingest → digest → facts → provenance 全链。
2. **note 路径真的无 LLM，且在 project pack 下可达**：设计假设 `addNoteFact` 确定性落 registry 且带 evidenceId、`why` 可查。两个子风险：① `FEATURE_LLM=false` 下 note → facts → provenance 全链是否成立；② `notes` facet 当年是加在 personal pack 里的，本设计选 project pack——若 project pack 不含 notes facet，note 写入会被 `facet_not_registered` 静默丢弃，无 key 卖点即断。不成立则给 project pack 补 notes facet（facet registry 一行）或 MCP 场景发独立 pack。
3. **core 直调可行**：`MemoryService`/`DigestService`/`RetrieveService` 脱离 NestJS 容器直接构造的依赖面（prisma client、queue 适配器、model provider）。他们文档称 core transport-independent，需以最小脚本证实。
4. **SQLite 并发**：Prisma + SQLite 的 WAL/busy_timeout 行为、锁表方案在双进程同 scope 场景下的实测。
5. **npm 名可用性**。

## 成功标准

- `npx statecore-mcp`（或终名）在无任何本地基础设施、无 LLM key 的机器上 30 秒内完成：启动 → remember → facts → why 出证据链。
- 同一 server 在 dsh 与 Claude Code 两个宿主实测可用。
- dsh examples PR 合入（或被拒时有明确记录的原因）。
- 主仓获得可归因于此渠道的关注增量（README referrer / star 时间线与发布节点对照）。
