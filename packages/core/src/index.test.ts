import { afterEach, describe, expect, it, vi } from "vitest";
import { createChatModelClient, createEmbeddingModelClient, createModelProvider, EmbeddingClient, LlmClient, RetrieveService } from "./index";

describe("createChatModelClient", () => {
  it("returns null when config is missing", () => {
    expect(createChatModelClient(null)).toBeNull();
  });

  it("creates a client from provider config", () => {
    const client = createChatModelClient({
      provider: "openai-compatible",
      baseUrl: "http://localhost:11434/v1",
      model: "local-model",
      apiKey: ""
    });

    expect(client).toBeInstanceOf(LlmClient);
  });
});

describe("createModelProvider", () => {
  it("returns null when config is missing", () => {
    expect(createModelProvider(null)).toBeNull();
  });

  it("creates a provider bundle with chat and structured output clients", () => {
    const provider = createModelProvider({
      provider: "openai-compatible",
      baseUrl: "http://localhost:11434/v1",
      model: "local-model",
      apiKey: ""
    });

    expect(provider?.provider).toBe("openai-compatible");
    expect(provider?.chat).toBeInstanceOf(LlmClient);
    expect(provider?.structuredOutput).toBeInstanceOf(LlmClient);
    expect(provider?.embedding).toBeNull();
  });

  it("supports separate chat and structured output model names", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "ok" } }] })
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = createModelProvider({
      provider: "openai-compatible",
      baseUrl: "http://localhost:11434/v1",
      model: "fallback-model",
      chatModel: "chat-model",
      structuredOutputModel: "structured-model",
      apiKey: ""
    });

    await provider?.chat.chat([{ role: "user", content: "chat" }]);
    await provider?.structuredOutput.chat([{ role: "user", content: "structured" }]);

    expect(fetchMock.mock.calls[0]?.[1]?.body).toContain("\"model\":\"chat-model\"");
    expect(fetchMock.mock.calls[1]?.[1]?.body).toContain("\"model\":\"structured-model\"");
  });

  it("supports separate chat and structured output endpoints and auth", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "ok" } }] })
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = createModelProvider({
      provider: "openai-compatible",
      baseUrl: "http://fallback.example/v1",
      model: "fallback-model",
      apiKey: "fallback-secret",
      chatBaseUrl: "http://chat.local/v1",
      chatApiKey: "",
      structuredOutputBaseUrl: "https://api.openai.com/v1",
      structuredOutputApiKey: "structured-secret"
    });

    await provider?.chat.chat([{ role: "user", content: "chat" }]);
    await provider?.structuredOutput.chat([{ role: "user", content: "structured" }]);

    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://chat.local/v1/chat/completions");
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({ "Content-Type": "application/json" });
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://api.openai.com/v1/chat/completions");
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer structured-secret"
    });
  });

  it("creates an embedding client when configured", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.1, 0.2] }] })
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = createModelProvider({
      provider: "openai-compatible",
      baseUrl: "http://localhost:11434/v1",
      model: "fallback-model",
      apiKey: "",
      embeddingBaseUrl: "http://embed.local/v1",
      embeddingModel: "embed-model"
    });

    expect(provider?.embedding).toBeInstanceOf(EmbeddingClient);
    await provider?.embedding?.embed(["hello"]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://embed.local/v1/embeddings");
    expect(fetchMock.mock.calls[0]?.[1]?.body).toContain("\"model\":\"embed-model\"");
  });
});

describe("LlmClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("omits authorization header when api key is empty", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "ok" } }] })
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new LlmClient({
      baseUrl: "http://localhost:11434/v1",
      model: "local-model",
      apiKey: ""
    });

    await client.chat([{ role: "user", content: "hello" }]);

    const request = fetchMock.mock.calls[0]?.[1];
    expect(request?.headers).toEqual({ "Content-Type": "application/json" });
  });

  it("includes authorization header when api key is provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "ok" } }] })
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new LlmClient({
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      apiKey: "secret"
    });

    await client.chat([{ role: "user", content: "hello" }]);

    const request = fetchMock.mock.calls[0]?.[1];
    expect(request?.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer secret"
    });
  });

  it("supports max completion tokens and content-array responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: [
                { type: "output_text", text: "fast" },
                { type: "output_text", text: " reply" }
              ]
            }
          }
        ]
      })
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new LlmClient({
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-5-nano",
      apiKey: "secret"
    });

    const content = await client.chat(
      [{ role: "user", content: "hello" }],
      { maxOutputTokens: 120, reasoningEffort: "low" }
    );

    expect(content).toBe("fast reply");
    expect(fetchMock.mock.calls[0]?.[1]?.body).toContain("\"max_completion_tokens\":120");
    expect(fetchMock.mock.calls[0]?.[1]?.body).toContain("\"reasoning_effort\":\"low\"");
  });
});

describe("createEmbeddingModelClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns null when config is missing", () => {
    expect(createEmbeddingModelClient(null)).toBeNull();
  });

  it("creates an embedding client from provider config", () => {
    const client = createEmbeddingModelClient({
      provider: "openai-compatible",
      baseUrl: "http://localhost:11434/v1",
      model: "embed-model",
      apiKey: ""
    });

    expect(client).toBeInstanceOf(EmbeddingClient);
  });
});

describe("RetrieveService", () => {
  it("can rerank candidates with embeddings when enabled", async () => {
    const service = new RetrieveService(
      {
        findLatest: vi.fn(async () => null)
      } as any,
      {
        listRecent: vi.fn(async () => ({
          items: [
            { id: "evt-1", content: "noise only", createdAt: new Date("2026-03-18T00:00:00.000Z") },
            { id: "evt-2", content: "critical replay stability decision", createdAt: new Date("2026-03-17T00:00:00.000Z") }
          ]
        }))
      } as any,
      {
        useEmbeddingRerank: true,
        embeddingCandidateLimit: 8,
        embeddingModel: {
          // Input-aware mock: rerankWithEmbeddings embeds [query, ...candidateContents]
          // in heuristic-ranked order (not listRecent order), so vectors must be derived
          // from the text. The relevant content (evt-2) aligns with the query vector [1,0];
          // noise (evt-1) is orthogonal [0,1] — so embedding rerank promotes evt-2 regardless
          // of candidate ordering.
          embed: vi.fn(async (texts: string[]) =>
            texts.map((t) => (/replay|stability/i.test(t) ? [1, 0] : [0, 1]))
          )
        }
      }
    );

    const result = await service.retrieve("scope-1", 2, "replay stability");
    expect(result.events[0]?.id).toBe("evt-2");
    expect(result.retrieval.mode).toBe("hybrid");
    expect(result.retrieval.reranked).toBe(true);
    expect(result.retrieval.matches[0]?.rankingReason).toContain("embedding_rerank");
  });
});
