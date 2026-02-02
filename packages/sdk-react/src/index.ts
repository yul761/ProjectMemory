import { useCallback, useEffect, useState } from "react";
import { ProjectMemoryClient } from "@projectmemory/client";

export function useScopes(client: ProjectMemoryClient) {
  const [scopes, setScopes] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    const data = await client.listScopes();
    setScopes(data.items);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { scopes, loading, refresh };
}

export function useActiveScope(client: ProjectMemoryClient) {
  const [activeScopeId, setActiveScopeId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const data = await client.getState();
    setActiveScopeId(data.activeScopeId);
  }, [client]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { activeScopeId, refresh };
}

export function useIngestEvent(client: ProjectMemoryClient) {
  const ingest = useCallback(
    async (input: { scopeId: string; type: "stream" | "document"; content: string; key?: string }) => {
      return client.ingestEvent({ ...input, source: "sdk" });
    },
    [client]
  );

  return { ingest };
}

export function useAsk(client: ProjectMemoryClient) {
  const [answer, setAnswer] = useState<string | null>(null);

  const ask = useCallback(
    async (scopeId: string, question: string) => {
      const result = await client.answer({ scopeId, question });
      setAnswer(result.answer);
      return result.answer;
    },
    [client]
  );

  return { answer, ask };
}
