import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NotFoundException, BadRequestException, HttpException } from "@nestjs/common";
import type { ArgumentsHost } from "@nestjs/common";
import { z, ZodError } from "zod";
import { logger } from "@statecore/core";
import { GlobalErrorFilter } from "./error.filter";

function makeHost(): { host: ArgumentsHost; status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const host = {
    switchToHttp: () => ({ getResponse: () => ({ status }) })
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

describe("GlobalErrorFilter", () => {
  let filter: GlobalErrorFilter;

  beforeEach(() => {
    filter = new GlobalErrorFilter();
    vi.spyOn(logger, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps NotFoundException to 404 with error message", () => {
    const { host, status, json } = makeHost();
    filter.catch(new NotFoundException("Scope not found"), host);
    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({ error: "Scope not found" });
  });

  it("maps BadRequestException to 400 with error message", () => {
    const { host, status, json } = makeHost();
    filter.catch(new BadRequestException("scopeId required"), host);
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({ error: "scopeId required" });
  });

  it("maps unknown errors to 500 with generic message", () => {
    const { host, status, json } = makeHost();
    filter.catch(new Error("database exploded"), host);
    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({ error: "Internal server error" });
  });

  it("maps generic HttpException to correct status", () => {
    const { host, status, json } = makeHost();
    filter.catch(new HttpException("custom error", 422), host);
    expect(status).toHaveBeenCalledWith(422);
    expect(json).toHaveBeenCalledWith({ error: "custom error" });
  });

  it("maps ZodError to 400 with validation details", () => {
    const { host, status, json } = makeHost();
    const parsed = z.object({ scopeId: z.string() }).safeParse({});
    const error = (parsed as { success: false; error: ZodError }).error;
    filter.catch(error, host);
    expect(status).toHaveBeenCalledWith(400);
    const payload = json.mock.calls[0][0] as { error: string; details: unknown[] };
    expect(payload.error).toBe("Validation failed");
    expect(Array.isArray(payload.details)).toBe(true);
    expect(payload.details.length).toBeGreaterThanOrEqual(1);
  });

  it("logs unexpected (500) errors via logger.error", () => {
    const { host } = makeHost();
    filter.catch(new Error("database exploded"), host);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("maps an oversized-body error (entity.too.large) to 413", () => {
    const { host, status, json } = makeHost();
    filter.catch({ type: "entity.too.large", status: 413, message: "request entity too large" }, host);
    expect(status).toHaveBeenCalledWith(413);
    expect(json).toHaveBeenCalledWith({ error: "Request body too large" });
  });

  it("maps a malformed-JSON body-parser error (entity.parse.failed) to 400", () => {
    const { host, status, json } = makeHost();
    filter.catch({ type: "entity.parse.failed", status: 400, message: "Unexpected token" }, host);
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({ error: "Malformed JSON body" });
  });

  it("maps a body-parser SyntaxError to 400", () => {
    const { host, status, json } = makeHost();
    const err = Object.assign(new SyntaxError("Unexpected token } in JSON"), { type: "entity.parse.failed", status: 400 });
    filter.catch(err, host);
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({ error: "Malformed JSON body" });
  });

  it("does not leak internals for an oversized error (no raw message echoed)", () => {
    const { host, json } = makeHost();
    filter.catch({ type: "entity.too.large", status: 413, message: "request entity too large; limit 1048576" }, host);
    const payload = json.mock.calls[0][0] as { error: string };
    expect(payload.error).toBe("Request body too large");
  });
});
