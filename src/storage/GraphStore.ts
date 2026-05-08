import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

function id(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

function hash(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function canonical(label: string): string {
  return label.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
}

function rowChanges(result: unknown): number {
  return typeof result === "object" && result !== null && "changes" in result ? Number((result as { changes: number }).changes) : 0;
}

export interface GraphNodeRecord {
  nodeId: string;
  label: string;
  canonicalLabel: string;
  sourceRawId?: string;
}

export interface GraphRelationRecord {
  relationId: string;
  fromEntityId: string;
  toEntityId: string;
  relationType: string;
  weight: number;
  confidence: number;
  occurrenceCount: number;
}

export class GraphStore {
  constructor(private readonly db: DatabaseSync) {}

  upsertEntity(input: {
    agentId: string;
    entityType: string;
    label: string;
    confidence?: number;
    description?: string;
    observedAt?: string;
    metadata?: Record<string, unknown>;
  }): string {
    const canonicalLabel = canonical(input.label);
    const entityId = id("ge", `${input.agentId}:${input.entityType}:${canonicalLabel}`);
    const observedAt = input.observedAt ?? new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO graph_entities (
          entity_id, agent_id, entity_type, canonical_label, display_label, aliases_json,
          description, confidence, mention_count, first_seen_at, last_seen_at, status, metadata_json
        ) VALUES (?, ?, ?, ?, ?, '[]', ?, ?, 0, ?, ?, 'active', ?)
        ON CONFLICT(entity_id) DO UPDATE SET
          display_label=COALESCE(NULLIF(graph_entities.display_label, ''), excluded.display_label),
          description=COALESCE(graph_entities.description, excluded.description),
          confidence=MAX(graph_entities.confidence, excluded.confidence),
          last_seen_at=excluded.last_seen_at,
          status='active',
          metadata_json=excluded.metadata_json`
      )
      .run(
        entityId,
        input.agentId,
        input.entityType,
        canonicalLabel,
        input.label.trim(),
        input.description ?? null,
        input.confidence ?? 0.5,
        observedAt,
        observedAt,
        JSON.stringify(input.metadata ?? {})
      );
    return entityId;
  }

  insertMention(input: {
    agentId: string;
    entityId: string;
    rawId: string;
    turnId?: string;
    textUnitId?: string;
    extractor: string;
    extractorVersion: string;
    startChar?: number;
    endChar?: number;
    mentionText: string;
    confidence?: number;
    observedAt?: string;
    metadata?: Record<string, unknown>;
  }): boolean {
    const mentionId = id(
      "gm",
      `${input.agentId}:${input.entityId}:${input.rawId}:${input.extractor}:${input.startChar ?? ""}:${input.endChar ?? ""}:${input.mentionText}`
    );
    const result = this.db
      .prepare(
        `INSERT INTO graph_entity_mentions (
          mention_id, agent_id, entity_id, raw_id, turn_id, text_unit_id, extractor,
          extractor_version, start_char, end_char, mention_text, confidence, created_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(agent_id, entity_id, raw_id, extractor, start_char, end_char) DO NOTHING`
      )
      .run(
        mentionId,
        input.agentId,
        input.entityId,
        input.rawId,
        input.turnId ?? null,
        input.textUnitId ?? null,
        input.extractor,
        input.extractorVersion,
        input.startChar ?? null,
        input.endChar ?? null,
        input.mentionText,
        input.confidence ?? 0.5,
        input.observedAt ?? new Date().toISOString(),
        JSON.stringify(input.metadata ?? {})
      );
    const inserted = rowChanges(result) > 0;
    if (inserted) {
      this.refreshEntityStats(input.entityId);
    }
    return inserted;
  }

  upsertRelation(input: {
    agentId: string;
    fromEntityId: string;
    toEntityId: string;
    relationType: string;
    directionality?: "directed" | "undirected";
    description?: string;
    confidence?: number;
    observedAt?: string;
    metadata?: Record<string, unknown>;
  }): string {
    const directionality = input.directionality ?? "directed";
    const [fromEntityId, toEntityId] =
      directionality === "undirected" && input.fromEntityId > input.toEntityId
        ? [input.toEntityId, input.fromEntityId]
        : [input.fromEntityId, input.toEntityId];
    const relationType = input.relationType.toUpperCase();
    const relationId = id("gr", `${input.agentId}:${fromEntityId}:${toEntityId}:${relationType}`);
    const observedAt = input.observedAt ?? new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO graph_relations (
          relation_id, agent_id, from_entity_id, to_entity_id, relation_type, directionality,
          description, weight, confidence, occurrence_count, first_seen_at, last_seen_at, status, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 0, ?, ?, 'active', ?)
        ON CONFLICT(relation_id) DO UPDATE SET
          description=COALESCE(graph_relations.description, excluded.description),
          confidence=MAX(graph_relations.confidence, excluded.confidence),
          last_seen_at=excluded.last_seen_at,
          status='active',
          metadata_json=excluded.metadata_json`
      )
      .run(
        relationId,
        input.agentId,
        fromEntityId,
        toEntityId,
        relationType,
        directionality,
        input.description ?? null,
        input.confidence ?? 0.5,
        observedAt,
        observedAt,
        JSON.stringify(input.metadata ?? {})
      );
    return relationId;
  }

  insertRelationOccurrence(input: {
    agentId: string;
    relationId: string;
    rawId: string;
    turnId?: string;
    textUnitId?: string;
    extractor: string;
    extractorVersion: string;
    ruleId?: string;
    evidenceText?: string;
    evidenceTextHash?: string;
    startChar?: number;
    endChar?: number;
    strength?: number;
    confidence?: number;
    observedAt?: string;
    metadata?: Record<string, unknown>;
  }): boolean {
    const evidenceTextHash = input.evidenceTextHash ?? hash(input.evidenceText ?? `${input.relationId}:${input.rawId}`);
    const occurrenceId = id(
      "go",
      `${input.agentId}:${input.relationId}:${input.rawId}:${input.extractor}:${input.ruleId ?? ""}:${evidenceTextHash}`
    );
    const result = this.db
      .prepare(
        `INSERT INTO graph_relation_occurrences (
          occurrence_id, agent_id, relation_id, raw_id, turn_id, text_unit_id, extractor,
          extractor_version, rule_id, evidence_text_hash, start_char, end_char, strength,
          confidence, created_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(agent_id, relation_id, raw_id, extractor, rule_id, evidence_text_hash) DO NOTHING`
      )
      .run(
        occurrenceId,
        input.agentId,
        input.relationId,
        input.rawId,
        input.turnId ?? null,
        input.textUnitId ?? null,
        input.extractor,
        input.extractorVersion,
        input.ruleId ?? null,
        evidenceTextHash,
        input.startChar ?? null,
        input.endChar ?? null,
        input.strength ?? 1,
        input.confidence ?? 0.5,
        input.observedAt ?? new Date().toISOString(),
        JSON.stringify(input.metadata ?? {})
      );
    const inserted = rowChanges(result) > 0;
    if (inserted) {
      this.refreshRelationStats(input.relationId);
    }
    return inserted;
  }

  seedNodes(agentId: string, queryTerms: string[], limit = 20): GraphNodeRecord[] {
    if (queryTerms.length === 0) {
      return [];
    }
    const rows = this.db
      .prepare(
        `SELECT entity_id AS nodeId, display_label AS label, canonical_label AS canonicalLabel
         FROM graph_entities
         WHERE agent_id = ? AND status = 'active'
         ORDER BY confidence DESC, mention_count DESC, last_seen_at DESC`
      )
      .all(agentId) as Array<{ nodeId: string; label: string; canonicalLabel: string }>;
    return rows
      .filter((row) => queryTerms.some((term) => row.canonicalLabel.includes(term) || term.includes(row.canonicalLabel)))
      .slice(0, limit)
      .map((row) => ({
        nodeId: row.nodeId,
        label: row.label,
        canonicalLabel: row.canonicalLabel
      }));
  }

  latestHighWatermark(agentId: string, extractorVersion: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(high_watermark_sequence), 0) AS watermark
         FROM graph_build_runs
         WHERE agent_id = ? AND extractor_version = ? AND status = 'succeeded'`
      )
      .get(agentId, extractorVersion) as { watermark: number } | undefined;
    return Number(row?.watermark ?? 0);
  }

  recordBuildRun(input: {
    agentId: string;
    extractorVersion: string;
    startedAt: string;
    finishedAt?: string;
    highWatermarkSequence?: number;
    rawScanned: number;
    entitiesUpserted: number;
    relationsUpserted: number;
    occurrencesInserted: number;
    status: "succeeded" | "failed";
    error?: string;
    metadata?: Record<string, unknown>;
  }): void {
    this.db
      .prepare(
        `INSERT INTO graph_build_runs (
          run_id, agent_id, extractor_version, started_at, finished_at, high_watermark_sequence,
          raw_scanned, entities_upserted, relations_upserted, occurrences_inserted,
          status, error, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id("gbr", `${input.agentId}:${input.extractorVersion}:${input.startedAt}`),
        input.agentId,
        input.extractorVersion,
        input.startedAt,
        input.finishedAt ?? null,
        input.highWatermarkSequence ?? null,
        input.rawScanned,
        input.entitiesUpserted,
        input.relationsUpserted,
        input.occurrencesInserted,
        input.status,
        input.error ?? null,
        JSON.stringify(input.metadata ?? {})
      );
  }

  clearV2ForAgent(agentId: string): void {
    this.db.prepare("DELETE FROM graph_relation_occurrences WHERE agent_id = ?").run(agentId);
    this.db.prepare("DELETE FROM graph_relations WHERE agent_id = ?").run(agentId);
    this.db.prepare("DELETE FROM graph_entity_mentions WHERE agent_id = ?").run(agentId);
    this.db.prepare("DELETE FROM graph_entities WHERE agent_id = ?").run(agentId);
    this.db.prepare("DELETE FROM graph_build_runs WHERE agent_id = ?").run(agentId);
  }

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
    const edgeId = id("gex", `${input.agentId}:${input.fromNodeId}:${input.toNodeId}:${input.relation}:${input.sourceRawId ?? ""}`);
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

  countNodes(agentId?: string): number {
    const row =
      agentId === undefined
        ? this.db.prepare("SELECT COUNT(*) AS count FROM graph_entities WHERE status = 'active'").get()
        : this.db.prepare("SELECT COUNT(*) AS count FROM graph_entities WHERE status = 'active' AND agent_id = ?").get(agentId);
    return Number((row as { count: number }).count);
  }

  countEdges(agentId?: string): number {
    const row =
      agentId === undefined
        ? this.db.prepare("SELECT COUNT(*) AS count FROM graph_relations WHERE status = 'active'").get()
        : this.db.prepare("SELECT COUNT(*) AS count FROM graph_relations WHERE status = 'active' AND agent_id = ?").get(agentId);
    return Number((row as { count: number }).count);
  }

  countMentions(agentId?: string): number {
    const row =
      agentId === undefined
        ? this.db.prepare("SELECT COUNT(*) AS count FROM graph_entity_mentions").get()
        : this.db.prepare("SELECT COUNT(*) AS count FROM graph_entity_mentions WHERE agent_id = ?").get(agentId);
    return Number((row as { count: number }).count);
  }

  countOccurrences(agentId?: string): number {
    const row =
      agentId === undefined
        ? this.db.prepare("SELECT COUNT(*) AS count FROM graph_relation_occurrences").get()
        : this.db.prepare("SELECT COUNT(*) AS count FROM graph_relation_occurrences WHERE agent_id = ?").get(agentId);
    return Number((row as { count: number }).count);
  }

  private refreshEntityStats(entityId: string): void {
    this.db
      .prepare(
        `UPDATE graph_entities
         SET mention_count = (SELECT COUNT(*) FROM graph_entity_mentions WHERE entity_id = ?),
             first_seen_at = COALESCE((SELECT MIN(created_at) FROM graph_entity_mentions WHERE entity_id = ?), first_seen_at),
             last_seen_at = COALESCE((SELECT MAX(created_at) FROM graph_entity_mentions WHERE entity_id = ?), last_seen_at)
         WHERE entity_id = ?`
      )
      .run(entityId, entityId, entityId, entityId);
  }

  private refreshRelationStats(relationId: string): void {
    const stats = this.db
      .prepare(
        `SELECT COUNT(*) AS count,
                COALESCE(AVG(confidence), 0.5) AS avgConfidence,
                COALESCE(AVG(strength), 1) AS avgStrength,
                MIN(created_at) AS firstSeenAt,
                MAX(created_at) AS lastSeenAt
         FROM graph_relation_occurrences
         WHERE relation_id = ?`
      )
      .get(relationId) as { count: number; avgConfidence: number; avgStrength: number; firstSeenAt: string | null; lastSeenAt: string | null };
    const occurrenceCount = Number(stats.count);
    const avgConfidence = Number(stats.avgConfidence);
    const avgStrength = Number(stats.avgStrength);
    const weight = Math.min(10, Math.max(0.1, Math.log1p(occurrenceCount) * avgConfidence * avgStrength));
    this.db
      .prepare(
        `UPDATE graph_relations
         SET occurrence_count = ?,
             confidence = MAX(confidence, ?),
             weight = ?,
             first_seen_at = COALESCE(?, first_seen_at),
             last_seen_at = COALESCE(?, last_seen_at)
         WHERE relation_id = ?`
      )
      .run(occurrenceCount, avgConfidence, weight, stats.firstSeenAt, stats.lastSeenAt, relationId);
  }
}
