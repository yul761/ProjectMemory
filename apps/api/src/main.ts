import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { Request, Response, NextFunction } from "express";
import { apiReference } from "@scalar/express-api-reference";
import { dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { AppModule } from "./app.module";
import { apiEnv } from "./env";
import { GlobalErrorFilter } from "./error.filter";

// Resolve the @scalar/api-reference standalone bundle once at startup.
// We can't use require.resolve("@scalar/api-reference/package.json") because that
// subpath is not listed in the package's exports map, so we walk up from the main entry.
const _scalarMain = require.resolve("@scalar/api-reference");
let _scalarDir = dirname(_scalarMain);
while (_scalarDir !== dirname(_scalarDir) && !existsSync(join(_scalarDir, "package.json"))) {
  _scalarDir = dirname(_scalarDir);
}
const _scalarPkg = JSON.parse(readFileSync(join(_scalarDir, "package.json"), "utf8")) as {
  jsdelivr?: string;
  unpkg?: string;
  browser?: string;
  main?: string;
};
const _scalarBundleRel =
  _scalarPkg.jsdelivr ?? _scalarPkg.unpkg ?? _scalarPkg.browser ?? _scalarPkg.main;
if (!_scalarBundleRel) {
  throw new Error("Could not resolve @scalar/api-reference standalone bundle");
}
const scalarBundlePath = join(_scalarDir, _scalarBundleRel);

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

  const isWriteRoute = isTurnRoute || isScopeCreateRoute;
  const windowMs = isWriteRoute ? apiEnv.turnRateLimitWindowMs : apiEnv.rateLimitWindowMs;
  const maxRequests = isWriteRoute ? apiEnv.turnRateLimitMax : apiEnv.rateLimitMax;
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
  app.use("/docs/scalar.js", (_req: Request, res: Response) =>
    res.type("application/javascript").sendFile(scalarBundlePath)
  );
  app.use("/docs", apiReference({ url: "/openapi.json", cdn: "/docs/scalar.js" }));
  app.useGlobalFilters(new GlobalErrorFilter());
  await app.listen(apiEnv.port);
}

bootstrap();
