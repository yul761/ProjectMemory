import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "../app.module";
import { configureApp } from "../configure-app";

export async function createTestApp(opts: { maxBodyBytes?: number } = {}): Promise<INestApplication> {
  const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = module.createNestApplication<NestExpressApplication>();
  configureApp(app, { maxBodyBytes: opts.maxBodyBytes ?? 1048576 });
  await app.init();
  return app;
}
