import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { SummaryRecord } from "../types.js";

function mapSummary(row: Record<string, unknown>): SummaryRecord {
  return {
    summaryId: String(row.summary_id),
    agentId: String(row.agent_id),
    sessionId: row.session_id === null ? undefined : String(row.session_id),
    level: Number(row.level),
    nodeKind: row.node_kind as SummaryRecord["nodeKind"],
    createdAt: String(row.created_at),
    status: row.status as SummaryRecord["status"],
    summaryText: String(row.summary_text),
    tokenCount: Number(row.token_count),
    sourceHash: String(row.source_hash),
    sourceMessageCount: Number(row.source_message_count),
    metadata: JSON.parse(String(row.metadata_json ?? "{}")) as Record<string, unknown>
  };
}

export class SummaryStore {
  constructor(private readonly db: DatabaseSync) {}

  create(input: {
    agentId: string;
    sessionId?: string;
    level: number;
    nodeKind: SummaryRecord["nodeKind"];
    summaryText: string;
    sourceHash: string;
    sourceMessageCount: number;
    metadata?: Record<string, unknown>;
  }): SummaryRecord {
    const summaryId = `sum_${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO summaries (
          summary_id, agent_id, session_id, level, node_kind, created_at, status,
          summary_text, token_count, source_hash, source_message_count, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`
      )
      .run(
        summaryId,
        input.agentId,
        input.sessionId ?? null,
        input.level,
        input.nodeKind,
        new Date().toISOString(),
        input.summaryText,
        Math.max(1, input.summaryText.split(/\s+/u).length),
        input.sourceHash,
        input.sourceMessageCount,
        JSON.stringify(input.metadata ?? {})
      );
    const found = this.byId(summaryId);
    if (!found) {
      throw new Error("summary_write_not_confirmed");
    }
    return found;
  }

  activeBySourceHash(input: { agentId: string; sourceHash: string; nodeKind?: SummaryRecord["nodeKind"] }): SummaryRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM summaries
         WHERE agent_id = ?
           AND source_hash = ?
           AND status = 'active'
           AND (? IS NULL OR node_kind = ?)
         ORDER BY created_at ASC
         LIMIT 1`
      )
      .get(input.agentId, input.sourceHash, input.nodeKind ?? null, input.nodeKind ?? null) as Record<string, unknown> | undefined;
    return row ? mapSummary(row) : undefined;
  }

  byId(summaryId: string): SummaryRecord | undefined {
    const row = this.db.prepare("SELECT * FROM summaries WHERE summary_id = ?").get(summaryId) as Record<string, unknown> | undefined;
    return row ? mapSummary(row) : undefined;
  }

  search(agentId: string, query: string, limit = 10): SummaryRecord[] {
    const terms = query
      .toLowerCase()
      .split(/[^\p{L}\p{N}_]+/u)
      .filter(Boolean);
    if (terms.length === 0) {
      return [];
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM summaries
         WHERE agent_id = ? AND status = 'active'
         ORDER BY created_at DESC`
      )
      .all(agentId) as Array<Record<string, unknown>>;
    return rows
      .map(mapSummary)
      .map((summary) => ({
        summary,
        score: terms.reduce((total, term) => total + (summary.summaryText.toLowerCase().includes(term) ? 1 : 0), 0)
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((item) => item.summary);
  }

  count(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS count FROM summaries").get() as { count: number }).count);
  }

  static hashSources(parts: string[]): string {
    return `sha256:${createHash("sha256").update(parts.join("\n"), "utf8").digest("hex")}`;
  }
}
