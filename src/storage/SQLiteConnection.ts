import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS agents (
    agent_id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    display_name TEXT,
    memory_repo_path TEXT,
    config_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
  );
  CREATE TABLE IF NOT EXISTS body_bindings (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    openclaw_agent_name TEXT,
    openclaw_agent_dir TEXT,
    workspace_dir TEXT,
    device_id TEXT,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    FOREIGN KEY(agent_id) REFERENCES agents(agent_id)
  );
  CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    openclaw_session_key TEXT,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    source_kind TEXT NOT NULL DEFAULT 'chat',
    case_id TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    FOREIGN KEY(agent_id) REFERENCES agents(agent_id)
  );
  CREATE TABLE IF NOT EXISTS turns (
    turn_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    turn_index INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'complete',
    user_message_id TEXT,
    assistant_message_id TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    UNIQUE(session_id, turn_index)
  );
  CREATE TABLE IF NOT EXISTS raw_messages (
    message_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    turn_id TEXT,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
    event_type TEXT NOT NULL DEFAULT 'created',
    created_at TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    original_text TEXT NOT NULL,
    normalized_text TEXT NOT NULL,
    token_count INTEGER NOT NULL,
    original_hash TEXT NOT NULL,
    visible_to_user INTEGER NOT NULL DEFAULT 1,
    interrupted INTEGER NOT NULL DEFAULT 0,
    source_scope TEXT NOT NULL DEFAULT 'agent',
    source_purpose TEXT NOT NULL DEFAULT 'general_chat',
    source_authority TEXT NOT NULL DEFAULT 'visible_transcript',
    retrieval_allowed INTEGER NOT NULL DEFAULT 1,
    evidence_policy_mask TEXT NOT NULL DEFAULT 'general_history',
    case_id TEXT,
    parent_message_id TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    FOREIGN KEY(session_id) REFERENCES sessions(session_id),
    FOREIGN KEY(turn_id) REFERENCES turns(turn_id)
  );
  CREATE INDEX IF NOT EXISTS idx_raw_agent_sequence ON raw_messages(agent_id, sequence);
  CREATE INDEX IF NOT EXISTS idx_raw_session_turn ON raw_messages(session_id, turn_id);
  CREATE INDEX IF NOT EXISTS idx_raw_policy ON raw_messages(agent_id, source_purpose, source_authority, retrieval_allowed);
  CREATE TABLE IF NOT EXISTS message_events (
    event_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    message_id TEXT,
    event_type TEXT NOT NULL,
    created_at TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}'
  );`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS raw_messages_fts USING fts5(
    message_id UNINDEXED,
    agent_id UNINDEXED,
    session_id UNINDEXED,
    role UNINDEXED,
    normalized_text,
    content='',
    tokenize='unicode61'
  );`,
  `CREATE TABLE IF NOT EXISTS summaries (
    summary_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    session_id TEXT,
    level INTEGER NOT NULL,
    node_kind TEXT NOT NULL CHECK(node_kind IN ('leaf', 'rollup', 'lifetime')),
    created_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    summary_text TEXT NOT NULL,
    token_count INTEGER NOT NULL,
    source_hash TEXT NOT NULL,
    source_message_count INTEGER NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS idx_summary_agent_level ON summaries(agent_id, level, status);
  CREATE TABLE IF NOT EXISTS source_edges (
    edge_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    source_id TEXT NOT NULL,
    target_kind TEXT NOT NULL,
    target_id TEXT NOT NULL,
    relation TEXT NOT NULL,
    created_at TEXT NOT NULL,
    source_hash TEXT,
    target_hash TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS idx_source_edges_source ON source_edges(source_kind, source_id);
  CREATE INDEX IF NOT EXISTS idx_source_edges_target ON source_edges(target_kind, target_id);`,
  `CREATE TABLE IF NOT EXISTS retrieval_runs (
    run_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    session_id TEXT,
    created_at TEXT NOT NULL,
    query TEXT NOT NULL,
    mode TEXT NOT NULL,
    intent TEXT NOT NULL,
    status TEXT NOT NULL,
    timings_json TEXT NOT NULL DEFAULT '{}',
    config_snapshot_json TEXT NOT NULL DEFAULT '{}',
    build_info_json TEXT NOT NULL DEFAULT '{}',
    metadata_json TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE IF NOT EXISTS evidence_packets (
    packet_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    status TEXT NOT NULL,
    selected_authoritative_raw_count INTEGER NOT NULL,
    selected_raw_count INTEGER NOT NULL,
    summary_derived_raw_count INTEGER NOT NULL,
    raw_message_ids_json TEXT NOT NULL,
    source_summary_ids_json TEXT NOT NULL,
    source_edge_ids_json TEXT NOT NULL,
    raw_excerpt_hash TEXT,
    raw_excerpt_preview_json TEXT NOT NULL DEFAULT '[]',
    authority_report_json TEXT NOT NULL DEFAULT '{}',
    delivery_report_json TEXT NOT NULL DEFAULT '{}',
    FOREIGN KEY(run_id) REFERENCES retrieval_runs(run_id)
  );
  CREATE TABLE IF NOT EXISTS retrieval_candidates (
    candidate_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    candidate_kind TEXT NOT NULL,
    candidate_id_ref TEXT NOT NULL,
    score REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    FOREIGN KEY(run_id) REFERENCES retrieval_runs(run_id)
  );`
];

export class SQLiteConnection {
  readonly db: DatabaseSync;

  constructor(readonly dbPath: string) {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  migrate(): void {
    for (const migration of MIGRATIONS) {
      this.db.exec(migration);
    }
  }

  close(): void {
    this.db.close();
  }
}
