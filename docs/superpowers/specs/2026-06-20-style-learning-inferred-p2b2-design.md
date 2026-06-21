# P2b-inferred — Inferred style learning (propose→confirm→adopt) 设计 spec

> 日期：2026-06-20
> 背景接续：`StateCore-记忆引擎-讨论记录.md` §8.2/§8.3/§8.4，§20（P2a 种子），§21（P2b-v1 显式风格）。
> 这是 P2b 的推断阶段：从观察用户消息**推断**交流风格，经**确认**后采纳。
> ★ **数据门（§8.4）**：机制可设计、可用合成数据单测；但「真养出对的风格」需真实使用数据。本 spec 定义机制；实现可分阶段，efficacy 调优待数据。

## 1. 问题

P2b-v1 接了**显式**风格偏好（用户明说「回短点」）。但 §8.2「养成」的核心是**推断**——助手从相处中注意到用户的交流风格，主动适应。当前没有推断通道。§8.2 的硬约束：① 只养**交流风格**不养观点（防马屁精/回声室）；② **噪音抗性**（一天忙回得短 ≠ 永久偏好）；③ **「我注意到…要不要」确认**（保留用户掌控感）。

## 2. 目标 / 非目标

**目标**：周期 job 从用户消息推断交流风格信号（有界维度、带证据），达阈值产生**提议**；用户确认后采纳进 `profile.style`（= P2b-v1 通道 → 系统 prompt）。

**非目标（YAGNI）**：
- 「我注意到…要不要」的**UX 渲染**（app/P3；后端只出 proposals API）。
- 养**观点/价值观/话题**（§8.2 明确不养）。
- 自动采纳（无确认）——被否，违反 §8.2。
- 不动 P2b-v1 显式通道（推断-确认与显式最终同归 profile.style）。

## 3. 架构

```
[周期 job detect-style]（镜像 detect-patterns.ts）
  扫描 scope 近期"用户 authored"消息 → LLM 沿有界维度推断风格 + 证据计数
  → 证据达阈值 & 无重复/冷却冲突 → 写一条 StyleProposal(status=pending)
[API]
  GET  /memory/style-proposals?scopeId        → pending 列表（app 渲染确认）
  POST /memory/style-proposals/:id/confirm     → 采纳：发 style_preference 合成事件（→digest→profile.style）；proposal=confirmed
  POST /memory/style-proposals/:id/dismiss      → proposal=dismissed + 该维度冷却（防唠叨）
```

**采纳归一**：confirm → 走 P2b-v1 的 `style_preference` 路由进 `profile.style` → P2a/P2b-v1 的 `buildRuntimeSystemPrompt` 渲染。推断与显式同一通道、同一渲染、显式靠 recency 主导。

**新存储（Prisma 迁移）**：`StyleProposal { id, scopeId, userId, dimension, value, suggestionText, evidenceCount, status: "pending"|"confirmed"|"dismissed", createdAt, resolvedAt? }`。理由：proposal 有可变生命周期 + 需 app 列出 → 比塞 digest state 或 event 干净。

## 4. 推断维度 + 证据 + 防马屁精

- **有界维度枚举（防马屁精核心）**：`length`(简短/详细)、`emoji`(用/不用)、`language`(中文/英文/中英夹杂)、`formality`(正式/随意)、`tone`(直接/委婉)。这些是**怎么说**不是**信什么**。LLM prompt 显式排除 观点/价值观/立场/话题/政治/信念——若信号不属这些维度，丢弃。
- **信号源**：用户 authored 的 stream 事件（不是助手回复）。从用户怎么写**镜像**推断想要的回复风格。不完美 → 确认门兜底。
- **证据/抗噪**：某维度要在近 ~10-15 条里 ≥N 次一致（N 可配，默认 3）才提议；一次性不触发。
- **一次一个**：只提议最强的未确认信号，不刷屏。

## 5. API + 采纳 + 防唠叨

- `GET /memory/style-proposals?scopeId` → `[{ id, dimension, suggestionText, evidenceCount, createdAt }]`（仅 pending）。
- `POST /memory/style-proposals/:id/confirm`：校验归属 → 发 `classifiedType:"style_preference"`、content=该 proposal 的 value 的合成 stream 事件（走既有 digest 路由）→ proposal.status=confirmed, resolvedAt=now。
- `POST /memory/style-proposals/:id/dismiss`：proposal.status=dismissed, resolvedAt=now。该 `(scopeId, dimension)` 进入冷却。
- **重复/冷却守卫**（job 端）：某维度若有 pending proposal、或近 30 天内被 dismissed、或 `profile.style` 已有覆盖该维度的条目 → job 不为该维度新建 proposal。

## 6. 守卫 + 冷启动

- **马屁精**：维度枚举 + prompt 排除观点 + 一次一个 + 需确认 → 个性只在「怎么相处」演化，不漂观点。
- **噪音**：证据阈值（≥N 一致）+ 确认门 → 一次性行为不改个性。
- **唠叨**：dismissed 维度冷却 + 不重复 pending。
- **冷启动**：消息 < 阈值 → 无提议（job 早退）。= P2a/空 style 行为。

## 7. 测试（合成数据，不依赖真实使用）

- **job 单测**（mock LLM + 合成消息流）：
  - 一致短消息流 → 提议 `length`（evidenceCount ≥ N）。
  - 一次性短消息 → 无提议（低于阈值）。
  - 观点/价值内容 → 不提议（马屁精守卫；维度不匹配即丢）。
  - 某维度 pending/近期 dismissed/已在 profile.style → 不重提。
  - 消息 < 阈值 → 无提议（冷启动）。
- **API 单测**：list 仅 pending；confirm → 发 style_preference 事件 + status=confirmed；dismiss → status=dismissed + 冷却生效（job 不再提该维度）；归属校验（跨用户拒绝）。
- **集成**：confirm 后下一次 digest → profile.style 含该值 → 运行时系统 prompt 含它。
- **非回归**：现有测试 + benchmark 不受影响（新 job/表/端点是增量；profile.style 渲染已在 P2b-v1）。
- **不声称真实 efficacy**（§8.4，需使用数据）。

## 8. 实现分期（数据门）

- **阶段 A（可现在建、合成验证）**：StyleProposal 表 + migration；detect-style job（维度/证据/守卫）；list/confirm/dismiss API；confirm→style_preference 采纳。全部合成数据单测。
- **阶段 B（待真实使用数据）**：维度/证据阈值/冷却时长调优；job 周期；真实 efficacy 评估（推断准不准、确认率、是否扰民）。
- 本 spec 覆盖 A 的机制；B 是参数调优 + 评估，等数据。

## 9. 验收标准（阶段 A）

- [ ] `StyleProposal` 表 + migration；归属隔离（userId/scopeId）。
- [ ] detect-style job：有界维度、证据阈值、马屁精丢弃、重复/冷却守卫。
- [ ] list/confirm/dismiss API；confirm 采纳进 profile.style（经 style_preference 路由）；dismiss 冷却。
- [ ] 合成单测全绿；冷启动无提议；现有测试 + benchmark 不回归；build 绿。
- [ ] P2b-v1 显式通道、`/answer`、relationship-context 不受影响。

## 10. 风险

- **镜像推断不准**（用户自己写得短 ≠ 想要短回复）→ 确认门兜底；dismiss 冷却防烦。
- **马屁精** → 维度枚举 + 排除观点 + 确认（多重）。
- **无法现在验证 efficacy** → 合成单测保机制正确；efficacy 待数据（阶段 B）。
- **app 依赖**：确认 UX 在 app/P3；后端先就绪、app 后接。
