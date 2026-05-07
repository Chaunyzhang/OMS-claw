import type { DatabaseSync } from "node:sqlite";
import type { CandidateLaneResult } from "../../types.js";
import { ftsMatchQuery } from "./queryText.js";

export class FTS5Bm25Lane {
  readonly lane = "fts_bm25" as const;

  constructor(private readonly db: DatabaseSync) {}

  search(input: { agentId: string; query: string; limit?: number }): CandidateLaneResult {
    const started = Date.now();
    const match = ftsMatchQuery(input.query);
    if (!match) {
      return { lane: this.lane, status: "blocked", candidates: [], timingsMs: { total: Date.now() - started }, error: "empty_query" };
    }
    try {
      const rows = this.db
        .prepare(
          `SELECT rm.message_id AS rawId, bm25(raw_messages_fts) AS score, rm.sequence
           FROM raw_messages_fts
           JOIN raw_messages rm ON rm.rowid = raw_messages_fts.rowid
           WHERE raw_messages_fts MATCH ? AND rm.agent_id = ? AND rm.retrieval_allowed = 1
           ORDER BY score ASC, rm.sequence DESC
           LIMIT ?`
        )
        .all(match, input.agentId, input.limit ?? 20) as Array<{ rawId: string; score: number; sequence: number }>;
      return {
        lane: this.lane,
        status: "ok",
        timingsMs: { total: Date.now() - started },
        candidates: rows.map((row, index) => ({
          targetKind: "raw",
          targetId: row.rawId,
          rawIdHint: row.rawId,
          rank: index + 1,
          score: Number(row.score),
          reason: { bm25: row.score, sequence: row.sequence, candidateOnly: true, evidenceRequired: true }
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
