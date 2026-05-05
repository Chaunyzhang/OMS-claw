import type { DatabaseSync } from "node:sqlite";
import type { OmsConfig } from "../types.js";

export class ConfigStore {
  constructor(private readonly db: DatabaseSync) {}

  ensureAgent(config: OmsConfig): void {
    this.db
      .prepare(
        `INSERT INTO agents (agent_id, created_at, display_name, memory_repo_path, config_json, status)
         VALUES (?, ?, ?, ?, ?, 'active')
         ON CONFLICT(agent_id) DO UPDATE SET
           memory_repo_path=excluded.memory_repo_path,
           config_json=excluded.config_json,
           status='active'`
      )
      .run(
        config.agentId,
        new Date().toISOString(),
        config.agentId,
        config.memoryRepoPath ?? null,
        JSON.stringify(config)
      );
  }
}
