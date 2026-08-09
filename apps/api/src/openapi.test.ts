import { describe, it, expect } from "vitest";
import { buildOpenApiDocument } from "./openapi";

type SecuritySchemes = { apiKey?: { type: string; in: string; name: string } };
type Op = { security?: unknown[] };

describe("buildOpenApiDocument", () => {
  const doc = buildOpenApiDocument();
  const paths = doc.paths as Record<string, Record<string, Op>>;

  it("is an OpenAPI 3.0.x document", () => {
    expect(String(doc.openapi)).toMatch(/^3\.0\./);
    expect(typeof doc.info).toBe("object");
  });

  it("documents exactly the 18 /v1 operations across 16 paths", () => {
    // Two numbers describe this surface and they are not the same number.
    // `/v1/scopes` and `/v1/reminders` each carry both GET and POST, so 18
    // operations sit on 16 paths. Anyone counting `Object.keys(doc.paths)`
    // against the contract registry's 18 entries finds a mismatch that is not
    // one; pinning both here means the relationship is stated rather than
    // rediscovered. It also catches a real fault the operation count alone
    // would miss: a path registered twice keeps the operation count at 18
    // while the path count moves.
    const opCount = Object.values(paths).reduce(
      (n, methods) => n + Object.keys(methods).length,
      0
    );
    expect(opCount).toBe(18);
    expect(Object.keys(paths)).toHaveLength(16);
    expect(Object.keys(paths).every((p) => p.startsWith("/v1/"))).toBe(true);
  });

  it("gives DELETE its 200, not the 201 that belongs to POST", () => {
    // The success code used to be derived from "is this a GET", which was
    // indistinguishable from correct while POST and GET were the only verbs on
    // this surface. DELETE /v1/scopes/:id arrived and made it wrong.
    const del = paths["/v1/scopes/{id}"].delete as { responses: Record<string, unknown> };
    expect(Object.keys(del.responses).sort()).toEqual(["200", "400"]);
    const post = paths["/v1/scopes"].post as { responses: Record<string, unknown> };
    expect(Object.keys(post.responses).sort()).toEqual(["201", "400"]);
  });

  it("collapses exactly the two paths that carry more than one method", () => {
    const multi = Object.entries(paths)
      .filter(([, methods]) => Object.keys(methods).length > 1)
      .map(([path]) => path)
      .sort();
    expect(multi).toEqual(["/v1/reminders", "/v1/scopes"]);
  });

  it("emits scopeId as a required query parameter on GET /v1/memory/facts", () => {
    const op = paths["/v1/memory/facts"].get as { parameters?: Array<{ name: string; in: string; required?: boolean }> };
    const scopeId = op.parameters?.find((p) => p.name === "scopeId" && p.in === "query");
    expect(scopeId).toBeDefined();
    expect(scopeId?.required).toBe(true);
  });

  it("declares the x-user-id apiKey security scheme, applied globally", () => {
    const schemes = (doc.components as { securitySchemes: SecuritySchemes }).securitySchemes;
    expect(schemes.apiKey).toEqual({ type: "apiKey", in: "header", name: "x-user-id" });
    expect(doc.security).toEqual([{ apiKey: [] }]);
  });

  it("marks GET /v1/health as public (security: [])", () => {
    expect(paths["/v1/health"].get.security).toEqual([]);
  });

  it("converts :id path params to {id} with a path parameter", () => {
    const op = paths["/v1/scopes/{id}/active"].post as { parameters?: Array<{ name: string; in: string }> };
    expect(op.parameters?.some((p) => p.name === "id" && p.in === "path")).toBe(true);
  });

  it("matches the committed snapshot", () => {
    expect(doc).toMatchSnapshot();
  });
});
