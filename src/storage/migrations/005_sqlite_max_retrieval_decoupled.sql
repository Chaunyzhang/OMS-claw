-- Mirror of SQLiteConnection migration 5.
-- This migration keeps raw_messages as the only evidence source while adding
-- independently degradable candidate lanes and audit tables.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  checksum TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oms_manifest (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS feature_health (
  feature TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  last_ok_at TEXT,
  last_error_at TEXT,
  last_error TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE VIRTUAL TABLE IF NOT EXISTS raw_trigram
USING fts5(
  message_id UNINDEXED,
  agent_id UNINDEXED,
  session_id UNINDEXED,
  normalized_text,
  content='',
  tokenize='trigram'
);

CREATE TABLE IF NOT EXISTS embedding_chunks (
  chunk_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  raw_id TEXT NOT NULL,
  chunk_text_hash TEXT NOT NULL,
  chunk_start_char INTEGER NOT NULL,
  chunk_end_char INTEGER NOT NULL,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS embedding_vectors (
  chunk_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  vector_f32 BLOB NOT NULL,
  vector_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS graph_nodes (
  node_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  node_type TEXT NOT NULL,
  label TEXT NOT NULL,
  canonical_label TEXT NOT NULL,
  source_raw_id TEXT,
  source_summary_id TEXT,
  confidence REAL NOT NULL DEFAULT 0.5,
  status TEXT NOT NULL DEFAULT 'active',
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS graph_edges (
  edge_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  from_node_id TEXT NOT NULL,
  to_node_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1.0,
  confidence REAL NOT NULL DEFAULT 0.5,
  source_raw_id TEXT,
  source_summary_id TEXT,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS retrieval_queries (
  query_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  session_id TEXT,
  user_query TEXT NOT NULL,
  normalized_query TEXT NOT NULL,
  mode TEXT NOT NULL,
  created_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS fusion_runs (
  fusion_run_id TEXT PRIMARY KEY,
  query_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  algorithm TEXT NOT NULL,
  created_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS fused_candidates (
  fusion_run_id TEXT NOT NULL,
  raw_id TEXT NOT NULL,
  fused_rank INTEGER NOT NULL,
  fused_score REAL NOT NULL,
  lane_votes_json TEXT NOT NULL,
  reason_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY(fusion_run_id, raw_id)
);

CREATE TABLE IF NOT EXISTS evidence_packet_items (
  packet_id TEXT NOT NULL,
  item_index INTEGER NOT NULL,
  raw_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  excerpt_text TEXT NOT NULL,
  excerpt_hash TEXT NOT NULL,
  source_purpose TEXT NOT NULL,
  source_authority TEXT NOT NULL,
  evidence_allowed INTEGER NOT NULL,
  window_start_sequence INTEGER NOT NULL,
  window_end_sequence INTEGER NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY(packet_id, item_index)
);

CREATE TABLE IF NOT EXISTS jobs (
  job_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  job_type TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','running','succeeded','failed','cancelled')),
  priority INTEGER NOT NULL DEFAULT 100,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  available_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  last_error TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS compaction_events (
  compact_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  start_sequence INTEGER NOT NULL,
  end_sequence INTEGER NOT NULL,
  status TEXT NOT NULL,
  reason TEXT NOT NULL,
  summary_id TEXT,
  created_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS oms_events (
  event_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  session_id TEXT,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  created_at TEXT NOT NULL,
  correlation_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}'
);
