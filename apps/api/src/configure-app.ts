import type { NestExpressApplication } from "@nestjs/platform-express";
import { GlobalErrorFilter } from "./error.filter";

// Single source of truth for HTTP-layer app wiring, used by both production
// bootstrap (main.ts) and the integration test app (test/setup.ts), so tests
// exercise the same body-size limit + error mapping as production.
export function configureApp(app: NestExpressApplication, opts: { maxBodyBytes: number }): void {
  app.useBodyParser("json", { limit: opts.maxBodyBytes });
  app.useGlobalFilters(new GlobalErrorFilter());
  // Express 4-arg error handler: body-parser errors (entity.too.large / entity.parse.failed /
  // SyntaxError) can bypass the Nest GlobalErrorFilter and reach Express's default error handler
  // instead. This middleware intercepts them and returns the same JSON shape as the filter.
  app.use((err: any, _req: any, res: any, next: any) => {
    if (err?.type === "entity.too.large") return res.status(413).json({ error: "Request body too large" });
    if (err?.type === "entity.parse.failed" || err instanceof SyntaxError) return res.status(400).json({ error: "Malformed JSON body" });
    return next(err);
  });
}
