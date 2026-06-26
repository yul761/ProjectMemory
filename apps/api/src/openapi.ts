import type { ZodTypeAny } from "zod";
import { PublicV1Contracts } from "@statecore/contracts";

type JsonObject = Record<string, unknown>;

// zod-to-json-schema's return type is deeply recursive (TS2589); erase it like
// the contract snapshot test does. Runtime behavior is unchanged.
import { zodToJsonSchema } from "zod-to-json-schema";
const toJsonSchema = zodToJsonSchema as unknown as (
  schema: ZodTypeAny,
  opts: { target: "openApi3"; $refStrategy: "none" }
) => unknown;

function jsonSchema(schema: ZodTypeAny): unknown {
  return toJsonSchema(schema, { target: "openApi3", $refStrategy: "none" });
}

// Response schemas document "at least these fields": some /v1 responses are
// narrowed (W2) to stable top-level fields while the live endpoint still returns
// extra diagnostic fields. zod-to-json-schema emits additionalProperties:false
// for z.object(), which would make the doc wrongly reject those valid responses,
// so open the top level for responses.
function responseSchema(schema: ZodTypeAny): unknown {
  const json = jsonSchema(schema);
  if (json && typeof json === "object" && (json as JsonObject).type === "object") {
    (json as JsonObject).additionalProperties = true;
  }
  return json;
}

function tagFor(path: string): string {
  const seg = path.split("/").filter(Boolean)[0] ?? "default";
  return seg === "state" ? "scopes" : seg;
}

function operationId(method: string, path: string): string {
  const slug = path.replace(/[:/{}]/g, " ").trim().split(/\s+/).filter(Boolean).join("_") || "root";
  return `${method.toLowerCase()}_${slug}`;
}

const errorSchema = {
  type: "object",
  properties: { error: { type: "string" }, details: { type: "array", items: {} } },
  required: ["error"]
};

let cached: JsonObject | null = null;

export function buildOpenApiDocument(): JsonObject {
  if (cached) return cached;

  const paths: Record<string, JsonObject> = {};

  for (const [endpoint, io] of Object.entries(PublicV1Contracts)) {
    const spaceIdx = endpoint.indexOf(" ");
    const method = endpoint.slice(0, spaceIdx);
    const rawPath = endpoint.slice(spaceIdx + 1);
    const v1Path = "/v1" + rawPath.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
    const lower = method.toLowerCase();
    const successCode = method === "GET" ? "200" : "201";

    const op: JsonObject = {
      operationId: operationId(method, rawPath),
      tags: [tagFor(rawPath)],
      responses: {
        [successCode]: {
          description: "Success",
          content: { "application/json": { schema: responseSchema(io.response as ZodTypeAny) } }
        },
        "400": {
          description: "Validation failed",
          content: { "application/json": { schema: errorSchema } }
        }
      }
    };

    const params: JsonObject[] = [...v1Path.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => ({
      name: m[1],
      in: "path",
      required: true,
      schema: { type: "string" }
    }));

    if ("query" in io && io.query) {
      const shape = (io.query as { shape: Record<string, ZodTypeAny> }).shape;
      for (const [name, fieldSchema] of Object.entries(shape)) {
        params.push({
          name,
          in: "query",
          required: !(fieldSchema as { isOptional: () => boolean }).isOptional(),
          schema: jsonSchema(fieldSchema)
        });
      }
    }

    if (params.length) op.parameters = params;

    if ("request" in io && io.request) {
      op.requestBody = {
        required: true,
        content: { "application/json": { schema: jsonSchema(io.request as ZodTypeAny) } }
      };
    }

    if (v1Path === "/v1/health") op.security = [];

    paths[v1Path] = { ...(paths[v1Path] ?? {}), [lower]: op };
  }

  cached = {
    openapi: "3.0.3",
    info: {
      title: "StateCore API",
      version: "1.0.0",
      description: "Frozen public /v1 surface of the StateCore memory runtime."
    },
    servers: [{ url: "/" }],
    components: {
      securitySchemes: {
        apiKey: { type: "apiKey", in: "header", name: "x-user-id" }
      }
    },
    security: [{ apiKey: [] }],
    paths
  };
  return cached;
}
