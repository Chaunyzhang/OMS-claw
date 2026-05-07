import type { DatabaseSync } from "node:sqlite";
import type { FeatureHealth } from "../contracts/FeatureHealth.js";
import type { LaneStatus } from "../types.js";

export class FeatureHealthRegistry {
  constructor(private readonly db: DatabaseSync) {}

  mark(feature: string, status: LaneStatus, metadata: Record<string, unknown> = {}, error?: unknown): void {
    this.db
      .prepare(
        `INSERT INTO feature_health (feature, status, last_ok_at, last_error_at, last_error, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(feature) DO UPDATE SET
           status=excluded.status,
           last_ok_at=COALESCE(excluded.last_ok_at, feature_health.last_ok_at),
           last_error_at=COALESCE(excluded.last_error_at, feature_health.last_error_at),
           last_error=excluded.last_error,
           metadata_json=excluded.metadata_json`
      )
      .run(
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
      .prepare("SELECT * FROM feature_health ORDER BY feature ASC")
      .all()
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
}
