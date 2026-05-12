// apps/adapter-mcp/src/scope-manager.ts
import path from "path";
import { apiFetch } from "./api-client";
import { mcpEnv } from "./env";

interface ScopeItem {
  id: string;
  name: string;
}

interface ScopeListResponse {
  items: ScopeItem[];
}

interface ScopeResponse {
  id: string;
  name: string;
}

export class ScopeManager {
  private readonly scopeName: string;
  private cachedScopeId: string | null = null;

  constructor(cwd: string = process.cwd()) {
    const base = path.basename(cwd);
    this.scopeName = `project:${base}`;
  }

  async getScopeId(): Promise<string> {
    if (this.cachedScopeId) return this.cachedScopeId;

    const list = await apiFetch<ScopeListResponse>(
      "/scopes",
      mcpEnv.token,
      mcpEnv.apiBaseUrl
    ) as ScopeListResponse;

    const existing = list.items?.find((s) => s.name === this.scopeName);
    if (existing) {
      this.cachedScopeId = existing.id;
      return existing.id;
    }

    const created = await apiFetch<ScopeResponse>(
      "/scopes",
      mcpEnv.token,
      mcpEnv.apiBaseUrl,
      { method: "POST", body: JSON.stringify({ name: this.scopeName }) }
    ) as ScopeResponse;

    await apiFetch(
      `/scopes/${created.id}/active`,
      mcpEnv.token,
      mcpEnv.apiBaseUrl,
      { method: "POST" }
    );

    this.cachedScopeId = created.id;
    return created.id;
  }
}
