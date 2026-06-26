# 把 memory-facts 端点加入公共 `/v1` 契约 + 文档（v1-facts-docs）

> 记于 2026-06-26 ｜ 把两个已实现、已可达的端点 `GET /v1/memory/facts` 和 `POST /v1/memory/facts/forget` **additively** 加入 StateCore 冻结的 `/v1` 公共契约 + 生成的 OpenAPI + Cloud 文档站。
> 约束（已拍板）：**路径不改、保持 `/v1`；`info.version` 不 bump（保持 `1.0.0`）；只写主版本**。正式 v1.1 release-freeze（包版本号 + CHANGELOG，S6 式）以后单独做。

## 背景

两个端点早已实现并通过 cloud 的 `@All /v1/*` 透传可达，契约 `MemoryFactsOutput`/`ForgetFactInput` 也已在 `packages/contracts/src/index.ts` 定义——但**故意没进 `PublicV1Contracts`**（当时为保冻结快照不变）。现在 additively 收录：`/v1` 的 stability 策略本就是「只增不破」，加端点合规。

一个技术点：`GET /v1/memory/facts` 用 **`scopeId` 查询参数**，而当前 OpenAPI 生成器（`apps/api/src/openapi.ts:49-114`）只处理**路径参数 + 请求体**，不支持 query（现有公共 GET 端点都无 query）。要完整文档化该端点，需给生成器加 query 支持（加性增强）。

## 设计

### 1. 契约（`packages/contracts/src/index.ts`）

- 新增两个小 schema（放在 `MemoryFactsOutput`/`ForgetFactInput` 附近）：
  ```
  export const ScopeIdQuery = z.object({ scopeId: z.string().uuid() });
  export const MemoryForgetOutput = z.object({ ok: z.boolean() });
  ```
- 在 `PublicV1Contracts`（`:660-679`）加两条（条目形状扩展为支持可选 `query`）：
  ```
  "GET /memory/facts": { query: ScopeIdQuery, response: MemoryFactsOutput },
  "POST /memory/facts/forget": { request: ForgetFactInput, response: MemoryForgetOutput },
  ```

### 2. OpenAPI 生成器加 query 支持（`apps/api/src/openapi.ts`）

- 现有循环对每个 `PublicV1Contracts` 条目生成 path/operation：处理路径参数（从 `{...}`）+ `io.request`→requestBody。
- **加性扩展**：若条目含 `io.query`（一个 zod object），把它的每个字段 emit 成 OpenAPI `parameters: [{ name, in: "query", required, schema }]`，与现有路径参数合并到 `op.parameters`。required 依据该字段在 zod object 里是否 optional。
- 不改其它生成逻辑；`info.version` 保持 `1.0.0` 不动；路径前缀仍 `/v1`。
- 对 POST forget：`io.request = ForgetFactInput` 走现有 requestBody 逻辑；`io.response = MemoryForgetOutput`。

### 3. 快照（`apps/api/src/public-v1-contract.snapshot.test.ts` + `__snapshots__/`）

- 把"恰好 13 个端点"断言更新为 **15**，并加上两个 key：`"GET /memory/facts"`、`"POST /memory/facts/forget"`（保持数组排序断言）。
- 用 blessed 方式重生成 OpenAPI 快照：`vitest -u`（在 api 包内运行该测试文件并 `-u`）。审查 diff 确认只新增这两个端点的 path/operation（含 GET 的 scopeId query 参数），其余 13 个 byte 不变。

### 4. Cloud 文档（`statecore-cloud`）

- 跑 `pnpm --filter @statecore-cloud/docs sync-openapi`：从**运行中的 core** `/openapi.json` 拉（`STATECORE_OPENAPI_URL` 默认 `http://localhost:3002/openapi.json`，可指向已部署 core）→ 脚本把内部 `x-user-id` 鉴权重写为 `Authorization: Bearer sc_live_...` → 写 `apps/docs/openapi/openapi.json`。
- 审查 git diff（应只多这两个端点）。
- `pnpm --filter @statecore-cloud/docs gen-api-docs`（Docusaurus 重生成 markdown）。
- commit 更新的 `openapi.json` + 生成的 docs。

## 测试

- **生成器 query 支持**：单测/扩展现有 openapi 测试——一个带 `query` 的契约条目 → 生成的 operation 含 `parameters[in=query]`（name/required/schema 正确）。
- **契约**：`ScopeIdQuery`/`MemoryForgetOutput` 解析；`PublicV1Contracts` 含两新端点。
- **快照**：`public-v1` 套件绿（15 端点断言 + 重生成的 `.snap`），其余 13 个端点 operation 未变。
- 既有 api 套件全绿。

## 不做 / 边界

- 不改 API 路径、不 bump `info.version`、不做包版本 1.1.0 freeze（往后单独一轮）。
- 不改端点行为/实现（已部署且不变）——纯契约登记 + 文档。
- query 支持只做到「zod object 的顶层字段 → query 参数」够用即可，不做嵌套/复杂 schema 的 query 展开。

## 验证后 / 部署

1. **StateCore**：core/api 测试绿 + 快照更新 → `pnpm --filter @statecore/{contracts,api} build` → push → 部署 **Droplet 1**（重建 api；无迁移）。`curl 127.0.0.1:3002/openapi.json` 应含两新端点（GET 带 scopeId query）。
2. **statecore-cloud**：sync-openapi（指向已部署 core）+ gen-api-docs + commit + push → 部署 **Droplet 1**（重建 `docs` 容器）。`https://docs.statecore.io` 应能看到两新端点。
