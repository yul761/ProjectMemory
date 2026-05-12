// apps/adapter-mcp/src/api-client.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { apiFetch } from "./api-client";

describe("apiFetch", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns parsed JSON on success", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "abc" })
    });
    const result = await apiFetch("/scopes", "local-dev-user", "http://localhost:3000");
    expect(result).toEqual({ id: "abc" });
  });

  it("retries on 503 then succeeds", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "abc" }) });
    const result = await apiFetch("/scopes", "local-dev-user", "http://localhost:3000");
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ id: "abc" });
  });

  it("returns error object after 3 failures", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    const result = await apiFetch("/scopes", "local-dev-user", "http://localhost:3000");
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(result).toHaveProperty("error");
  });
});
