# P2b-v1 — Explicit style preferences (养成 v1) 设计 spec

> 日期：2026-06-20
> 背景接续：`StateCore-记忆引擎-讨论记录.md` §8（人味=种子+养成），§20（P2a 种子接入）。
> 这是 P2b 的第一刀：**显式风格偏好**（用户决策）。推断式养成是后续、依赖真实使用数据（§8.4）。

## 1. 问题

P2a 把**种子** persona 接进了 runtime 系统 prompt。但「养成」（§8.2/§8.3）还没有：用户明确说的交流偏好（「回短点」「别用 emoji」「用中文回我」）当前**没有通道**——会被分类成 `noise`/`personal_detail`，**从不影响助手的声音**。P2b-v1 建这个通道：显式风格偏好 → 习得风格 → 注入人格。

§8.3 核心洞察：风格画像 = 与「记忆不漂移」同一个工程问题 → 复用 digest/state/facet 机制。但**输出目的地不同**：事实 facet → State 块（记忆上下文）；风格 → **系统 prompt 的人格段**（声音）。

## 2. 目标 / 非目标

**目标**：用户明确陈述的交流偏好 → 存进 `DigestState.profile.style`（复用 facet 路由）→ 渲染进 runtime 系统 prompt 的人格段（种子 + 习得风格）。零数据依赖、可单测、天然抗噪、低马屁精风险。

**非目标（YAGNI / 留给 P2b 推断阶段）**：
- 从观察用户行为**推断**风格（§8.2/§8.4，依赖真实使用数据、马屁精/回声室风险、需证据累积）。
- 「我注意到…要不要」确认（§8.2）——属推断阶段（显式偏好是用户主动说的，无需确认）。
- 维度感知的矛盾消解（短 vs 详细的语义对立）——v1 靠 recency 淘汰兜底。
- 用户可配置 persona（§8.1 已定不做）；不动 `/memory/answer`、不动 `relationship-context.ts`。

## 3. 架构

```
用户说「回短点/别用emoji/用中文」
  → 分类器新实体类型 style_preference
  → digest 路由进 DigestState.profile.style（复用 PROFILE_FACET_ROUTING，volatile）
  → controller 运行时读 profile.style → 渲染进系统 prompt 人格段（扩 P2a 注入点）
```

**关键决策**：style 渲染进**系统 prompt**（声音），**不进 State 块**（记忆）。`profile.style` 存在 `DigestState.profile`，但**不加入 `StateLayerView`/`formatStateLayerView`**。

## 4. 风格捕获 + 取代

- **分类器**（`packages/core/src/domain-configs/personal.ts`）：`entityTypes` 加 `style_preference`（description：用户对**怎么跟 ta 交流**的明确偏好——长度/emoji/语言/正式度/语气）；`classificationSystemPrompt` 加指引 + 例子（「回短点」「别用表情」「用中文回我」「说话别太正式」），并强调**只有明确陈述**才算（"今天忙" 等一次性闲聊 → noise，不是 style）。retention: long-term；driftProtected: **false**；conflictDetectable: false。
- **路由**：`PROFILE_FACET_ROUTING` 加 `style_preference: { facet: "style", cap: 6, writeProtected: false }`（**volatile 路径**：dedup via `sameFactCjkAware` + 满 cap 淘汰最旧）。`DigestState.profile.style?: string[]` + Zod 契约。
- **取代 = recency-wins（不写保护）**：风格须能演化（「回短点」→ 后来「可以详细点」是改主意，新的该主导）。volatile 路径满 cap 淘汰最旧 → 最新偏好长期主导，天然处理「改主意」。
- **抗噪（§8.2）由分类器兜**：只有明确陈述成 style_preference；行为噪音（忙了一天回得短）不是显式指令、分不成 style。故 v1 不需写保护抗噪。
- **已知 v1 局限**：cap 内的跨维度语义矛盾（短 vs 详细，词不重叠）可能短暂共存，靠 recency 淘汰兜底；维度感知留给推断阶段。

## 5. 渲染（扩 P2a 注入点）

`buildRuntimeSystemPrompt` 扩成三段：`buildRuntimeSystemPrompt(persona: string|null, styleLines: string[] | null, base: string)`：
```
[种子人格]                 ← P2a（persona 非空时）
交流风格（用户要求）:        ← 新，仅当 styleLines 非空
- 回复简短
- 用中文
[base 操作/grounding 规则]  ← 最后，权威
```
- styleLines 空 + persona 空 → base 原样。styleLines 空 + persona 非空 → = P2a 行为（只种子）。
- base 永远最后（grounding 权威，不被语气/风格盖过）。
- **controller**：runtime-turn handler 已解析 persona（P2a）；再读最新 `DigestState.profile.style`（controller 已能取 digest state，如 `getLatestDigestState(scopeId)`）→ 传入。

> 向后兼容：P2a 的 `buildRuntimeSystemPrompt(persona, base)` 签名变了。两种处理：(a) 改成 `(persona, styleLines, base)` 三参并更新 P2a 调用点；(b) 加重载。选 (a)——单一签名更清晰，P2a 唯一调用点（createRuntimeSession）一起更新。P2a 的现有单测同步更新。

## 6. 测试

**单元（不起服务）：**
1. 路由：`classifiedType:"style_preference"` 事件 → `profile.style`；不进 fact-registry；dedup；cap 6 淘汰最旧。
2. `feeling`/`noise`/`personal_detail` 不进 style。
3. `compileStateLayerView` 输出**不含** style（State 块不渲染声音）。
4. `buildRuntimeSystemPrompt(persona, styleLines, base)`：styleLines 非空 → persona、style 段、base 顺序正确；styleLines 空 → 退回 P2a 行为；base 最后。
5. P2a 现有 `buildRuntimeSystemPrompt` 测试同步更新为三参签名，仍绿。

**集成 / 行为：**
6. personal scope，profile.style 有偏好 → runtime 系统 prompt 含「交流风格」段、含偏好文本。

**非回归：**
7. benchmark：style 是增量 volatile facet + 不进 State 块 → 预期 digest/retention/runtimeGrounding 不回归。跑一次确认。
8. 现有测试全绿；`pnpm build` tsc 通过。

## 7. 验收标准

- [ ] 明确风格偏好（中/英）→ `profile.style`（volatile、recency-wins、不进 State 块）。
- [ ] runtime 系统 prompt = 种子 persona + 习得风格 + base（顺序、base 权威）。
- [ ] style 空时 = P2a 行为（只种子）。
- [ ] `feeling`/`noise` 不污染 style；`/memory/answer`、relationship-context 不变。
- [ ] benchmark 不回归；build 绿。

## 8. 风险

- **分类器误判**（把闲聊判成 style_preference）→ classificationSystemPrompt 强调「仅明确陈述」+ 例子；cap 6 + recency 限制污染面。
- **跨维度矛盾**（短 vs 详细）→ recency 淘汰兜底；v1 已知局限，文档声明。
- **签名变更影响 P2a** → 同一改动里更新 P2a 调用点 + 测试（§5 备注）。
- **风格盖过 grounding** → base 永远最后；benchmark runtimeGrounding 把关（同 P2a）。
