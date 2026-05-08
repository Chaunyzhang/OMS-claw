import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { RawMessage } from "../types.js";

export const LOCAL_EMBEDDING_MODEL = "oms-local-hash-embedding-v2";
export const LOCAL_EMBEDDING_DIM = 128;

export interface EmbeddingChunkRecord {
  chunkId: string;
  rawId: string;
  model: string;
  dim: number;
  vector: Float32Array;
  textHash: string;
}

function textHash(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function vectorHash(vector: Float32Array): string {
  return `sha256:${createHash("sha256").update(toBlob(vector)).digest("hex")}`;
}

export function localEmbedding(text: string, dim = LOCAL_EMBEDDING_DIM): Float32Array {
  const vector = new Float32Array(dim);
  const terms = text
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean);
  for (const term of terms) {
    const hash = createHash("sha256").update(term).digest();
    const index = hash.readUInt32LE(0) % dim;
    const sign = hash[4] % 2 === 0 ? 1 : -1;
    vector[index] += sign;
  }
  let norm = 0;
  for (const value of vector) {
    norm += value * value;
  }
  norm = Math.sqrt(norm) || 1;
  for (let index = 0; index < vector.length; index += 1) {
    vector[index] = vector[index] / norm;
  }
  return vector;
}

function toBlob(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength));
}

function fromBlob(blob: Uint8Array): Float32Array {
  const buffer = Buffer.from(blob);
  return new Float32Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
}

export class EmbeddingStore {
  constructor(private readonly db: DatabaseSync) {}

  indexRaw(raw: RawMessage, model = LOCAL_EMBEDDING_MODEL, vector = localEmbedding(raw.originalText)): void {
    const chunkId = this.chunkId(raw, model);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO embedding_chunks (
          chunk_id, agent_id, raw_id, chunk_text_hash, chunk_start_char, chunk_end_char,
          model, dim, created_at, status, metadata_json
        ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, 'active', ?)
        ON CONFLICT(chunk_id) DO UPDATE SET
          chunk_text_hash=excluded.chunk_text_hash,
          chunk_end_char=excluded.chunk_end_char,
          status='active',
          metadata_json=excluded.metadata_json`
      )
      .run(
        chunkId,
        raw.agentId,
        raw.messageId,
        textHash(raw.originalText),
        raw.originalText.length,
        model,
        vector.length,
        now,
        JSON.stringify({ candidateOnly: true, evidenceRequired: true })
      );
    this.db
      .prepare(
        `INSERT INTO embedding_vectors (chunk_id, agent_id, model, dim, vector_f32, vector_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(chunk_id) DO UPDATE SET
           vector_f32=excluded.vector_f32,
           vector_hash=excluded.vector_hash,
           created_at=excluded.created_at`
      )
      .run(chunkId, raw.agentId, model, vector.length, toBlob(vector), vectorHash(vector), now);
  }

  hasCurrentRaw(raw: RawMessage, model = LOCAL_EMBEDDING_MODEL): boolean {
    const row = this.db
      .prepare("SELECT chunk_text_hash AS textHash FROM embedding_chunks WHERE chunk_id = ? AND status = 'active'")
      .get(this.chunkId(raw, model)) as { textHash: string } | undefined;
    return row?.textHash === textHash(raw.originalText);
  }

  records(agentId: string, model = LOCAL_EMBEDDING_MODEL, limit = 5000): EmbeddingChunkRecord[] {
    return this.db
      .prepare(
        `SELECT ec.chunk_id AS chunkId, ec.raw_id AS rawId, ec.model, ec.dim,
                ec.chunk_text_hash AS textHash, ev.vector_f32 AS vector
         FROM embedding_chunks ec
         JOIN embedding_vectors ev ON ev.chunk_id = ec.chunk_id
         JOIN raw_messages rm ON rm.message_id = ec.raw_id
         WHERE ec.agent_id = ? AND ec.model = ? AND ec.status = 'active' AND rm.retrieval_allowed = 1
         ORDER BY rm.sequence DESC
         LIMIT ?`
      )
      .all(agentId, model, limit)
      .map((row) => {
        const value = row as { chunkId: string; rawId: string; model: string; dim: number; textHash: string; vector: Uint8Array };
        return {
          chunkId: value.chunkId,
          rawId: value.rawId,
          model: value.model,
          dim: Number(value.dim),
          textHash: value.textHash,
          vector: fromBlob(value.vector)
        };
      });
  }

  count(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS count FROM embedding_chunks").get() as { count: number }).count);
  }

  countForAgent(agentId: string): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS count FROM embedding_chunks WHERE agent_id = ?").get(agentId) as { count: number }).count);
  }

  private chunkId(raw: RawMessage, model: string): string {
    return `emb_${raw.messageId}_${model.replace(/[^A-Za-z0-9_]/gu, "_")}`;
  }
}
