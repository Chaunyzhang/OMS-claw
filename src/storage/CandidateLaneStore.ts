import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { CandidateLaneResult, FusionCandidate, OmsConfig, OmsMode } from "../types.js";

function normalizeText(text: string): string {
  return text.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
}

export class CandidateLaneStore {
  constructor(private readonly db: DatabaseSync) {}

  createQuery(input: {
    agentId: string;
    sessionId?: string;
    query: string;
    mode: OmsMode;
    config?: OmsConfig;
    metadata?: Record<string, unknown>;
  }): string {
    const queryId = `q_${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO retrieval_queries
          (query_id, agent_id, session_id, user_query, normalized_query, mode, created_at, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        queryId,
        input.agentId,
        input.sessionId ?? null,
        input.query,
        normalizeText(input.query),
        input.mode,
        new Date().toISOString(),
        JSON.stringify({ ...(input.metadata ?? {}), config: input.config })
      );
    return queryId;
  }

  recordLaneResults(runId: string, queryId: string, agentId: string, results: CandidateLaneResult[]): void {
    const insert = this.db.prepare(
      `INSERT INTO retrieval_candidates (
        candidate_id, run_id, candidate_kind, candidate_id_ref, score, status, metadata_json,
        query_id, agent_id, lane, target_kind, target_id, raw_id_hint, summary_id_hint,
        graph_path_json, rank, normalized_score, reason_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const result of results) {
      for (const candidate of result.candidates) {
        insert.run(
          `cand_${randomUUID()}`,
          runId,
          candidate.targetKind,
          candidate.targetId,
          candidate.score,
          result.status === "ok" ? "candidate" : result.status,
          JSON.stringify({ lane: result.lane, reason: candidate.reason }),
          queryId,
          agentId,
          result.lane,
          candidate.targetKind,
          candidate.targetId,
          candidate.rawIdHint ?? null,
          candidate.summaryIdHint ?? null,
          candidate.graphPath === undefined ? null : JSON.stringify(candidate.graphPath),
          candidate.rank,
          null,
          JSON.stringify(candidate.reason),
          new Date().toISOString()
        );
      }
    }
  }

  createFusionRun(queryId: string, agentId: string, algorithm: string, metadata: Record<string, unknown> = {}): string {
    const fusionRunId = `fr_${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO fusion_runs (fusion_run_id, query_id, agent_id, algorithm, created_at, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(fusionRunId, queryId, agentId, algorithm, new Date().toISOString(), JSON.stringify(metadata));
    return fusionRunId;
  }

  recordFused(fusionRunId: string, candidates: FusionCandidate[]): void {
    const insert = this.db.prepare(
      `INSERT INTO fused_candidates (fusion_run_id, raw_id, fused_rank, fused_score, lane_votes_json, reason_json)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const candidate of candidates) {
      insert.run(
        fusionRunId,
        candidate.rawId,
        candidate.fusedRank,
        candidate.fusedScore,
        JSON.stringify(candidate.laneVotes),
        JSON.stringify(candidate.reason ?? {})
      );
    }
  }
}
