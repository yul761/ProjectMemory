// apps/adapter-mcp/src/api-client.ts
function shouldRetry(status: number) {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJsonSafe<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export async function apiFetch<T>(
  path: string,
  token: string,
  baseUrl: string,
  options?: RequestInit
): Promise<T | { error: string; detail?: string }> {
  const url = `${baseUrl}${path}`;
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          "x-user-id": token,
          ...(options?.headers ?? {})
        }
      });
      const data = await readJsonSafe<T>(response);
      if (!response.ok) {
        if (shouldRetry(response.status) && attempt < 2) {
          await sleep(Math.min(200 * Math.pow(2, attempt), 1000));
          continue;
        }
        const errBody = data as Record<string, unknown> | null;
        if (errBody && typeof errBody === "object" && "error" in errBody) {
          return errBody as { error: string };
        }
        return { error: `HTTP ${response.status}` };
      }
      return data as T;
    } catch (err) {
      lastError = err;
      if (attempt < 2) {
        await sleep(Math.min(200 * Math.pow(2, attempt), 1000));
        continue;
      }
    }
  }
  return { error: "request_failed", detail: String(lastError ?? "") };
}
