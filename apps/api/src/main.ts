import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { Request, Response, NextFunction } from "express";
import { apiReference } from "@scalar/express-api-reference";
import { AppModule } from "./app.module";
import { apiEnv } from "./env";
import { GlobalErrorFilter } from "./error.filter";

type RateBucket = {
  count: number;
  resetAt: number;
};

const rateBuckets = new Map<string, RateBucket>();

function getBucketKey(prefix: string, value: string) {
  return `${prefix}:${value}`;
}

function consumeRateLimit(key: string, windowMs: number, maxRequests: number) {
  const now = Date.now();
  const existing = rateBuckets.get(key);

  if (!existing || existing.resetAt <= now) {
    const next = { count: 1, resetAt: now + windowMs };
    rateBuckets.set(key, next);
    return { allowed: true, remaining: maxRequests - 1, retryAfterMs: windowMs };
  }

  if (existing.count >= maxRequests) {
    return { allowed: false, remaining: 0, retryAfterMs: existing.resetAt - now };
  }

  existing.count += 1;
  rateBuckets.set(key, existing);
  return { allowed: true, remaining: Math.max(0, maxRequests - existing.count), retryAfterMs: existing.resetAt - now };
}

function rateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
  if (req.path === "/health" || req.path === "/openapi.json" || req.path === "/docs" || req.path.startsWith("/docs/")) {
    next();
    return;
  }

  const userTokenHeader = req.header("x-user-id") || req.header("x-telegram-user-id") || "anonymous";
  const ipHeader = req.header("x-forwarded-for") || req.ip || "unknown";
  const keySeed = `${userTokenHeader}:${ipHeader}`;
  const isTurnRoute = req.method === "POST" && req.path === "/memory/runtime/turn";
  const isScopeCreateRoute = req.method === "POST" && req.path === "/scopes";
  const isAgentScenarioRunRoute = req.method === "POST" && req.path.startsWith("/demo/agent-scenarios/");

  const isWriteRoute = isTurnRoute || isScopeCreateRoute || isAgentScenarioRunRoute;
  const windowMs = isWriteRoute ? apiEnv.demoTurnRateLimitWindowMs : apiEnv.demoRateLimitWindowMs;
  const maxRequests = isWriteRoute ? apiEnv.demoTurnRateLimitMax : apiEnv.demoRateLimitMax;
  const bucket = consumeRateLimit(getBucketKey(isWriteRoute ? "write" : "read", keySeed), windowMs, maxRequests);

  if (!bucket.allowed) {
    res.setHeader("retry-after", Math.max(1, Math.ceil(bucket.retryAfterMs / 1000)).toString());
    res.status(429).json({ error: "Rate limit exceeded. Please slow down and try again." });
    return;
  }

  res.setHeader("x-rate-limit-remaining", bucket.remaining.toString());
  next();
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: ["log", "error", "warn"] });
  app.enableCors({ origin: "*" });
  app.use(rateLimitMiddleware);
  app.use("/docs", apiReference({ url: "/openapi.json" }));
  app.useGlobalFilters(new GlobalErrorFilter());
  await app.listen(apiEnv.port);
}

bootstrap();
