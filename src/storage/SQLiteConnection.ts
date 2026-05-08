import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

interface Migration {
  version: number;
  name: string;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "init",
    sql: `CREATE TABLE IF NOT EXISTS agents (
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
  );`
  },
  {
    version: 2,
    name: "fts",
    sql: `CREATE VIRTUAL TABLE IF NOT EXISTS raw_messages_fts USING fts5(
    message_id UNINDEXED,
    agent_id UNINDEXED,
    session_id UNINDEXED,
    role UNINDEXED,
    normalized_text,
    content='',
    tokenize='unicode61'
  );`
  },
  {
    version: 3,
    name: "summary_dag",
    sql: `CREATE TABLE IF NOT EXISTS summaries (
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
  CREATE INDEX IF NOT EXISTS idx_source_edges_target ON source_edges(target_kind, target_id);`
  },
  {
    version: 4,
    name: "evidence_packets",
    sql: `CREATE TABLE IF NOT EXISTS retrieval_runs (
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
  }
];

const MAX_RETRIEVAL_SCHEMA = {
  version: 5,
  name: "sqlite_max_retrieval_decoupled",
  sql: `CREATE TABLE IF NOT EXISTS oms_manifest (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS feature_health (
    agent_id TEXT NOT NULL DEFAULT '',
    feature TEXT NOT NULL,
    status TEXT NOT NULL,
    last_ok_at TEXT,
    last_error_at TEXT,
    last_error TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY(agent_id, feature)
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
    metadata_json TEXT NOT NULL DEFAULT '{}',
    FOREIGN KEY(raw_id) REFERENCES raw_messages(message_id)
  );
  CREATE TABLE IF NOT EXISTS embedding_vectors (
    chunk_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    model TEXT NOT NULL,
    dim INTEGER NOT NULL,
    vector_f32 BLOB NOT NULL,
    vector_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(chunk_id) REFERENCES embedding_chunks(chunk_id)
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

  CREATE TABLE IF NOT EXISTS graph_entities (
    entity_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    canonical_label TEXT NOT NULL,
    display_label TEXT NOT NULL,
    aliases_json TEXT NOT NULL DEFAULT '[]',
    description TEXT,
    confidence REAL NOT NULL DEFAULT 0.5,
    mention_count INTEGER NOT NULL DEFAULT 0,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    UNIQUE(agent_id, entity_type, canonical_label)
  );
  CREATE TABLE IF NOT EXISTS graph_entity_mentions (
    mention_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    raw_id TEXT NOT NULL,
    turn_id TEXT,
    text_unit_id TEXT,
    extractor TEXT NOT NULL,
    extractor_version TEXT NOT NULL,
    start_char INTEGER,
    end_char INTEGER,
    mention_text TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0.5,
    created_at TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    UNIQUE(agent_id, entity_id, raw_id, extractor, start_char, end_char)
  );
  CREATE TABLE IF NOT EXISTS graph_relations (
    relation_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    from_entity_id TEXT NOT NULL,
    to_entity_id TEXT NOT NULL,
    relation_type TEXT NOT NULL,
    directionality TEXT NOT NULL DEFAULT 'directed',
    description TEXT,
    weight REAL NOT NULL DEFAULT 1.0,
    confidence REAL NOT NULL DEFAULT 0.5,
    occurrence_count INTEGER NOT NULL DEFAULT 0,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    UNIQUE(agent_id, from_entity_id, to_entity_id, relation_type)
  );
  CREATE TABLE IF NOT EXISTS graph_relation_occurrences (
    occurrence_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    relation_id TEXT NOT NULL,
    raw_id TEXT NOT NULL,
    turn_id TEXT,
    text_unit_id TEXT,
    extractor TEXT NOT NULL,
    extractor_version TEXT NOT NULL,
    rule_id TEXT,
    evidence_text_hash TEXT,
    start_char INTEGER,
    end_char INTEGER,
    strength REAL NOT NULL DEFAULT 1.0,
    confidence REAL NOT NULL DEFAULT 0.5,
    created_at TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    UNIQUE(agent_id, relation_id, raw_id, extractor, rule_id, evidence_text_hash)
  );
  CREATE TABLE IF NOT EXISTS graph_build_runs (
    run_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    extractor_version TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    high_watermark_sequence INTEGER,
    raw_scanned INTEGER NOT NULL DEFAULT 0,
    entities_upserted INTEGER NOT NULL DEFAULT 0,
    relations_upserted INTEGER NOT NULL DEFAULT 0,
    occurrences_inserted INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    error TEXT,
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
  CREATE INDEX IF NOT EXISTS idx_jobs_ready ON jobs(status, available_at, priority);

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
  CREATE INDEX IF NOT EXISTS idx_events_agent_time ON oms_events(agent_id, created_at DESC);`
};

export class SQLiteConnection {
  readonly db: DatabaseSync;

  constructor(readonly dbPath: string) {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  migrate(): void {
    this.ensureMigrationTable();
    for (const migration of MIGRATIONS) {
      this.db.exec(migration.sql);
      this.recordMigration(migration);
    }
    this.extendRawMessages();
    this.extendRetrievalTables();
    this.db.exec(MAX_RETRIEVAL_SCHEMA.sql);
    this.ensureAgentScopedFeatureHealth();
    this.extendMaxRetrievalTables();
    this.recordMigration(MAX_RETRIEVAL_SCHEMA);
    this.ensureTrigramTable();
    this.seedFeatureHealth();
  }

  close(): void {
    this.db.close();
  }

  private ensureMigrationTable(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      checksum TEXT NOT NULL
    );`);
    this.addColumn("schema_migrations", "name", "name TEXT NOT NULL DEFAULT 'unknown'");
    this.addColumn("schema_migrations", "applied_at", "applied_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'");
    this.addColumn("schema_migrations", "checksum", "checksum TEXT NOT NULL DEFAULT ''");
  }

  private recordMigration(migration: Migration): void {
    const checksum = `sha256:${createHash("sha256").update(migration.sql).digest("hex")}`;
    this.db
      .prepare(
        `INSERT INTO schema_migrations (version, name, applied_at, checksum)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(version) DO UPDATE SET name=excluded.name, checksum=excluded.checksum`
      )
      .run(migration.version, migration.name, new Date().toISOString(), checksum);
  }

  private columnExists(table: string, column: string): boolean {
    return this.db.prepare(`PRAGMA table_info(${table})`).all().some((row) => String((row as { name: string }).name) === column);
  }

  private addColumn(table: string, column: string, ddl: string): void {
    if (!this.columnExists(table, column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl};`);
    }
  }

  private ensureAgentScopedFeatureHealth(): void {
    const columns = this.db.prepare("PRAGMA table_info(feature_health)").all() as Array<{ name: string; pk: number }>;
    const primaryKey = columns
      .filter((column) => column.pk > 0)
      .sort((left, right) => left.pk - right.pk)
      .map((column) => column.name)
      .join(",");
    if (columns.some((column) => column.name === "agent_id") && primaryKey === "agent_id,feature") {
      return;
    }

    const hasAgentId = columns.some((column) => column.name === "agent_id");
    this.db.exec(`
      DROP TABLE IF EXISTS feature_health_legacy_rebuild;
      ALTER TABLE feature_health RENAME TO feature_health_legacy_rebuild;
      CREATE TABLE feature_health (
        agent_id TEXT NOT NULL DEFAULT '',
        feature TEXT NOT NULL,
        status TEXT NOT NULL,
        last_ok_at TEXT,
        last_error_at TEXT,
        last_error TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY(agent_id, feature)
      );
    `);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO feature_health
          (agent_id, feature, status, last_ok_at, last_error_at, last_error, metadata_json)
         SELECT ${hasAgentId ? "COALESCE(agent_id, '')" : "''"},
                feature, status, last_ok_at, last_error_at, last_error, metadata_json
         FROM feature_health_legacy_rebuild`
      )
      .run();
    this.db.exec("DROP TABLE feature_health_legacy_rebuild;");
  }

  private extendRawMessages(): void {
    this.addColumn("raw_messages", "evidence_allowed", "evidence_allowed INTEGER NOT NULL DEFAULT 1");
    this.addColumn("raw_messages", "observed_at", "observed_at TEXT");
    this.addColumn("raw_messages", "turn_index", "turn_index INTEGER");
    this.addColumn("raw_messages", "message_state", "message_state TEXT NOT NULL DEFAULT 'created'");
    this.addColumn("raw_messages", "sensitive_mask_json", "sensitive_mask_json TEXT NOT NULL DEFAULT '{}'");
    this.addColumn("raw_messages", "evidence_policy_mask_int", "evidence_policy_mask_int INTEGER NOT NULL DEFAULT 0");
    this.db.exec(`UPDATE raw_messages SET observed_at = COALESCE(observed_at, created_at);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_raw_authority
      ON raw_messages(agent_id, evidence_allowed, retrieval_allowed, source_authority, source_purpose);`);
  }

  private extendRetrievalTables(): void {
    this.addColumn("retrieval_candidates", "query_id", "query_id TEXT");
    this.addColumn("retrieval_candidates", "agent_id", "agent_id TEXT");
    this.addColumn("retrieval_candidates", "lane", "lane TEXT");
    this.addColumn("retrieval_candidates", "target_kind", "target_kind TEXT");
    this.addColumn("retrieval_candidates", "target_id", "target_id TEXT");
    this.addColumn("retrieval_candidates", "raw_id_hint", "raw_id_hint TEXT");
    this.addColumn("retrieval_candidates", "summary_id_hint", "summary_id_hint TEXT");
    this.addColumn("retrieval_candidates", "graph_path_json", "graph_path_json TEXT");
    this.addColumn("retrieval_candidates", "rank", "rank INTEGER NOT NULL DEFAULT 0");
    this.addColumn("retrieval_candidates", "normalized_score", "normalized_score REAL");
    this.addColumn("retrieval_candidates", "reason_json", "reason_json TEXT NOT NULL DEFAULT '{}'");
    this.addColumn("retrieval_candidates", "created_at", "created_at TEXT");
    this.addColumn("evidence_packets", "query_id", "query_id TEXT");
    this.addColumn("evidence_packets", "fusion_run_id", "fusion_run_id TEXT");
    this.addColumn("evidence_packets", "session_id", "session_id TEXT");
    this.addColumn("evidence_packets", "metadata_json", "metadata_json TEXT NOT NULL DEFAULT '{}'");
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_retrieval_candidates_query_lane
      ON retrieval_candidates(query_id, lane, rank);`);
  }

  private extendMaxRetrievalTables(): void {
    this.addColumn("embedding_chunks", "agent_id", "agent_id TEXT NOT NULL DEFAULT ''");
    this.addColumn("embedding_chunks", "raw_id", "raw_id TEXT NOT NULL DEFAULT ''");
    this.addColumn("embedding_chunks", "chunk_text_hash", "chunk_text_hash TEXT NOT NULL DEFAULT ''");
    this.addColumn("embedding_chunks", "chunk_start_char", "chunk_start_char INTEGER NOT NULL DEFAULT 0");
    this.addColumn("embedding_chunks", "chunk_end_char", "chunk_end_char INTEGER NOT NULL DEFAULT 0");
    this.addColumn("embedding_chunks", "model", "model TEXT NOT NULL DEFAULT 'unknown'");
    this.addColumn("embedding_chunks", "dim", "dim INTEGER NOT NULL DEFAULT 0");
    this.addColumn("embedding_chunks", "created_at", "created_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'");
    this.addColumn("embedding_chunks", "status", "status TEXT NOT NULL DEFAULT 'active'");
    this.addColumn("embedding_chunks", "metadata_json", "metadata_json TEXT NOT NULL DEFAULT '{}'");
    if (this.columnExists("embedding_chunks", "raw_message_id")) {
      this.db.exec("UPDATE embedding_chunks SET raw_id = raw_message_id WHERE raw_id = '';");
    }
    this.addColumn("embedding_vectors", "agent_id", "agent_id TEXT NOT NULL DEFAULT ''");
    this.addColumn("embedding_vectors", "model", "model TEXT NOT NULL DEFAULT 'unknown'");
    this.addColumn("embedding_vectors", "dim", "dim INTEGER NOT NULL DEFAULT 0");
    this.addColumn("embedding_vectors", "vector_f32", "vector_f32 BLOB NOT NULL DEFAULT X''");
    this.addColumn("embedding_vectors", "vector_hash", "vector_hash TEXT NOT NULL DEFAULT ''");
    this.addColumn("embedding_vectors", "created_at", "created_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'");

    this.addColumn("graph_nodes", "agent_id", "agent_id TEXT NOT NULL DEFAULT ''");
    this.addColumn("graph_nodes", "node_type", "node_type TEXT NOT NULL DEFAULT 'entity'");
    this.addColumn("graph_nodes", "label", "label TEXT NOT NULL DEFAULT ''");
    this.addColumn("graph_nodes", "canonical_label", "canonical_label TEXT NOT NULL DEFAULT ''");
    this.addColumn("graph_nodes", "source_raw_id", "source_raw_id TEXT");
    this.addColumn("graph_nodes", "source_summary_id", "source_summary_id TEXT");
    this.addColumn("graph_nodes", "confidence", "confidence REAL NOT NULL DEFAULT 0.5");
    this.addColumn("graph_nodes", "status", "status TEXT NOT NULL DEFAULT 'active'");
    this.addColumn("graph_nodes", "metadata_json", "metadata_json TEXT NOT NULL DEFAULT '{}'");

    this.addColumn("graph_edges", "agent_id", "agent_id TEXT NOT NULL DEFAULT ''");
    this.addColumn("graph_edges", "from_node_id", "from_node_id TEXT NOT NULL DEFAULT ''");
    this.addColumn("graph_edges", "to_node_id", "to_node_id TEXT NOT NULL DEFAULT ''");
    this.addColumn("graph_edges", "relation", "relation TEXT NOT NULL DEFAULT 'related'");
    this.addColumn("graph_edges", "weight", "weight REAL NOT NULL DEFAULT 1.0");
    this.addColumn("graph_edges", "confidence", "confidence REAL NOT NULL DEFAULT 0.5");
    this.addColumn("graph_edges", "source_raw_id", "source_raw_id TEXT");
    this.addColumn("graph_edges", "source_summary_id", "source_summary_id TEXT");
    this.addColumn("graph_edges", "created_at", "created_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'");
    this.addColumn("graph_edges", "status", "status TEXT NOT NULL DEFAULT 'active'");
    this.addColumn("graph_edges", "metadata_json", "metadata_json TEXT NOT NULL DEFAULT '{}'");

    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_embedding_raw ON embedding_chunks(agent_id, raw_id, model);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_graph_edges_from ON graph_edges(agent_id, from_node_id, relation);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_graph_edges_to ON graph_edges(agent_id, to_node_id, relation);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_graph_nodes_label ON graph_nodes(agent_id, canonical_label);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_graph_entities_label ON graph_entities(agent_id, canonical_label);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_graph_entity_mentions_entity ON graph_entity_mentions(agent_id, entity_id);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_graph_entity_mentions_raw ON graph_entity_mentions(agent_id, raw_id);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_graph_relations_from ON graph_relations(agent_id, from_entity_id, relation_type);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_graph_relations_to ON graph_relations(agent_id, to_entity_id, relation_type);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_graph_relation_occurrences_relation ON graph_relation_occurrences(agent_id, relation_id);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_graph_relation_occurrences_raw ON graph_relation_occurrences(agent_id, raw_id);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_graph_build_runs_agent ON graph_build_runs(agent_id, extractor_version, started_at);`);
  }

  private ensureTrigramTable(): void {
    try {
      this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS raw_trigram USING fts5(
        message_id UNINDEXED,
        agent_id UNINDEXED,
        session_id UNINDEXED,
        normalized_text,
        content='',
        tokenize='trigram'
      );`);
      this.markFeature("trigram", "ready");
    } catch (error) {
      this.markFeature("trigram", "degraded", error);
    }
  }

  private seedFeatureHealth(): void {
    for (const feature of ["rawLedger", "evidencePacket", "ftsBm25", "summaryDag", "annVector", "graphCte", "sqlFusion"]) {
      this.markFeature(feature, feature === "annVector" ? "warming" : "ready");
    }
  }

  private markFeature(feature: string, status: string, error?: unknown): void {
    this.db
      .prepare(
          `INSERT INTO feature_health (agent_id, feature, status, last_ok_at, last_error_at, last_error, metadata_json)
         VALUES ('', ?, ?, ?, ?, ?, '{}')
         ON CONFLICT(agent_id, feature) DO UPDATE SET
           status=excluded.status,
           last_ok_at=COALESCE(excluded.last_ok_at, feature_health.last_ok_at),
           last_error_at=COALESCE(excluded.last_error_at, feature_health.last_error_at),
           last_error=COALESCE(excluded.last_error, feature_health.last_error)`
      )
      .run(
        feature,
        status,
        error === undefined ? new Date().toISOString() : null,
        error === undefined ? null : new Date().toISOString(),
        error === undefined ? null : error instanceof Error ? error.message : String(error)
      );
  }
}
