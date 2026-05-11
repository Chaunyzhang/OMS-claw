import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { createDefaultConfig } from "../core/ConfigResolver.js";
import { OmsOrchestrator } from "../core/OmsOrchestrator.js";
import { graphStatusSnapshot } from "../ui/GraphStatusPresenter.js";

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

export function graphStatus(oms: OmsOrchestrator) {
  return graphStatusSnapshot(oms);
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
