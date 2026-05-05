CREATE TABLE IF NOT EXISTS summaries (
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
CREATE INDEX IF NOT EXISTS idx_source_edges_target ON source_edges(target_kind, target_id);
