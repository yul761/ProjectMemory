// apps/adapter-mcp/src/scope-manager.ts
import { existsSync, readFileSync } from "fs";
import path from "path";
import { apiFetch } from "./api-client";
import { mcpEnv } from "./env";

function readProjectScopeName(cwd: string): string | null {
  const filePath = path.join(cwd, ".statecore");
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf8").trim();
    const parsed = JSON.parse(raw) as { scope?: string };
    return parsed.scope ?? null;
  } catch {
    return null;
  }
}


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
    this.scopeName = mcpEnv.scopeName ?? readProjectScopeName(cwd) ?? `project:${path.basename(cwd)}`;
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
