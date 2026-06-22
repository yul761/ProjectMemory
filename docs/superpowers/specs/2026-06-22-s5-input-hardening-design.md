# S5 — /v1 入口加固(请求体上限 + 错误映射)

> 记于 2026-06-22 ｜ 隶属 [v1 开发路径](./2026-06-22-statecore-v1-dev-path-design.md) S5。
> 目标:畸形 / 超大输入也稳 —— 不再 500,而是干净的 4xx;请求体有显式可配上限。

## 背景:现状审计

- 控制器用 `@Body() body: unknown` + 逐处 `SomeZodSchema.parse(body)`(`apps/api/src/memory.controller.ts` 等)。ZodError 经 `GlobalErrorFilter` → **400 已干净**。
- `GlobalErrorFilter`(`apps/api/src/error.filter.ts`)当前:`ZodError`→400(含 `details: issues`);`HttpException`→其状态;**其余→500**。
- 没有显式请求体上限——只靠 body-parser 隐式默认(~100kb)。

两个真实健壮性缺口:
1. **超大 payload**:body-parser 的 `PayloadTooLargeError`(`type: "entity.too.large"`)不是 `HttpException` → 落到 **500**(应 413);且上限不可配。
2. **畸形 JSON**:body-parser 的 `SyntaxError`(`type: "entity.parse.failed"`)→ 落到 **500**(应 400)。

## 工作项

### 1. 显式可配 body 上限
- 新增 env `MAX_REQUEST_BODY_BYTES`(`apps/api/src/env.ts`),默认 **1048576(1 MB)**。对长文本 document 宽松,又能挡滥用。
- 在 `apps/api/src/main.ts` 的 `bootstrap()` 显式设置 JSON body 上限为该值。优先用 Nest 的 `app.useBodyParser("json", { limit })`(NestJS v10+);若该 API 在本仓库 Nest 版本不可用,改用等价方式(`NestFactory.create(AppModule, { bodyParser: false })` + `app.use(express.json({ limit }))`)。实现任务须按实际 `@nestjs/platform-express` 版本选定并在报告里说明用了哪种。

### 2. 错误映射加固(`GlobalErrorFilter`)
识别 body-parser 错误(它们带 `type` 与数字 `status`/`statusCode`):
- `type === "entity.too.large"`(或 status 413)→ **413** `{ error: "Request body too large" }`
- `type === "entity.parse.failed"` 或 `instanceof SyntaxError`(body-parser 抛的解析错误)→ **400** `{ error: "Malformed JSON body" }`
- 保留:`ZodError`→400(`details: issues` 是输入形状,非内部信息);`HttpException`→其状态;未知→500(通用消息,不泄露内部 / 不回 stack)。
- 顺序要点:在通用 500 之前、ZodError/HttpException 之后插入 body-parser 分支。

## 测试

- **单测** `apps/api/src/error.filter.test.ts`(若已存在则扩展):构造 host 桩(`switchToHttp().getResponse()` 返回带 `status`/`json` 间谍的 res),断言:
  - `ZodError` → 400 + `error: "Validation failed"`
  - `{ type: "entity.too.large", status: 413 }` → 413 + `error: "Request body too large"`
  - `{ type: "entity.parse.failed" }` / `new SyntaxError(...)` 带 body-parser 标记 → 400 + `error: "Malformed JSON body"`
  - `HttpException` → 其状态
  - 未知 `new Error("boom")` → 500 + 通用消息(不含 "boom")
- **集成测**(复用 `apps/api/src/test/` 现有集成 harness):
  - POST 超过 `MAX_REQUEST_BODY_BYTES` 的 JSON body → **413**(证明 body 上限真的生效)。
  - POST 畸形 JSON(如 `"{ bad json"`)→ **400**。
- 全 api 套件保持绿;**OpenAPI 快照保持字节不变**(错误响应不在契约 schema 里,不应改快照)。

## 不做(YAGNI)
- 不引入全局 Zod `ValidationPipe` / 重写逐端点 `.parse()` —— 现有 `.parse()` 已给干净 400,重写是 DRY 不是健壮性。
- 不动 `/v1` 契约 schema / OpenAPI(只是更稳的错误状态码)。

## /v1 与兼容
- 纯 api 层(main.ts bootstrap + error.filter + env)。不碰 DB / worker / 契约 schema。与 S3/S4(DB 层)零重叠 —— 可独立并行、独立合并。

## 执行
本 spec → writing-plans → 在独立 worktree 后台实现(单 agent TDD,事后整分支 review)→ 合并。
