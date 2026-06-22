import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { Request, Response } from "express";
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

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: ["log", "error", "warn"] });
  app.enableCors({ origin: "*" });
  app.use("/docs/scalar.js", (_req: Request, res: Response) =>
    res.type("application/javascript").sendFile(scalarBundlePath)
  );
  app.use("/docs", apiReference({ url: "/openapi.json", cdn: "/docs/scalar.js" }));
  app.useGlobalFilters(new GlobalErrorFilter());
  await app.listen(apiEnv.port);
}

bootstrap();
