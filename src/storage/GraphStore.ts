import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

function id(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

function canonical(label: string): string {
  return label.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
}

export interface GraphNodeRecord {
  nodeId: string;
  label: string;
  canonicalLabel: string;
  sourceRawId?: string;
}

export class GraphStore {
  constructor(private readonly db: DatabaseSync) {}

  upsertNode(input: { agentId: string; nodeType: string; label: string; sourceRawId?: string; confidence?: number }): string {
    const canonicalLabel = canonical(input.label);
    const nodeId = id("gn", `${input.agentId}:${input.nodeType}:${canonicalLabel}`);
    this.db
      .prepare(
        `INSERT INTO graph_nodes (
          node_id, agent_id, node_type, label, canonical_label, source_raw_id,
          confidence, status, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', '{}')
        ON CONFLICT(node_id) DO UPDATE SET
          source_raw_id=COALESCE(graph_nodes.source_raw_id, excluded.source_raw_id),
          confidence=MAX(graph_nodes.confidence, excluded.confidence),
          status='active'`
      )
      .run(nodeId, input.agentId, input.nodeType, input.label, canonicalLabel, input.sourceRawId ?? null, input.confidence ?? 0.6);
    return nodeId;
  }

  upsertEdge(input: {
    agentId: string;
    fromNodeId: string;
    toNodeId: string;
    relation: string;
    sourceRawId?: string;
    weight?: number;
    confidence?: number;
    metadata?: Record<string, unknown>;
  }): string {
    const edgeId = id("ge", `${input.agentId}:${input.fromNodeId}:${input.toNodeId}:${input.relation}:${input.sourceRawId ?? ""}`);
    this.db
      .prepare(
        `INSERT INTO graph_edges (
          edge_id, agent_id, from_node_id, to_node_id, relation, weight,
          confidence, source_raw_id, created_at, status, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
        ON CONFLICT(edge_id) DO UPDATE SET
          weight=MAX(graph_edges.weight, excluded.weight),
          confidence=MAX(graph_edges.confidence, excluded.confidence),
          status='active',
          metadata_json=excluded.metadata_json`
      )
      .run(
        edgeId,
        input.agentId,
        input.fromNodeId,
        input.toNodeId,
        input.relation,
        input.weight ?? 1,
        input.confidence ?? 0.6,
        input.sourceRawId ?? null,
        new Date().toISOString(),
        JSON.stringify(input.metadata ?? {})
      );
    return edgeId;
  }

  seedNodes(agentId: string, queryTerms: string[], limit = 20): GraphNodeRecord[] {
    if (queryTerms.length === 0) {
      return [];
    }
    const rows = this.db
      .prepare(
        `SELECT node_id AS nodeId, label, canonical_label AS canonicalLabel, source_raw_id AS sourceRawId
         FROM graph_nodes
         WHERE agent_id = ? AND status = 'active'
         ORDER BY confidence DESC`
      )
      .all(agentId) as Array<{ nodeId: string; label: string; canonicalLabel: string; sourceRawId: string | null }>;
    return rows
      .filter((row) => queryTerms.some((term) => row.canonicalLabel.includes(term) || term.includes(row.canonicalLabel)))
      .slice(0, limit)
      .map((row) => ({
        nodeId: row.nodeId,
        label: row.label,
        canonicalLabel: row.canonicalLabel,
        sourceRawId: row.sourceRawId ?? undefined
      }));
  }

  countNodes(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS count FROM graph_nodes").get() as { count: number }).count);
  }

  countEdges(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS count FROM graph_edges").get() as { count: number }).count);
  }
}
