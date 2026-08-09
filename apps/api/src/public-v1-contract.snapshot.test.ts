import { describe, it, expect } from "vitest";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ZodTypeAny } from "zod";
import { PublicV1Contracts } from "@statecore/contracts";

// JsonSchema7Type is a deeply-recursive conditional type; erasing the return
// type to `unknown` here prevents TS2589 "type instantiation is excessively deep".
const toJsonSchema = zodToJsonSchema as unknown as (
  schema: ZodTypeAny,
  opts: { target: "jsonSchema7" }
) => unknown;

describe("public /v1 contract surface (frozen)", () => {
  // These are 15 *operations* — method plus path. They occupy 13 paths in the
  // generated OpenAPI document, because /v1/scopes and /v1/reminders each carry
  // both a GET and a POST. `openapi.test.ts` pins that relationship.
  it("has exactly the 15 designated operations", () => {
    expect(Object.keys(PublicV1Contracts).sort()).toEqual(
      [
        "GET /health",
        "GET /memory/facts",
        "GET /reminders",
        "GET /scopes",
        "GET /state",
        "POST /memory/answer",
        "POST /memory/digest",
        "POST /memory/events",
        "POST /memory/facts/forget",
        "POST /memory/retrieve",
        "POST /memory/runtime/turn",
        "POST /reminders",
        "POST /reminders/:id/cancel",
        "POST /scopes",
        "POST /scopes/:id/active"
      ].sort()
    );
  });

  it("matches the committed JSON-schema snapshot", () => {
    const surface: Record<string, { request?: unknown; response: unknown }> = {};
    const contracts = PublicV1Contracts as unknown as Record<
      string,
      { request?: ZodTypeAny; response: ZodTypeAny }
    >;
    for (const [endpoint, io] of Object.entries(contracts)) {
      const entry: { request?: unknown; response: unknown } = {
        response: toJsonSchema(io.response, { target: "jsonSchema7" })
      };
      if (io.request) {
        entry.request = toJsonSchema(io.request, { target: "jsonSchema7" });
      }
      surface[endpoint] = entry;
    }
    expect(surface).toMatchSnapshot();
  });
});
