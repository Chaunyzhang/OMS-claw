import type { DatabaseSync } from "node:sqlite";
import type { CandidateLaneResult } from "../../types.js";
import { GraphStore } from "../../storage/GraphStore.js";
import { tokenTerms } from "./queryText.js";

interface RawCandidate {
  rawId: string;
  depth: number;
  paths: number;
  score: number;
  relationIds: Set<string>;
  occurrenceIds: Set<string>;
}

function upsertCandidate(
  candidates: Map<string, RawCandidate>,
  input: { rawId: string; depth: number; paths?: number; score?: number; relationId?: string | null; occurrenceId?: string | null }
): void {
  const existing = candidates.get(input.rawId);
  if (!existing) {
    candidates.set(input.rawId, {
      rawId: input.rawId,
      depth: input.depth,
      paths: input.paths ?? 1,
      score: input.score ?? 1,
      relationIds: new Set(input.relationId ? [input.relationId] : []),
      occurrenceIds: new Set(input.occurrenceId ? [input.occurrenceId] : [])
    });
    return;
  }
  existing.depth = Math.min(existing.depth, input.depth);
  existing.paths += input.paths ?? 1;
  existing.score = Math.max(existing.score, input.score ?? 1);
  if (input.relationId) {
    existing.relationIds.add(input.relationId);
  }
  if (input.occurrenceId) {
    existing.occurrenceIds.add(input.occurrenceId);
  }
}

export class GraphCteLane {
  readonly lane = "graph_cte" as const;

  constructor(
    private readonly db: DatabaseSync,
    private readonly graph: GraphStore
  ) {}

  search(input: { agentId: string; query: string; limit?: number; maxDepth?: number; fanout?: number }): CandidateLaneResult {
    const started = Date.now();
    try {
      const requestedFanout = Math.max(1, Math.floor(input.fanout ?? 8));
      const seedLimit = 12;
      const traversalFanout = Math.min(requestedFanout, 8);
      const candidateLimit = Math.min(Math.max(1, Math.floor(input.limit ?? 20)), 20);
      const seeds = this.graph.seedNodes(input.agentId, tokenTerms(input.query, 2), seedLimit);
      if (seeds.length === 0) {
        return { lane: this.lane, status: "ok", candidates: [], timingsMs: { total: Date.now() - started } };
      }

      const candidates = new Map<string, RawCandidate>();
      const placeholders = seeds.map(() => "?").join(",");
      const seedIds = seeds.map((seed) => seed.nodeId);
      const directRows = this.db
        .prepare(
          `SELECT raw_id AS rawId, COUNT(*) AS paths, MAX(confidence) AS score
           FROM graph_entity_mentions
           WHERE agent_id = ? AND entity_id IN (${placeholders})
           GROUP BY raw_id`
        )
        .all(input.agentId, ...seedIds) as Array<{ rawId: string; paths: number; score: number }>;
      for (const row of directRows) {
        upsertCandidate(candidates, {
          rawId: row.rawId,
          depth: 0,
          paths: Number(row.paths),
          score: Number(row.score)
        });
      }

      const walkRows = this.db
        .prepare(
          `WITH RECURSIVE
          relation_neighbors AS (
            SELECT
              relation_id,
              agent_id,
              from_entity_id AS entity_id,
              to_entity_id AS neighbor_id,
              relation_type,
              weight,
              occurrence_count
            FROM graph_relations
            WHERE status = 'active'
            UNION ALL
            SELECT
              relation_id,
              agent_id,
              to_entity_id AS entity_id,
              from_entity_id AS neighbor_id,
              relation_type,
              weight,
              occurrence_count
            FROM graph_relations
            WHERE status = 'active'
          ),
          ranked_neighbors AS (
            SELECT
              relation_id,
              agent_id,
              entity_id,
              neighbor_id,
              ROW_NUMBER() OVER (
                PARTITION BY agent_id, entity_id
                ORDER BY weight DESC, occurrence_count DESC, relation_id ASC
              ) AS fanout_rank
            FROM relation_neighbors
          ),
          walk(entity_id, depth, path, relation_id) AS (
            SELECT entity_id, 0, ',' || entity_id || ',', NULL
            FROM graph_entities
            WHERE agent_id = ? AND entity_id IN (${placeholders})
            UNION ALL
            SELECT
              rn.neighbor_id AS entity_id,
              walk.depth + 1,
              walk.path || rn.neighbor_id || ',',
              rn.relation_id
            FROM walk
            JOIN ranked_neighbors rn
              ON rn.agent_id = ?
             AND rn.entity_id = walk.entity_id
             AND rn.fanout_rank <= ?
            WHERE walk.depth < ?
              AND instr(walk.path, ',' || rn.neighbor_id || ',') = 0
          )
          SELECT
            gro.raw_id AS rawId,
            walk.relation_id AS relationId,
            gro.occurrence_id AS occurrenceId,
            MIN(walk.depth) AS depth,
            COUNT(*) AS paths,
            MAX(gr.weight * gro.confidence) AS score
          FROM walk
          JOIN graph_relations gr ON gr.relation_id = walk.relation_id
          JOIN graph_relation_occurrences gro ON gro.relation_id = walk.relation_id
          WHERE walk.relation_id IS NOT NULL
          GROUP BY gro.raw_id, walk.relation_id, gro.occurrence_id`
        )
        .all(input.agentId, ...seedIds, input.agentId, traversalFanout, Math.min(input.maxDepth ?? 2, 2)) as Array<{
        rawId: string;
        relationId: string;
        occurrenceId: string;
        depth: number;
        paths: number;
        score: number;
      }>;
      for (const row of walkRows) {
        upsertCandidate(candidates, {
          rawId: row.rawId,
          depth: Number(row.depth),
          paths: Number(row.paths),
          score: Number(row.score),
          relationId: row.relationId,
          occurrenceId: row.occurrenceId
        });
      }

      const rows = Array.from(candidates.values())
        .sort((left, right) => left.depth - right.depth || right.score - left.score || right.paths - left.paths)
        .slice(0, candidateLimit);
      return {
        lane: this.lane,
        status: "ok",
        timingsMs: { total: Date.now() - started },
        candidates: rows.map((row, index) => ({
          targetKind: "graph_node",
          targetId: seeds[0].nodeId,
          rawIdHint: row.rawId,
          graphPath: {
            seedNodeIds: seedIds,
            depth: row.depth,
            paths: row.paths,
            relationIds: Array.from(row.relationIds),
            occurrenceIds: Array.from(row.occurrenceIds)
          },
          rank: index + 1,
          score: row.score / (1 + row.depth),
          reason: {
            recursiveCte: true,
            graphVersion: 2,
            maxDepth: Math.min(input.maxDepth ?? 2, 2),
            seedLimit,
            traversalFanout,
            rawCandidateLimit: candidateLimit,
            candidateOnly: true,
            evidenceRequired: true
          }
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
