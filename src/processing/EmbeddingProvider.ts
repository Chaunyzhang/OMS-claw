import type { OmsConfig } from "../types.js";
import { localEmbedding, LOCAL_EMBEDDING_MODEL } from "../storage/EmbeddingStore.js";

export interface EmbeddingProviderStatus {
  ok: boolean;
  provider: OmsConfig["embeddingProvider"];
  model?: string;
  reason?: string;
  optional: true;
}

export interface EmbeddingProvider {
  readonly provider: OmsConfig["embeddingProvider"];
  readonly model?: string;
  status(): EmbeddingProviderStatus;
  embed(text: string, inputType: "search_document" | "search_query"): Promise<Float32Array>;
}

function asNumberArray(value: unknown): number[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "number" && Number.isFinite(item))) {
    throw new Error("embedding_response_invalid_vector");
  }
  return value;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/u, "")}/${path.replace(/^\/+/u, "")}`;
}

class DisabledEmbeddingProvider implements EmbeddingProvider {
  readonly provider = "disabled" as const;
  readonly model = undefined;

  status(): EmbeddingProviderStatus {
    return { ok: false, provider: this.provider, optional: true, reason: "embedding_provider_disabled" };
  }

  async embed(): Promise<Float32Array> {
    throw new Error("embedding_provider_disabled");
  }
}

class LocalHashEmbeddingProvider implements EmbeddingProvider {
  readonly provider = "local_hash" as const;
  readonly model: string;

  constructor(model?: string) {
    this.model = model ?? LOCAL_EMBEDDING_MODEL;
  }

  status(): EmbeddingProviderStatus {
    return { ok: true, provider: this.provider, model: this.model, optional: true };
  }

  async embed(text: string): Promise<Float32Array> {
    return localEmbedding(text);
  }
}

class OpenRouterEmbeddingProvider implements EmbeddingProvider {
  readonly provider = "openrouter" as const;
  readonly model?: string;

  constructor(private readonly config: OmsConfig) {
    this.model = config.embeddingModel;
  }

  status(): EmbeddingProviderStatus {
    if (!this.model) {
      return { ok: false, provider: this.provider, optional: true, reason: "embedding_model_not_configured" };
    }
    if (!this.apiKey()) {
      return { ok: false, provider: this.provider, model: this.model, optional: true, reason: "embedding_api_key_missing" };
    }
    return { ok: true, provider: this.provider, model: this.model, optional: true };
  }

  async embed(text: string, inputType: "search_document" | "search_query"): Promise<Float32Array> {
    if (!this.model) {
      throw new Error("embedding_model_not_configured");
    }
    const key = this.apiKey();
    if (!key) {
      throw new Error("embedding_api_key_missing");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.embeddingTimeoutMs ?? 30000);
    try {
      const body: Record<string, unknown> = {
        input: text,
        model: this.model,
        encoding_format: "float",
        input_type: inputType
      };
      if (this.config.embeddingDimensions) {
        body.dimensions = this.config.embeddingDimensions;
      }
      const response = await fetch(joinUrl(this.config.embeddingBaseUrl ?? "https://openrouter.ai/api/v1", "embeddings"), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "X-Title": "OMS OpenClaw Memory"
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new Error(`embedding_provider_http_${response.status}${errorText ? `:${errorText.slice(0, 180)}` : ""}`);
      }
      const payload = (await response.json()) as { data?: Array<{ embedding?: unknown }> };
      const embedding = asNumberArray(payload.data?.[0]?.embedding);
      return Float32Array.from(embedding);
    } finally {
      clearTimeout(timeout);
    }
  }

  private apiKey(): string | undefined {
    const envName = this.config.embeddingApiKeyEnv ?? "OPENROUTER_API_KEY";
    return process.env[envName];
  }
}

export function createEmbeddingProvider(config: OmsConfig): EmbeddingProvider {
  if (config.embeddingProvider === "local_hash") {
    return new LocalHashEmbeddingProvider(config.embeddingModel);
  }
  if (config.embeddingProvider === "openrouter") {
    return new OpenRouterEmbeddingProvider(config);
  }
  return new DisabledEmbeddingProvider();
}
