CREATE VIRTUAL TABLE IF NOT EXISTS raw_messages_fts USING fts5(
  message_id UNINDEXED,
  agent_id UNINDEXED,
  session_id UNINDEXED,
  role UNINDEXED,
  normalized_text,
  content='',
  tokenize='unicode61'
);
