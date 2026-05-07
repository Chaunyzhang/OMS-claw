import type { DatabaseSync } from "node:sqlite";
import type { CandidateLaneResult } from "../../types.js";
import { GraphBuilder } from "../../processing/GraphBuilder.js";
import { GraphStore } from "../../storage/GraphStore.js";
import { tokenTerms } from "./queryText.js";

export class GraphCteLane {
  readonly lane = "graph_cte" as const;

  constructor(
    private readonly db: DatabaseSync,
    private readonly builder: GraphBuilder,
    private readonly graph: GraphStore
  ) {}

  search(input: { agentId: string; query: string; limit?: number; maxDepth?: number; fanout?: number }): CandidateLaneResult {
    const started = Date.now();
    try {
      this.builder.buildForAgent(input.agentId);
      const seeds = this.graph.seedNodes(input.agentId, tokenTerms(input.query, 2), input.fanout ?? 12);
      if (seeds.length === 0) {
        return { lane: this.lane, status: "ok", candidates: [], timingsMs: { total: Date.now() - started } };
      }
      const placeholders = seeds.map(() => "?").join(",");
      const rows = this.db
        .prepare(
          `WITH RECURSIVE walk(node_id, depth, path, raw_id) AS (
            SELECT node_id, 0, node_id, source_raw_id
            FROM graph_nodes
            WHERE agent_id = ? AND node_id IN (${placeholders})
            UNION ALL
            SELECT ge.to_node_id, walk.depth + 1, walk.path || ',' || ge.to_node_id,
                   COALESCE(ge.source_raw_id, gn.source_raw_id, walk.raw_id)
            FROM walk
            JOIN graph_edges ge ON ge.from_node_id = walk.node_id
            JOIN graph_nodes gn ON gn.node_id = ge.to_node_id
            WHERE ge.agent_id = ?
              AND ge.status = 'active'
              AND walk.depth < ?
              AND instr(walk.path, ge.to_node_id) = 0
          )
          SELECT raw_id AS rawId, MIN(depth) AS depth, COUNT(*) AS paths
          FROM walk
          WHERE raw_id IS NOT NULL
          GROUP BY raw_id
          ORDER BY depth ASC, paths DESC
          LIMIT ?`
        )
        .all(input.agentId, ...seeds.map((seed) => seed.nodeId), input.agentId, input.maxDepth ?? 2, input.limit ?? 20) as Array<{
        rawId: string;
        depth: number;
        paths: number;
      }>;
      return {
        lane: this.lane,
        status: "ok",
        timingsMs: { total: Date.now() - started },
        candidates: rows.map((row, index) => ({
          targetKind: "graph_node",
          targetId: seeds[0].nodeId,
          rawIdHint: row.rawId,
          graphPath: { seedNodeIds: seeds.map((seed) => seed.nodeId), depth: row.depth, paths: row.paths },
          rank: index + 1,
          score: 1 / (1 + Number(row.depth)),
          reason: { recursiveCte: true, maxDepth: input.maxDepth ?? 2, candidateOnly: true, evidenceRequired: true }
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
