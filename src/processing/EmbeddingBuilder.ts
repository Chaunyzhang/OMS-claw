import { RawMessageStore } from "../storage/RawMessageStore.js";
import { EmbeddingStore } from "../storage/EmbeddingStore.js";
import type { EmbeddingProvider } from "./EmbeddingProvider.js";
import { hasDetectedSecrets } from "../ingest/SecretScanner.js";

export class EmbeddingBuilder {
  constructor(
    private readonly rawMessages: RawMessageStore,
    private readonly embeddings: EmbeddingStore,
    private readonly provider: EmbeddingProvider
  ) {}

  async buildForAgent(agentId: string, limit = 5000): Promise<{ indexed: number; skipped: number }> {
    const status = this.provider.status();
    if (!status.ok || !this.provider.model) {
      throw new Error(status.reason ?? "embedding_provider_unavailable");
    }
    let indexed = 0;
    let skipped = 0;
    const raw = this.rawMessages
      .allForAgent(agentId, limit)
      .filter((message) => message.retrievalAllowed && !hasDetectedSecrets(message.metadata));
    for (const message of raw) {
      if (this.embeddings.hasCurrentRaw(message, this.provider.model)) {
        skipped += 1;
        continue;
      }
      const vector = await this.provider.embed(message.originalText, "search_document");
      this.embeddings.indexRaw(message, this.provider.model, vector);
      indexed += 1;
    }
    return { indexed, skipped };
  }
}
