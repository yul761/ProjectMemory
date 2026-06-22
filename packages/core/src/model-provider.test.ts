import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createModelProvider,
  createChatModelClient,
  createEmbeddingModelClient,
  LlmClient,
  EmbeddingClient
} from "./model-provider";

const baseConfig = {
  provider: "openai-compatible",
  apiKey: "k",
  baseUrl: "http://example.test",
  model: "m",
  embeddingModel: "e"
};

describe("createModelProvider", () => {
  it("returns null for null/undefined config", () => {
    expect(createModelProvider(null)).toBeNull();
    expect(createModelProvider(undefined)).toBeNull();
  });

  it("returns a factory with chat, structuredOutput and embedding", () => {
    const provider = createModelProvider(baseConfig);
    expect(provider).not.toBeNull();
    expect(provider?.provider).toBe("openai-compatible");
    expect(typeof provider?.chat.chat).toBe("function");
    expect(typeof provider?.structuredOutput.chat).toBe("function");
    expect(provider?.embedding).not.toBeNull();
  });

  it("leaves embedding null when no embeddingModel is configured", () => {
    const provider = createModelProvider({ ...baseConfig, embeddingModel: undefined });
    expect(provider?.embedding).toBeNull();
  });
});

describe("client factories", () => {
  it("createChatModelClient returns null for null config", () => {
    expect(createChatModelClient(null)).toBeNull();
  });

  it("createEmbeddingModelClient returns null when model is empty", () => {
    expect(createEmbeddingModelClient({ baseUrl: "http://example.test", model: "" })).toBeNull();
  });
});

describe("LlmClient.chat", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns the message content on a successful response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "hello" } }] })
    }));
    const client = new LlmClient({ baseUrl: "http://example.test", model: "m" });
    await expect(client.chat([{ role: "user", content: "hi" }])).resolves.toBe("hello");
  });

  it("throws after retries when the response is not ok", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "boom"
    }));
    const client = new LlmClient({ baseUrl: "http://example.test", model: "m" });
    await expect(client.chat([{ role: "user", content: "hi" }])).rejects.toThrow(/LLM error 500/);
  }, 10000);
});

describe("EmbeddingClient.embed", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns vectors on a successful response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.1, 0.2] }] })
    }));
    const client = new EmbeddingClient({ baseUrl: "http://example.test", model: "e" });
    await expect(client.embed(["hi"])).resolves.toEqual([[0.1, 0.2]]);
  });
});
