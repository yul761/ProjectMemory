# P2a — Seed persona injection (人味 v1) 设计 spec

> 日期：2026-06-20
> 背景接续：`StateCore-记忆引擎-讨论记录.md` §8（人味=种子+养成）。这是 P2 的第一步。
> 前序完成：P0 检索、P1 状态骨架（§16–19）。

## 1. 问题（探索发现）

讨论记录 §8.4 假设「v1 种子人格已有、够用、先上」。**代码事实推翻了这个假设**：

- `defaultPersonaPrompt`（warm-companion 种子，`packages/core/src/domain-configs/personal.ts:64`）**只被 `relationship-context.ts:87` 读取**——而 `relationship-context` 是只读 JSON API（`GET /memory/relationship-context/:scopeId`），**从不注入任何模型 prompt**（§18.1 已确认）。
- 实际模型 prompt 是通用的：`runtimeSystemPrompt`（"Fast Layer assistant"）、`answerSystemPrompt`（"memory-backed assistant"），**零 persona**。`assistant-runtime.ts` 不注入任何 persona。

→ **产品主打的「人味」当前根本没进回复**——每条回复都是通用助手口吻。P2a 修这个地基。

## 2. 目标 / 非目标

**目标**：把 scope 的种子 persona 真正注入 **runtime turn**（聊天轮）的系统 prompt，让回复有「随身私人秘书」的语气。零数据依赖、立即可交付。

**非目标（YAGNI / 留给 P2b）**：
- 养成层 / 交流风格画像（§8.2/§8.3）。
- "我注意到…要不要…" 确认（§8.2）。
- 用户可配置 persona（§8.1 已定**不做**——v1 是出厂种子）。
- `/memory/answer` 路径**不加** persona（用户决策）：它是严格事实检索（"只用记忆回答、不推断"），人味与其严格性冲突。
- 不动 `relationship-context.ts`。

## 3. 范围（用户决策）

**只 runtime 路径**。`memory.controller.ts` 的 runtime turn handler（~line 337，`system: runtimeSystemPrompt`）。answer 路径（~846）保持原样。

## 4. 设计

### 4.1 Core 纯函数（可单测）

`buildRuntimeSystemPrompt(persona: string | null | undefined, base: string): string`
- persona 非空（trim 后有内容）→ 返回 `${persona.trim()}\n\n${base}`
- persona 为空/undefined → 返回 `base` 原样

放在 core（紧邻 runtime 相关代码，如 `assistant-runtime.ts` 或一个小模块），从 `@statecore/core` 导出。纯函数、无副作用。

### 4.2 persona 来源

`getDomainConfig(scope.template)?.defaultPersonaPrompt ?? null`（`getDomainConfig` 已在 core 导出）。
- personal → warm-companion 种子
- health → supportive 种子
- **project → 无 `defaultPersonaPrompt` → null → base 原样**（task-oriented 不强加人味）

### 4.3 Controller 接线

runtime turn handler：取当前 scope 的 `template`，算出 persona，`system: buildRuntimeSystemPrompt(persona, runtimeSystemPrompt)`。scope 已可由 `this.domain.projectService.getScope(userId, scopeId)` 取得（controller 其他 handler 已这么用）；若 runtime handler 尚未加载 scope，则加载它（仅取 template，开销可忽略）。

### 4.4 顺序 / 张力（关键正确性点）

persona 在前（定「你是谁 / 语气」），base runtime 指令在后。理由：base 的 grounding/操作规则（"别声称 Working Memory / State 更新已提交除非上下文显示"、"分清来自当前 turn vs 召回上下文"、"默认简洁"）必须保持权威，不能被 persona 的"热情好奇"语气盖过。把 base 放在 persona 之后，确保操作约束是最后、最强的指令。persona 的"casual/warm/concise/不是任务管理器"与 base"默认简洁"相容、不矛盾。

## 5. 测试

**单元（纯函数，不起服务）：**
1. persona 非空 → 输出含 persona 文本 + base，persona 在前。
2. persona = null/undefined/空串 → 输出 === base（无前缀、无多余空行）。

**集成 / 行为：**
3. personal scope 的 runtime turn → 发给模型的系统 prompt 含 warm-companion persona 文本。
4. project scope 的 runtime turn → 系统 prompt **不含** persona（=== base）。
（可通过对 `buildRuntimeSystemPrompt` 的组合 + 一个 controller 层断言验证；若 controller 集成测试成本高，至少单测纯函数 + 一个 getDomainConfig→persona 的映射断言。）

**非回归：**
5. **benchmark `runtimeGrounding` 不掉分**：加 persona 可能影响 runtime 的 grounding 表现 → 跑 benchmark 确认 runtimeGrounding（及 overall）不回归。answer 路径未动，digest/retention 不受影响。
6. 现有测试全绿；`pnpm build` tsc 通过。

## 6. 验收标准

- [ ] runtime turn 的系统 prompt 对 personal/health scope 含种子 persona；project scope 不含。
- [ ] `/memory/answer` 行为不变（未注入 persona）。
- [ ] `buildRuntimeSystemPrompt` 纯函数单测通过；persona 在前、base 权威在后。
- [ ] benchmark runtimeGrounding / overall 不回归。
- [ ] `relationship-context.ts` 未改动。

## 7. 风险

- **persona 削弱 memory-grounding** → benchmark runtimeGrounding 把关；persona 在前、操作规则在后；必要时在组合里强调 grounding 优先。
- **persona 与"简洁"张力** → 文案相容（warm 但 concise）；benchmark + 人工抽查。
- **后续 P2b 衔接**：本设计把 persona 注入点做成可组合（`buildRuntimeSystemPrompt`），P2b 的养成风格画像将作为**第二段**叠加（persona 种子 + 习得风格），注入点已就位。
