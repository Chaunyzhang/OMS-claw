import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { basename, dirname, join, resolve } from "node:path";
import { isMain, listFiles, parseArgs, readJson, sha256File, writeJson } from "../common.js";

interface PreflightReport {
  ok?: boolean;
  status?: string;
  failureReasons?: string[];
  environment?: {
    configEntryOms?: unknown;
  };
}

interface CollectorReport {
  ok: boolean;
  status: "PASS" | "ENV_FAIL" | "COLLECTED_WITH_GAPS";
  runDir: string;
  collectedAt: string;
  senderArtifacts: Array<{ file: string; ok?: boolean; sessionKey?: string; acpSessionId?: string; messageId?: string }>;
  transcriptFile: string | null;
  finalAnswerFile: string | null;
  runtimeReportFile: string | null;
  omsDbPath: string | null;
  dbReport: unknown;
  failureReasons: string[];
  notes: string[];
}

export function collectOpenClawArtifacts(input: { runDir: string; transcriptFile?: string; dbPath?: string }): CollectorReport {
  const preflight = readOptionalJson<PreflightReport>(join(input.runDir, "preflight.json"));
  const runDirAbs = resolve(input.runDir);
  const senderArtifacts = listFiles(input.runDir)
    .filter((file) => resolve(dirname(file)) === runDirAbs)
    .filter((file) => /^send-(material-\d+|question)\.json$/u.test(basename(file)))
    .map((file) => {
      const artifact = readOptionalJson<{ ok?: boolean; sessionKey?: string; acpSessionId?: string; messageId?: string }>(file) ?? {};
      return {
        file,
        ok: artifact.ok,
        sessionKey: artifact.sessionKey,
        acpSessionId: artifact.acpSessionId,
        messageId: artifact.messageId
      };
    });

  if (preflight && preflight.ok !== true) {
    const report: CollectorReport = {
      ok: false,
      status: "ENV_FAIL",
      runDir: input.runDir,
      collectedAt: new Date().toISOString(),
      senderArtifacts,
      transcriptFile: null,
      finalAnswerFile: null,
      runtimeReportFile: null,
      omsDbPath: null,
      dbReport: null,
      failureReasons: preflight.failureReasons ?? ["preflight_failed"],
      notes: ["Preflight failed; collector did not inspect live OpenClaw state beyond frozen preflight artifacts."]
    };
    writeJson(join(input.runDir, "collector-report.json"), report);
    return report;
  }

  const collectedDir = join(input.runDir, "collected");
  mkdirSync(collectedDir, { recursive: true });
  const transcriptSource = resolveTranscriptFile(input.runDir, input.transcriptFile);
  const transcriptFile =
    transcriptSource && existsSync(transcriptSource) ? copyTranscriptSnapshot(transcriptSource, collectedDir) : null;
  const finalAnswerFile =
    transcriptFile && existsSync(transcriptFile) ? writeFinalAnswerGuess(collectedDir, transcriptFile) : null;
  const dbPath = input.dbPath ? resolve(input.dbPath) : resolveDbPath(preflight?.environment?.configEntryOms);
  const dbReport = dbPath && existsSync(dbPath) ? inspectOmsDb(dbPath) : { ok: false, reason: "oms_db_path_missing_or_not_found", dbPath };
  const runtimeReportFile = join(input.runDir, "runtime-report.json");
  writeJson(runtimeReportFile, {
    collectedAt: new Date().toISOString(),
    omsDbPath: dbPath,
    dbReport
  });

  const missing: string[] = [];
  if (!transcriptFile || !existsSync(transcriptFile)) {
    missing.push("openclaw_transcript_missing");
  }
  if (!dbPath || !existsSync(dbPath)) {
    missing.push("oms_db_missing");
  }

  const report: CollectorReport = {
    ok: missing.length === 0,
    status: missing.length === 0 ? "PASS" : "COLLECTED_WITH_GAPS",
    runDir: input.runDir,
    collectedAt: new Date().toISOString(),
    senderArtifacts,
    transcriptFile,
    finalAnswerFile,
    runtimeReportFile,
    omsDbPath: dbPath,
    dbReport,
    failureReasons: missing,
    notes: [
      "Collector is read-only: it reads frozen sender artifacts, optional transcript file, and local OMS DB if discoverable.",
      "It does not send OpenClaw messages or call OMS search tools."
    ]
  };
  writeJson(join(input.runDir, "collector-report.json"), report);
  return report;
}

function inspectOmsDb(dbPath: string): unknown {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const counts = {
      rawMessages: countTable(db, "raw_messages"),
      summaries: countTable(db, "summaries"),
      sourceEdges: countTable(db, "source_edges"),
      retrievalRuns: countTable(db, "retrieval_runs"),
      evidencePackets: countTable(db, "evidence_packets")
    };
    const recentEvidencePackets = selectAll(db, "SELECT * FROM evidence_packets ORDER BY created_at DESC LIMIT 10");
    const recentRetrievalRuns = selectAll(db, "SELECT * FROM retrieval_runs ORDER BY created_at DESC LIMIT 10");
    return { ok: true, dbPath, dbHash: sha256File(dbPath), counts, recentEvidencePackets, recentRetrievalRuns };
  } finally {
    db.close();
  }
}

