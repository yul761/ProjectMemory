export interface LlmClientOptions {
  apiKey?: string;
  baseUrl: string;
  model: string;
  timeoutMs?: number;
}

export interface LlmChatOptions {
  maxOutputTokens?: number;
  reasoningEffort?: "low" | "medium" | "high";
}

export interface ModelProviderConfig {
  provider?: string;
  apiKey?: string;
  baseUrl: string;
  model: string;
  chatApiKey?: string;
  chatBaseUrl?: string;
  chatModel?: string;
  structuredOutputApiKey?: string;
  structuredOutputBaseUrl?: string;
  structuredOutputModel?: string;
  embeddingApiKey?: string;
  embeddingBaseUrl?: string;
  embeddingModel?: string;
  timeoutMs?: number;
}

export interface ChatModel {
  chat: LlmClient["chat"];
}

export interface StructuredOutputModel {
  chat: LlmClient["chat"];
}

export interface EmbeddingModel {
  embed: (input: string[]) => Promise<number[][]>;
}

export interface ModelProviderFactory {
  provider: string;
  chat: ChatModel;
  structuredOutput: StructuredOutputModel;
  embedding: EmbeddingModel | null;
}

export class LlmClient {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private timeoutMs: number;

  constructor(options: LlmClientOptions) {
    this.apiKey = options.apiKey ?? "";
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? 20000;
  }

  private extractMessageContent(data: any) {
    const raw = data?.choices?.[0]?.message?.content;
    if (typeof raw === "string" && raw.trim()) {
      return raw;
    }
    if (Array.isArray(raw)) {
      const text = raw
        .map((part) => {
          if (typeof part === "string") return part;
          if (typeof part?.text === "string") return part.text;
          if (typeof part?.content === "string") return part.content;
          return "";
        })
        .join("")
        .trim();
      if (text) return text;
    }
    if (typeof data?.output_text === "string" && data.output_text.trim()) {
      return data.output_text;
    }
    return null;
  }

  async chat(messages: { role: "system" | "user"; content: string }[], options?: LlmChatOptions) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const headers: Record<string, string> = {
          "Content-Type": "application/json"
        };
        if (this.apiKey) {
          headers.Authorization = `Bearer ${this.apiKey}`;
        }
        const response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: this.model,
            messages,
            ...(typeof options?.maxOutputTokens === "number" && options.maxOutputTokens > 0
              ? { max_completion_tokens: options.maxOutputTokens }
              : {}),
            ...(typeof options?.reasoningEffort === "string"
              ? { reasoning_effort: options.reasoningEffort }
              : {})
          }),
          // Cast: duplicate @types/node in the tree (vitest pulls v25, workspace pins v22)
          // produces two incompatible global AbortSignal defs, triggering a spurious TS2769.
          signal: controller.signal as any
        });

        if (!response.ok) {
          const text = await response.text();
          throw new Error(`LLM error ${response.status}: ${text}`);
        }

        const data: any = await response.json();
        const content = this.extractMessageContent(data);
        if (!content) {
          throw new Error("LLM response missing content");
        }
        return String(content);
      } catch (err) {
        lastError = err;
        await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError ?? new Error("LLM call failed");
  }
}

export class EmbeddingClient {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private timeoutMs: number;

  constructor(options: LlmClientOptions) {
    this.apiKey = options.apiKey ?? "";
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? 20000;
  }

  async embed(input: string[]) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const headers: Record<string, string> = {
          "Content-Type": "application/json"
        };
        if (this.apiKey) {
          headers.Authorization = `Bearer ${this.apiKey}`;
        }
        const response = await fetch(`${this.baseUrl}/embeddings`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: this.model,
            input
          }),
          // Cast: duplicate @types/node in the tree (vitest pulls v25, workspace pins v22)
          // produces two incompatible global AbortSignal defs, triggering a spurious TS2769.
          signal: controller.signal as any
        });

        if (!response.ok) {
          const text = await response.text();
          throw new Error(`Embedding error ${response.status}: ${text}`);
        }

        const data: any = await response.json();
        const vectors = Array.isArray(data?.data)
          ? data.data.map((item: any) => item?.embedding).filter((value: unknown) => Array.isArray(value))
          : [];
        if (!vectors.length) {
          throw new Error("Embedding response missing vectors");
        }
        return vectors as number[][];
      } catch (err) {
        lastError = err;
        await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError ?? new Error("Embedding call failed");
  }
}

export function createChatModelClient(config: ModelProviderConfig | null | undefined) {
  if (!config) return null;
  return new LlmClient({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
    timeoutMs: config.timeoutMs
  });
}

export function createEmbeddingModelClient(config: ModelProviderConfig | null | undefined) {
  if (!config || !config.model) return null;
  return new EmbeddingClient({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
    timeoutMs: config.timeoutMs
  });
}

export function createModelProvider(config: ModelProviderConfig | null | undefined): ModelProviderFactory | null {
  if (!config) return null;
  const chat = createChatModelClient({
    ...config,
    apiKey: config.chatApiKey ?? config.apiKey,
    baseUrl: config.chatBaseUrl || config.baseUrl,
    model: config.chatModel || config.model
  });
  const structuredOutput = createChatModelClient({
    ...config,
    apiKey: config.structuredOutputApiKey ?? config.apiKey,
    baseUrl: config.structuredOutputBaseUrl || config.baseUrl,
    model: config.structuredOutputModel || config.model
  });
  const embedding = config.embeddingModel
    ? createEmbeddingModelClient({
        ...config,
        apiKey: config.embeddingApiKey ?? config.apiKey,
        baseUrl: config.embeddingBaseUrl || config.baseUrl,
        model: config.embeddingModel
      })
    : null;
  if (!chat || !structuredOutput) return null;
  return {
    provider: config.provider || "openai-compatible",
    chat,
    structuredOutput,
    embedding
  };
}
