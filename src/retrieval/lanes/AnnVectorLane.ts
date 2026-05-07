import type { CandidateLaneResult } from "../../types.js";
import type { OmsConfig } from "../../types.js";
import { EmbeddingBuilder } from "../../processing/EmbeddingBuilder.js";
import type { EmbeddingProvider } from "../../processing/EmbeddingProvider.js";
import { EmbeddingStore } from "../../storage/EmbeddingStore.js";
import { BruteForceVectorFallback } from "../BruteForceVectorFallback.js";
import { VecAdapter } from "../VecAdapter.js";

export class AnnVectorLane {
  readonly lane = "ann_vector" as const;
  private readonly fallback = new BruteForceVectorFallback();
  private readonly vec = new VecAdapter();

  constructor(
    private readonly config: OmsConfig,
    private readonly builder: EmbeddingBuilder,
    private readonly embeddings: EmbeddingStore,
    private readonly provider: EmbeddingProvider
  ) {}

  async search(input: { agentId: string; query: string; limit?: number }): Promise<CandidateLaneResult> {
    const started = Date.now();
    const vectorEnabled = this.config.annEnabled || this.config.ragEnabled;
    const providerStatus = this.provider.status();
    if (!vectorEnabled || !providerStatus.ok || !this.provider.model) {
      return {
        lane: this.lane,
        status: "blocked",
        candidates: [],
        timingsMs: { total: Date.now() - started },
        error: !vectorEnabled ? "lane_disabled" : providerStatus.reason ?? "embedding_model_not_configured"
      };
    }
    try {
      await this.builder.buildForAgent(input.agentId);
      const adapter = this.vec.probe();
      const records = this.embeddings.records(input.agentId, this.provider.model);
      const queryVector = await this.provider.embed(input.query, "search_query");
      const results = this.fallback.search({ queryVector, records, limit: input.limit ?? 20 });
      return {
        lane: this.lane,
        status: "ok",
        timingsMs: { total: Date.now() - started },
        candidates: results.map((record, index) => ({
          targetKind: "embedding_chunk",
          targetId: record.chunkId,
          rawIdHint: record.rawId,
          rank: index + 1,
          score: record.score,
          reason: {
            candidateOnly: true,
            evidenceRequired: true,
            vectorProvider: adapter.provider,
            fallback: !adapter.ok
          }
        }))
      };
    } catch (error) {
      return {
        lane: this.lane,
        status: "degraded",
        candidates: [],
        timingsMs: { total: Date.now() - started },
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
}
