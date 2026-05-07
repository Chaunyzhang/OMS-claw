import type { DatabaseSync } from "node:sqlite";
import type { FusionCandidate } from "../types.js";

const LANE_WEIGHTS: Record<string, number> = {
  fts_bm25: 1.3,
  trigram: 0.9,
  summary_dag: 1.1,
  ann_vector: 1,
  graph_cte: 0.85,
  timeline: 0.5
};

export class SQLRRFusion {
  constructor(private readonly db: DatabaseSync) {}

  fuse(queryId: string, topK = 20): FusionCandidate[] {
    const rows = this.db
      .prepare(
        `WITH lane_ranks AS (
          SELECT
            query_id,
            COALESCE(raw_id_hint, target_id) AS raw_id,
            lane,
            rank,
            CASE lane
              WHEN 'fts_bm25' THEN 1.30
              WHEN 'trigram' THEN 0.90
              WHEN 'summary_dag' THEN 1.10
              WHEN 'ann_vector' THEN 1.00
              WHEN 'graph_cte' THEN 0.85
              ELSE 0.50
            END AS lane_weight
          FROM retrieval_candidates
          WHERE query_id = ?
            AND COALESCE(raw_id_hint, target_id) IS NOT NULL
            AND lane IS NOT NULL
        ), fused AS (
          SELECT
            raw_id,
            SUM(lane_weight * (1.0 / (60 + rank))) AS fused_score,
            json_group_array(json_object('lane', lane, 'rank', rank, 'weight', lane_weight)) AS votes
          FROM lane_ranks
          GROUP BY raw_id
        )
        SELECT raw_id AS rawId, fused_score AS fusedScore, votes
        FROM fused
        ORDER BY fused_score DESC
        LIMIT ?`
      )
      .all(queryId, topK) as Array<{ rawId: string; fusedScore: number; votes: string }>;

    return rows.map((row, index) => ({
      rawId: row.rawId,
      fusedRank: index + 1,
      fusedScore: Number(row.fusedScore),
      laneVotes: JSON.parse(row.votes) as FusionCandidate["laneVotes"]
    }));
  }

  fallbackFromLaneResults(queryId: string, topK = 20): FusionCandidate[] {
    const rows = this.db
      .prepare(
        `SELECT COALESCE(raw_id_hint, target_id) AS rawId, lane, rank, score
         FROM retrieval_candidates
         WHERE query_id = ? AND COALESCE(raw_id_hint, target_id) IS NOT NULL
         ORDER BY rank ASC, score DESC
         LIMIT ?`
      )
      .all(queryId, topK) as Array<{ rawId: string; lane: string; rank: number; score: number }>;
    return rows.map((row, index) => ({
      rawId: row.rawId,
      fusedRank: index + 1,
      fusedScore: Number(row.score),
      laneVotes: [{ lane: row.lane, rank: Number(row.rank), weight: LANE_WEIGHTS[row.lane] ?? 0.5 }],
      reason: { fusionFallback: true }
    }));
  }
}
