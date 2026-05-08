import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface SourceEdge {
  edgeId: string;
  agentId: string;
  sourceKind: string;
  sourceId: string;
  targetKind: string;
  targetId: string;
  relation: string;
  createdAt: string;
  sourceHash?: string;
  targetHash?: string;
  metadata: Record<string, unknown>;
}

function mapEdge(row: Record<string, unknown>): SourceEdge {
  return {
    edgeId: String(row.edge_id),
    agentId: String(row.agent_id),
    sourceKind: String(row.source_kind),
    sourceId: String(row.source_id),
    targetKind: String(row.target_kind),
    targetId: String(row.target_id),
    relation: String(row.relation),
    createdAt: String(row.created_at),
    sourceHash: row.source_hash === null ? undefined : String(row.source_hash),
    targetHash: row.target_hash === null ? undefined : String(row.target_hash),
    metadata: JSON.parse(String(row.metadata_json ?? "{}")) as Record<string, unknown>
  };
}

export class SourceEdgeStore {
  constructor(private readonly db: DatabaseSync) {}

  create(input: Omit<SourceEdge, "edgeId" | "createdAt" | "metadata"> & { metadata?: Record<string, unknown> }): SourceEdge {
    const edgeId = `edge_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO source_edges (
          edge_id, agent_id, source_kind, source_id, target_kind, target_id, relation,
          created_at, source_hash, target_hash, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        edgeId,
        input.agentId,
        input.sourceKind,
        input.sourceId,
        input.targetKind,
        input.targetId,
        input.relation,
        createdAt,
        input.sourceHash ?? null,
        input.targetHash ?? null,
        JSON.stringify(input.metadata ?? {})
      );
    return { ...input, edgeId, createdAt, metadata: input.metadata ?? {} };
  }

  fromSource(sourceKind: string, sourceId: string): SourceEdge[] {
    return this.db
      .prepare("SELECT * FROM source_edges WHERE source_kind = ? AND source_id = ? ORDER BY created_at ASC")
      .all(sourceKind, sourceId)
      .map((row) => mapEdge(row as Record<string, unknown>));
  }

  toTarget(targetKind: string, targetId: string): SourceEdge[] {
    return this.db
      .prepare("SELECT * FROM source_edges WHERE target_kind = ? AND target_id = ? ORDER BY created_at ASC")
      .all(targetKind, targetId)
      .map((row) => mapEdge(row as Record<string, unknown>));
  }

  count(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS count FROM source_edges").get() as { count: number }).count);
  }

  countForAgent(agentId: string): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS count FROM source_edges WHERE agent_id = ?").get(agentId) as { count: number }).count);
  }
}
