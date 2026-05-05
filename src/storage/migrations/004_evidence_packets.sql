CREATE TABLE IF NOT EXISTS retrieval_runs (
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
);