function countTable(db: DatabaseSync, table: string): number | null {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count?: number } | undefined;
    return typeof row?.count === "number" ? row.count : null;
  } catch {
    return null;
  }
}

function selectAll(db: DatabaseSync, sql: string): unknown[] {
  try {
    return db.prepare(sql).all();
  } catch {
    return [];
  }
}

function resolveTranscriptFile(runDir: string, explicitTranscriptFile?: string): string | null {
  if (explicitTranscriptFile) {
    return resolve(explicitTranscriptFile);
  }
  const questionArtifact = readOptionalJson<{ sessionKey?: string }>(join(runDir, "send-question.json"));
  const sessionKey = questionArtifact?.sessionKey;
  if (!sessionKey) {
    return null;
  }
  const agentId = sessionKey.match(/^agent:([^:]+):/u)?.[1] ?? "main";
  const sessionsPath = join(homedir(), ".openclaw", "agents", agentId, "sessions", "sessions.json");
  const sessions = readOptionalJson<Record<string, { sessionFile?: string; sessionId?: string }>>(sessionsPath);
  const entry = sessions?.[sessionKey] ?? sessions?.[sessionKey.toLowerCase()];
  if (entry?.sessionFile) {
    return entry.sessionFile;
  }
  if (entry?.sessionId) {
    return join(homedir(), ".openclaw", "agents", agentId, "sessions", `${entry.sessionId}.jsonl`);
  }
  return null;
}

function copyTranscriptSnapshot(source: string, collectedDir: string): string {
  const target = join(collectedDir, "openclaw-transcript.jsonl");
  copyFileSync(source, target);
  return target;
}

function writeFinalAnswerGuess(outputDir: string, transcriptFile: string): string {
  const text = readFileSync(transcriptFile, "utf8");
  const final = extractFinalAssistantText(text);
  const out = join(outputDir, "openclaw-final-answer.txt");
  writeJson(join(outputDir, "openclaw-final-answer.meta.json"), {
    source: transcriptFile,
    extraction: "last assistant visible text message from OpenClaw JSONL transcript",
    extractedCharacters: final.length
  });
  writeFileSync(out, `${final}\n`, "utf8");
  return out;
}

function extractFinalAssistantText(jsonl: string): string {
  let lastAssistantText = "";
  for (const line of jsonl.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let record: unknown;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const message = (record as { message?: { role?: string; content?: unknown } }).message;
    if (message?.role !== "assistant") {
      continue;
    }
    const content = message.content;
    const textParts = Array.isArray(content)
      ? content
          .filter((part): part is { type?: string; text?: string } => typeof part === "object" && part !== null)
          .filter((part) => part.type === "text" && typeof part.text === "string")
          .map((part) => part.text)
      : typeof content === "string"
        ? [content]
        : [];
    const visibleText = textParts.join("\n").trim();
    if (visibleText) {
      lastAssistantText = visibleText;
    }
  }
  return lastAssistantText;
}

function resolveDbPath(entryConfig: unknown): string | null {
  const config = typeof entryConfig === "object" && entryConfig !== null ? (entryConfig as { config?: Record<string, unknown> }).config : undefined;
  if (!config) {
    return join(homedir(), ".openclaw", "oms", "oms-agent-default.sqlite");
  }
  if (typeof config.dbPath === "string") {
    return config.dbPath === ":memory:" ? config.dbPath : resolve(config.dbPath);
  }
  if (typeof config.baseDir === "string") {
    const agentId = typeof config.agentId === "string" ? config.agentId : "oms-agent-default";
    return resolve(config.baseDir, `${agentId}.sqlite`);
  }
  const agentId = typeof config.agentId === "string" ? config.agentId : "oms-agent-default";
  return join(homedir(), ".openclaw", "oms", `${agentId}.sqlite`);
}

function readOptionalJson<T>(path: string): T | undefined {
  try {
    return readJson<T>(path);
  } catch {
    return undefined;
  }
}

async function main() {
  const args = parseArgs();
  const runDir = String(args["run-dir"] ?? "realtest/artifacts/runs/manual-preflight");
  const transcriptFile = args["transcript-file"] ? String(args["transcript-file"]) : undefined;
  const dbPath = args["db-path"] ? String(args["db-path"]) : undefined;
  const report = collectOpenClawArtifacts({ runDir, transcriptFile, dbPath });
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) {
    process.exitCode = report.status === "ENV_FAIL" ? 2 : 3;
  }
}

if (isMain(import.meta.url)) {
  await main();
}
