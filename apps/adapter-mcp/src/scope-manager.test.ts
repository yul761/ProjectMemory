// apps/adapter-mcp/src/scope-manager.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock is hoisted above imports by vitest
vi.mock("./api-client");
vi.mock("./env", () => ({
  mcpEnv: { apiBaseUrl: "http://localhost:3000", token: "local-dev-user", userId: "mcp-user" }
}));

import { apiFetch } from "./api-client";
import { ScopeManager } from "./scope-manager";

const mockApiFetch = vi.mocked(apiFetch);

describe("ScopeManager", () => {
  beforeEach(() => mockApiFetch.mockReset());

  it("returns existing scope id when name matches", async () => {
    mockApiFetch.mockResolvedValueOnce({
      items: [{ id: "scope-1", name: "project:myapp" }]
    });
    const manager = new ScopeManager("/home/user/myapp");
    const id = await manager.getScopeId();
    expect(id).toBe("scope-1");
    expect(mockApiFetch).toHaveBeenCalledTimes(1);
  });

  it("creates scope when not found", async () => {
    mockApiFetch
      .mockResolvedValueOnce({ items: [] })                             // GET /scopes
      .mockResolvedValueOnce({ id: "scope-2", name: "project:myapp" }) // POST /scopes
      .mockResolvedValueOnce({ activeScopeId: "scope-2" });            // POST /scopes/:id/active
    const manager = new ScopeManager("/home/user/myapp");
    const id = await manager.getScopeId();
    expect(id).toBe("scope-2");
    expect(mockApiFetch).toHaveBeenCalledTimes(3);
  });

  it("caches scope id after first resolution", async () => {
    mockApiFetch.mockResolvedValueOnce({
      items: [{ id: "scope-1", name: "project:myapp" }]
    });
    const manager = new ScopeManager("/home/user/myapp");
    await manager.getScopeId();
    await manager.getScopeId();
    expect(mockApiFetch).toHaveBeenCalledTimes(1);
  });
});
