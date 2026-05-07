import type { LaneStatus } from "../types.js";

export interface FeatureHealth {
  feature: string;
  status: LaneStatus;
  lastOkAt?: string;
  lastErrorAt?: string;
  lastError?: string;
  metadata: Record<string, unknown>;
}
