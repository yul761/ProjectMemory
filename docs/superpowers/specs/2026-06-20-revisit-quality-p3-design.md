# P3 — Revisit quality (proactive recall) 设计 spec

> 日期：2026-06-20
> 背景接续：`StateCore-记忆引擎-讨论记录.md` §7.4（P3 捕获闭环 jot→记住→偶尔回访），§16–§21（P1 profile facets、P2a/b 人味）。
> 范围澄清：jot=`POST /memory/events`、记住=classify/digest 已存在；本 spec 只做**后端可做的 revisit 质量改进**（App 端 UX 是 P3 的另一半，不在本仓）。

## 1. 问题

`runDailyRemindJob`（`apps/worker/src/main.ts`）做主动回访：拉上下文 → LLM 生成朋友式提醒 → POST 到 `scope.notificationWebhook`。但三个质量缺口：

1. **忽略 P1 profile facets**：context 用旧 `stableFacts` + commitments + pendingFollowUps(commitment/experience) + emotionalPatterns，**完全没用** P1 的 `state.profile`（`goals`/`ongoing`/`relationships`/`followUps`）。用户随手记的目标（「想学吉他」→goal）、正在经历的事（「找工作中」→ongoing）从不被回访 → 「你上次说想学吉他怎么样了」这种核心体感缺失。
2. **无防重复**：生成的 reminder **不持久化**，下次跑可能把同一目标再唠叨一遍。
3. **不可测**：`runDailyRemindJob()` 用模块级 `prisma`/`llm` 全局（不像 `runDetectEmotionalPatternsJob(llm, prisma)` 收参）→ 无法单测。

## 2. 目标 / 非目标

**目标**：让主动回访用上 P1 的丰富状态（回访 jotted 目标/正在经历的事/待跟进），且不重复唠叨；并让该 job 可单测。

**非目标（YAGNI）**：
- App 端捕获/回访 UX（P3 的另一半，不在本仓）。
- 不新增 schema（复用现有 `Reminder` 表做持久化/抑制）。
- 不改 jot（ingest 已够）、不改 digest/检索/profile 渲染。
- 不改投递机制（仍 `notificationWebhook`）。

## 3. 设计

### 3.1 可测性重构
`runDailyRemindJob()` → `runDailyRemindJob(llm, prisma)`（镜像 `runDetectEmotionalPatternsJob`）。`main.ts` 的 setInterval 调用点改为传 `llm, prisma`。纯重构、行为不变。

### 3.2 充实 revisit context（主要价值）
job 已加载 `stateSnapshot.state`。在构建 `context` 时加入 P1 profile facets：
```
profile: {
  goals: state.profile?.goals ?? [],
  ongoing: state.profile?.ongoing ?? [],
  followUps: state.profile?.followUps ?? [],
  relationships: state.profile?.relationships ?? []
}
```
（identity 是档案事实、style 是声音，回访不需要 → 不纳入。）LLM 据此可生成「你上次说想学吉他(goal)怎么样了」「找工作(ongoing)有进展吗」「该跟进 X(followUps) 了」。

### 3.3 防重复唠叨（复用 Reminder 表）
- **抑制查询**：job 开头查该 scope 近 14 天 `Reminder` 行（status=`sent`、scopeId、createdAt > 14d ago），取其 `text` 作为 `recentlySurfaced` 列表。
- **喂进 prompt**：context 加 `recentlySurfaced: [...]`，prompt 指令「不要重复 recentlySurfaced 里已说过的」。
- **持久化**：生成 reminders 后、webhook 投递成功后，把每条写成 `Reminder` 行（`userId=scope.userId`, `scopeId`, `text`, `status="sent"`, `dueAt=now`）。
- **不冲突**：`send_reminders` job 只取 `status:"scheduled" & dueAt<=now`；写 `sent` 不会被它重复投递。

### 3.4 prompt 更新
`personal.ts` 的 `dailyReminderPrompt`：纳入新 context 字段（profile.goals/ongoing/followUps/relationships）+ 「避免重复 recentlySurfaced」指令。保持朋友式口吻（非任务清单，§2/§8）。

## 4. 测试（mock llm + prisma，worker 单测，镜像 detect-patterns.test.ts）

新 `apps/worker/src/daily-remind.test.ts`：
1. **充实**：state.profile.goals=["想学吉他"]、ongoing=["找工作中"] → 喂给 LLM 的 context 含这些（断言 LLM mock 收到的 user message 含 "想学吉他"/"找工作中"）。
2. **抑制**：近 14 天有 sent Reminder text="想学吉他…" → context 的 recentlySurfaced 含它（传给 LLM 作 avoid-list）。
3. **持久化**：LLM 返回 2 条 reminder + webhook ok → 2 条 `Reminder` 行（status=sent, scopeId）被写入。
4. **冷启动/空 profile**：state 无 profile → 不崩、context profile 字段为空数组。
5. **无 webhook 的 scope**：跳过（现行为）。
6. **归属**：sent reminders 查询按 scopeId 隔离。

**非回归**：`send_reminders` job（读 scheduled）不受影响；现有 worker 测试绿；`pnpm build` tsc 绿。

## 5. 验收标准

- [ ] `runDailyRemindJob(llm, prisma)` 收参、可测；setInterval 调用点更新。
- [ ] revisit context 含 profile.goals/ongoing/followUps/relationships。
- [ ] 防重复：近 14 天 sent reminders 作 avoid-list 入 prompt；新生成的持久化为 Reminder 行。
- [ ] dailyReminderPrompt 用上新字段 + 避免重复。
- [ ] 单测全绿（充实/抑制/持久化/冷启动/归属）；send_reminders 不回归；build 绿。

## 6. 风险

- **写 Reminder 行污染 send_reminders** → 用 `status="sent"`，send_reminders 只取 scheduled，无冲突（测试覆盖）。
- **prompt 变更影响回访质量** → 保持朋友式口吻；新字段是增量；无 benchmark 覆盖回访（人工抽查）。
- **抑制窗口 14 天是拍的** → 可后续调；不阻塞。
- **App 端 UX 仍缺** → 本 spec 只提升后端回访内容质量；in-app 回访体感是 P3 的 app 半，另起。
