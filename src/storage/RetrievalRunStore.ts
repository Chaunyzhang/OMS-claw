import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { BuildInfo, EvidencePacket, OmsConfig } from "../types.js";

export class RetrievalRunStore {
  constructor(private readonly db: DatabaseSync) {}

  createRun(input: {
    agentId: string;
    sessionId?: string;
    query: string;
    mode: string;
    intent: string;
    status: string;
    config: OmsConfig;
    build: BuildInfo;
    metadata?: Record<string, unknown>;
  }): string {
    const runId = `run_${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO retrieval_runs (
          run_id, agent_id, session_id, created_at, query, mode, intent, status,
          timings_json, config_snapshot_json, build_info_json, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?)`
      )
      .run(
        runId,
        input.agentId,
        input.sessionId ?? null,
        new Date().toISOString(),
        input.query,
        input.mode,
        input.intent,
        input.status,
        JSON.stringify(input.config),
        JSON.stringify(input.build),
        JSON.stringify(input.metadata ?? {})
      );
    return runId;
  }

  recordCandidate(input: {
    runId: string;
    candidateKind: string;
    candidateIdRef: string;
    score?: number;
    status: string;
    metadata?: Record<string, unknown>;
  }): void {
    this.db
      .prepare(
        `INSERT INTO retrieval_candidates
          (candidate_id, run_id, candidate_kind, candidate_id_ref, score, status, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        `cand_${randomUUID()}`,
        input.runId,
        input.candidateKind,
        input.candidateIdRef,
        input.score ?? 0,
        input.status,
        JSON.stringify(input.metadata ?? {})
      );
  }

  recordPacket(runId: string, agentId: string, packet: EvidencePacket): void {
    this.db
      .prepare(
        `INSERT INTO evidence_packets (
          packet_id, run_id, agent_id, created_at, status,
          selected_authoritative_raw_count, selected_raw_count, summary_derived_raw_count,
          raw_message_ids_json, source_summary_ids_json, source_edge_ids_json,
          raw_excerpt_hash, raw_excerpt_preview_json, authority_report_json, delivery_report_json,
          query_id, fusion_run_id, session_id, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        packet.packetId,
        runId,
        agentId,
        new Date().toISOString(),
        packet.status,
        packet.selectedAuthoritativeRawCount,
        packet.selectedRawCount,
        packet.summaryDerivedRawCount,
        JSON.stringify(packet.rawMessageIds),
        JSON.stringify(packet.sourceSummaryIds),
        JSON.stringify(packet.sourceEdgeIds),
        packet.rawExcerptHash,
        JSON.stringify(packet.rawExcerpts.slice(0, 10)),
        JSON.stringify(packet.authorityReport),
        JSON.stringify(packet.deliveryReceipt),
        packet.queryId ?? null,
        packet.fusionRunId ?? null,
        packet.rawExcerpts[0]?.sessionId ?? null,
        JSON.stringify({ sourceRoutes: packet.sourceRoutes ?? [] })
      );
    const insertItem = this.db.prepare(
      `INSERT OR REPLACE INTO evidence_packet_items (
        packet_id, item_index, raw_id, agent_id, session_id, role, sequence,
        excerpt_text, excerpt_hash, source_purpose, source_authority, evidence_allowed,
        window_start_sequence, window_end_sequence, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    packet.rawExcerpts.forEach((excerpt, index) => {
      insertItem.run(
        packet.packetId,
        index,
        excerpt.messageId,
        agentId,
        excerpt.sessionId,
        excerpt.role,
        excerpt.sequence,
        excerpt.originalText,
        `sha256:${createHash("sha256").update(excerpt.originalText, "utf8").digest("hex")}`,
        excerpt.sourcePurpose,
        excerpt.sourceAuthority,
        excerpt.evidenceAllowed === false ? 0 : 1,
        excerpt.sequence,
        excerpt.sequence,
        JSON.stringify({ turnIndex: excerpt.turnIndex, sourceRoutes: packet.sourceRoutes ?? [] })
      );
    });
  }

  countRuns(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS count FROM retrieval_runs").get() as { count: number }).count);
  }

  countPackets(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS count FROM evidence_packets").get() as { count: number }).count);
  }

  traceForPacket(packetId: string): Record<string, unknown> | undefined {
    return this.db
      .prepare(
        `SELECT ep.*, rr.query, rr.mode, rr.intent, rr.build_info_json
         FROM evidence_packets ep
         JOIN retrieval_runs rr ON rr.run_id = ep.run_id
         WHERE ep.packet_id = ?`
      )
      .get(packetId) as Record<string, unknown> | undefined;
  }
}
