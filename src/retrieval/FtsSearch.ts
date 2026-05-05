import type { DatabaseSync } from "node:sqlite";
import type { EvidencePolicyRequest, RawMessage } from "../types.js";
import { EvidencePolicy } from "./EvidencePolicy.js";

function mapRaw(row: Record<string, unknown>): RawMessage {
  return {
    messageId: String(row.message_id),
    agentId: String(row.agent_id),
    sessionId: String(row.session_id),
    turnId: row.turn_id === null ? undefined : String(row.turn_id),
    role: row.role as RawMessage["role"],
    eventType: String(row.event_type),
    createdAt: String(row.created_at),
    sequence: Number(row.sequence),
    originalText: String(row.original_text),
    normalizedText: String(row.normalized_text),
    tokenCount: Number(row.token_count),
    originalHash: String(row.original_hash),
    visibleToUser: Number(row.visible_to_user) === 1,
    interrupted: Number(row.interrupted) === 1,
    sourceScope: String(row.source_scope),
    sourcePurpose: row.source_purpose as RawMessage["sourcePurpose"],
    sourceAuthority: row.source_authority as RawMessage["sourceAuthority"],
    retrievalAllowed: Number(row.retrieval_allowed) === 1,
    evidencePolicyMask: row.evidence_policy_mask as RawMessage["evidencePolicyMask"],
    caseId: row.case_id === null ? undefined : String(row.case_id),
    parentMessageId: row.parent_message_id === null ? undefined : String(row.parent_message_id),
    metadata: JSON.parse(String(row.metadata_json ?? "{}")) as Record<string, unknown>,
    turnIndex: row.turn_index === null || row.turn_index === undefined ? undefined : Number(row.turn_index)
  };
}

function ftsQuery(query: string): string {
  const terms = query
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((term) => term.length > 1)
    .slice(0, 12);
  return terms.length === 0 ? "\"\"" : terms.map((term) => `"${term.replace(/"/gu, "\"\"")}"`).join(" OR ");
}

export class FtsSearch {
  private readonly policy = new EvidencePolicy();

  constructor(private readonly db: DatabaseSync) {}

  search(input: {
    agentId: string;
    query: string;
    evidencePolicy?: EvidencePolicyRequest;
    caseId?: string;
    limit?: number;
  }): Array<RawMessage & { hitKind: "raw_fts"; evidencePolicyChecked: boolean }> {
    const match = ftsQuery(input.query);
    if (match === "\"\"") {
      return [];
    }
    const rows = this.db
      .prepare(
        `SELECT rm.*, t.turn_index
         FROM raw_messages_fts fts
         JOIN raw_messages rm ON rm.rowid = fts.rowid
         LEFT JOIN turns t ON t.turn_id = rm.turn_id
         WHERE raw_messages_fts MATCH ? AND rm.agent_id = ?
         ORDER BY rm.sequence DESC
         LIMIT ?`
      )
      .all(match, input.agentId, input.limit ?? 20)
      .map((row) => mapRaw(row as Record<string, unknown>));
    const checked = input.evidencePolicy
      ? this.policy.filter(rows, input.evidencePolicy, input.caseId)
      : rows.filter((row) => row.retrievalAllowed);
    return checked.map((row) => ({ ...row, hitKind: "raw_fts", evidencePolicyChecked: input.evidencePolicy !== undefined }));
  }
}
