import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { AppModule } from "../app.module";
import { GlobalErrorFilter } from "../error.filter";

export async function createTestApp(): Promise<INestApplication> {
  const module = await Test.createTestingModule({
    imports: [AppModule]
  }).compile();

  const app = module.createNestApplication();
  app.useGlobalFilters(new GlobalErrorFilter());
  await app.init();
  return app;
}
