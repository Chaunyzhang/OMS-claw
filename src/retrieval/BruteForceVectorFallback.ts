import type { EmbeddingChunkRecord } from "../storage/EmbeddingStore.js";

function cosine(a: Float32Array, b: Float32Array): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  for (let index = 0; index < length; index += 1) {
    dot += a[index] * b[index];
  }
  return dot;
}

export class BruteForceVectorFallback {
  search(input: { queryVector: Float32Array; records: EmbeddingChunkRecord[]; limit?: number }): Array<EmbeddingChunkRecord & { score: number }> {
    return input.records
      .map((record) => ({ ...record, score: cosine(input.queryVector, record.vector) }))
      .filter((record) => record.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, input.limit ?? 20);
  }
}
