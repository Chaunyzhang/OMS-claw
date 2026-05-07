import type { DatabaseSync } from "node:sqlite";
import type { CandidateLaneResult } from "../../types.js";
import { normalizeQueryText, tokenTerms } from "./queryText.js";

export class TrigramLane {
  readonly lane = "trigram" as const;

  constructor(private readonly db: DatabaseSync) {}

  search(input: { agentId: string; query: string; limit?: number }): CandidateLaneResult {
    const started = Date.now();
    const normalized = normalizeQueryText(input.query);
    const longEnough = Array.from(normalized).length >= 3;
    try {
      const rows = longEnough ? this.trigram(input.agentId, normalized, input.limit ?? 20) : this.likeFallback(input.agentId, normalized, input.limit ?? 20);
      return {
        lane: this.lane,
        status: "ok",
        timingsMs: { total: Date.now() - started },
        candidates: rows.map((row, index) => ({
          targetKind: "raw",
          targetId: row.rawId,
          rawIdHint: row.rawId,
          rank: index + 1,
          score: row.score,
          reason: { strategy: longEnough ? "fts5_trigram" : "like_fallback", candidateOnly: true, evidenceRequired: true }
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

  private trigram(agentId: string, normalized: string, limit: number): Array<{ rawId: string; score: number }> {
    const query = tokenTerms(normalized, 3)
      .map((term) => `"${term.replace(/"/gu, "\"\"")}"`)
      .join(" OR ");
    if (!query) {
      return [];
    }
    return this.db
      .prepare(
        `SELECT rm.message_id AS rawId, bm25(raw_trigram) AS score
         FROM raw_trigram
         JOIN raw_messages rm ON rm.rowid = raw_trigram.rowid
         WHERE raw_trigram MATCH ? AND rm.agent_id = ? AND rm.retrieval_allowed = 1
         ORDER BY score ASC, rm.sequence DESC
         LIMIT ?`
      )
      .all(query, agentId, limit)
      .map((row) => {
        const value = row as { rawId: string; score: number };
        return { rawId: value.rawId, score: Number(value.score) };
      });
  }

  private likeFallback(agentId: string, normalized: string, limit: number): Array<{ rawId: string; score: number }> {
    if (!normalized) {
      return [];
    }
    return this.db
      .prepare(
        `SELECT message_id AS rawId, 1.0 AS score
         FROM raw_messages
         WHERE agent_id = ? AND retrieval_allowed = 1 AND normalized_text LIKE ?
         ORDER BY sequence DESC
         LIMIT ?`
      )
      .all(agentId, `%${normalized.replace(/[%_]/gu, "\\$&")}%`, limit)
      .map((row) => {
        const value = row as { rawId: string; score: number };
        return { rawId: value.rawId, score: Number(value.score) };
      });
  }
}
