import { describe, it, expect, vi, beforeEach } from "vitest";
import { NotFoundException, BadRequestException, HttpException } from "@nestjs/common";
import type { ArgumentsHost } from "@nestjs/common";
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
});
