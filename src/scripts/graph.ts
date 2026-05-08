import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import type { SQLInputValue } from "node:sqlite";
import { createDefaultConfig } from "../core/ConfigResolver.js";
import { OmsOrchestrator } from "../core/OmsOrchestrator.js";

function valueAfter(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function backupDb(dbPath: string): string | undefined {
  if (dbPath === ":memory:" || !existsSync(dbPath)) {
    return undefined;
  }
  const backupPath = `${dbPath}.${new Date().toISOString().replace(/[:.]/g, "-")}.bak`;
  mkdirSync(dirname(backupPath), { recursive: true });
  copyFileSync(dbPath, backupPath);
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(`${dbPath}${suffix}`)) {
      copyFileSync(`${dbPath}${suffix}`, `${backupPath}${suffix}`);
    }
  }
  return backupPath;
}

function scalar(db: OmsOrchestrator["connection"]["db"], sql: string, ...args: SQLInputValue[]): number {
  return Number((db.prepare(sql).get(...args) as { count: number }).count);
}

export function graphStatus(oms: OmsOrchestrator) {
  const db = oms.connection.db;
  const graphableRawMessages = scalar(
    db,
    `SELECT COUNT(*) AS count
     FROM raw_messages
     WHERE agent_id = ?
       AND role = 'user'
       AND retrieval_allowed = 1
       AND interrupted = 0
       AND source_purpose IN ('general_chat', 'material_corpus', 'formal_question', 'imported_timeline')
       AND normalized_text NOT LIKE '## oms openclaw memory%'
       AND normalized_text NOT LIKE '%[oms memory policy]%'`,
    oms.config.agentId
  );
  const graphRelations = oms.graph.countEdges(oms.config.agentId);
  const relationTypes = db
    .prepare(
      `SELECT relation_type AS relationType, COUNT(*) AS count
       FROM graph_relations
       WHERE agent_id = ? AND status = 'active'
       GROUP BY relation_type
       ORDER BY count DESC, relation_type ASC
       LIMIT 10`
    )
    .all(oms.config.agentId);
  const topNoisyEntities = db
    .prepare(
      `SELECT display_label AS label, entity_type AS entityType, mention_count AS mentionCount
       FROM graph_entities
       WHERE agent_id = ? AND status = 'active'
       ORDER BY mention_count DESC, display_label ASC
       LIMIT 10`
    )
    .all(oms.config.agentId);
  const lastBuildRun = db
    .prepare(
      `SELECT extractor_version AS extractorVersion, started_at AS startedAt, finished_at AS finishedAt,
              high_watermark_sequence AS highWatermarkSequence, raw_scanned AS rawScanned,
              entities_upserted AS entitiesUpserted, relations_upserted AS relationsUpserted,
              occurrences_inserted AS occurrencesInserted, status, error
       FROM graph_build_runs
       WHERE agent_id = ?
       ORDER BY started_at DESC
       LIMIT 1`
    )
    .get(oms.config.agentId);
  return {
    agentId: oms.config.agentId,
    rawMessages: oms.rawMessages.countForAgent(oms.config.agentId),
    graphableRawMessages,
    graphEntities: oms.graph.countNodes(oms.config.agentId),
    graphRelations,
    graphMentions: oms.graph.countMentions(oms.config.agentId),
    graphOccurrences: oms.graph.countOccurrences(oms.config.agentId),
    relationRawRatio: graphableRawMessages === 0 ? 0 : Number((graphRelations / graphableRawMessages).toFixed(3)),
    relationTypes,
    topNoisyEntities,
    lastBuildRun,
    duplicateRelations: scalar(
      db,
      `SELECT COALESCE(SUM(count - 1), 0) AS count
       FROM (
         SELECT COUNT(*) AS count
         FROM graph_relations
         WHERE agent_id = ?
         GROUP BY from_entity_id, to_entity_id, relation_type
         HAVING COUNT(*) > 1
       )`,
      oms.config.agentId
    ),
    duplicateOccurrences: scalar(
      db,
      `SELECT COALESCE(SUM(count - 1), 0) AS count
       FROM (
         SELECT COUNT(*) AS count
         FROM graph_relation_occurrences
         WHERE agent_id = ?
         GROUP BY relation_id, raw_id, extractor, rule_id, evidence_text_hash
         HAVING COUNT(*) > 1
       )`,
      oms.config.agentId
    )
  };
}

export function runGraphCommand(argv = process.argv): void {
  const command = argv[2] ?? "status";
  const config = createDefaultConfig({
    agentId: valueAfter(argv, "--agent") ?? process.env.OMS_AGENT_ID,
    dbPath: valueAfter(argv, "--db") ?? process.env.OMS_DB_PATH
  });

  if (command === "rebuild") {
    const backupPath = argv.includes("--no-backup") ? undefined : backupDb(config.dbPath);
    const oms = new OmsOrchestrator(config);
    const before = graphStatus(oms);
    const result = oms.graphBuilder.rebuildAgent(config.agentId);
    const after = graphStatus(oms);
    console.log(JSON.stringify({ ok: true, command, backupPath, result, before, after }, null, 2));
    oms.connection.close();
  } else if (command === "status") {
    const oms = new OmsOrchestrator(config);
    console.log(JSON.stringify({ ok: true, command, status: graphStatus(oms) }, null, 2));
    oms.connection.close();
  } else {
    console.error(`Unknown command: ${command}`);
    console.error("Usage: graph.js status|rebuild [--agent <id>] [--db <path>] [--no-backup]");
    process.exit(2);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runGraphCommand();
}
