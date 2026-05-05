CREATE TABLE IF NOT EXISTS agents (
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
);
