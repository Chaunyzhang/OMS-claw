import type { DatabaseSync } from "node:sqlite";
import type { FeatureHealth } from "../contracts/FeatureHealth.js";
import type { LaneStatus } from "../types.js";

const DEFAULT_FEATURES = ["rawLedger", "evidencePacket", "ftsBm25", "summaryDag", "annVector", "graphCte", "sqlFusion"] as const;

export class FeatureHealthRegistry {
  constructor(
    private readonly db: DatabaseSync,
    private readonly agentId: string
  ) {
    this.ensureDefaults();
  }

  mark(feature: string, status: LaneStatus, metadata: Record<string, unknown> = {}, error?: unknown): void {
    this.db
      .prepare(
        `INSERT INTO feature_health (agent_id, feature, status, last_ok_at, last_error_at, last_error, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent_id, feature) DO UPDATE SET
           status=excluded.status,
           last_ok_at=COALESCE(excluded.last_ok_at, feature_health.last_ok_at),
           last_error_at=COALESCE(excluded.last_error_at, feature_health.last_error_at),
           last_error=excluded.last_error,
           metadata_json=excluded.metadata_json`
      )
      .run(
        this.agentId,
        feature,
        status,
        error === undefined ? new Date().toISOString() : null,
        error === undefined ? null : new Date().toISOString(),
        error === undefined ? null : error instanceof Error ? error.message : String(error),
        JSON.stringify(metadata)
      );
  }

  all(): FeatureHealth[] {
    return this.db
      .prepare(
        `WITH ranked AS (
          SELECT *,
                 ROW_NUMBER() OVER (
                   PARTITION BY feature
                   ORDER BY CASE WHEN agent_id = ? THEN 0 ELSE 1 END
                 ) AS rank
          FROM feature_health
          WHERE agent_id IN (?, '')
        )
        SELECT * FROM ranked
        WHERE rank = 1
        ORDER BY feature ASC`
      )
      .all(this.agentId, this.agentId)
      .map((row) => {
        const value = row as Record<string, unknown>;
        return {
          feature: String(value.feature),
          status: String(value.status) as LaneStatus,
          lastOkAt: value.last_ok_at === null ? undefined : String(value.last_ok_at),
          lastErrorAt: value.last_error_at === null ? undefined : String(value.last_error_at),
          lastError: value.last_error === null ? undefined : String(value.last_error),
          metadata: JSON.parse(String(value.metadata_json ?? "{}")) as Record<string, unknown>
        };
      });
  }

  statusMap(): Record<string, LaneStatus> {
    return Object.fromEntries(this.all().map((item) => [item.feature, item.status]));
  }

  private ensureDefaults(): void {
    const insert = this.db.prepare(
      `INSERT INTO feature_health (agent_id, feature, status, last_ok_at, last_error_at, last_error, metadata_json)
       VALUES (?, ?, ?, ?, NULL, NULL, '{}')
       ON CONFLICT(agent_id, feature) DO NOTHING`
    );
    const now = new Date().toISOString();
    for (const feature of DEFAULT_FEATURES) {
      insert.run(this.agentId, feature, feature === "annVector" ? "warming" : "ready", now);
    }
  }
}
