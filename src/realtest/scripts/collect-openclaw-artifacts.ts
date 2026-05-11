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
  queryTraceFile: string | null;
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
      queryTraceFile: null,
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
  const queryTraceFile = join(input.runDir, "query-trace.json");
  writeJson(
    queryTraceFile,
    dbPath && existsSync(dbPath)
      ? inspectLatestQueryTrace({ dbPath, sessionId: resolveQuestionSessionKey(input.runDir) })
      : { ok: false, reason: "oms_db_path_missing_or_not_found", dbPath }
  );
  const runtimeReportFile = join(input.runDir, "runtime-report.json");
  writeJson(runtimeReportFile, {
    collectedAt: new Date().toISOString(),
    omsDbPath: dbPath,
    dbReport,
    queryTraceFile
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
    queryTraceFile,
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

function inspectLatestQueryTrace(input: { dbPath: string; sessionId: string | null }): unknown {
  const db = new DatabaseSync(input.dbPath, { readOnly: true });
  try {
    const selectedRun =
      (input.sessionId
        ? db
            .prepare(
              `SELECT run_id AS runId, session_id AS sessionId, created_at AS createdAt, query, mode, intent, status,
                      timings_json AS timingsJson, metadata_json AS metadataJson
               FROM retrieval_runs
               WHERE session_id = ?
               ORDER BY created_at DESC
               LIMIT 1`
            )
            .get(input.sessionId)
        : undefined) ??
      db
        .prepare(
          `SELECT run_id AS runId, session_id AS sessionId, created_at AS createdAt, query, mode, intent, status,
                  timings_json AS timingsJson, metadata_json AS metadataJson
           FROM retrieval_runs
           ORDER BY created_at DESC
           LIMIT 1`
        )
        .get();
    if (!selectedRun || typeof selectedRun !== "object") {
      return {
        ok: false,
        reason: input.sessionId ? "no_retrieval_run_for_question_session" : "no_retrieval_run_found",
        sessionId: input.sessionId,
        dbPath: input.dbPath
      };
    }
    const run = selectedRun as {
      runId: string;
      sessionId?: string;
      createdAt: string;
      query: string;
      mode: string;
      intent: string;
      status: string;
      timingsJson: string;
      metadataJson: string;
    };
    const metadata = parseJson<Record<string, unknown>>(run.metadataJson) ?? {};
    const queryId =
      typeof metadata.queryId === "string"
        ? metadata.queryId
        : (
            db
              .prepare("SELECT query_id AS queryId FROM evidence_packets WHERE run_id = ? ORDER BY created_at DESC LIMIT 1")
              .get(run.runId) as { queryId?: string } | undefined
          )?.queryId;
    const fusionRunId =
      typeof metadata.fusionRunId === "string"
        ? metadata.fusionRunId
        : (
            db
              .prepare("SELECT fusion_run_id AS fusionRunId FROM evidence_packets WHERE run_id = ? ORDER BY created_at DESC LIMIT 1")
              .get(run.runId) as { fusionRunId?: string } | undefined
          )?.fusionRunId;
    const packet = db
      .prepare(
        `SELECT packet_id AS packetId, status, selected_authoritative_raw_count AS selectedAuthoritativeRawCount,
                selected_raw_count AS selectedRawCount, summary_derived_raw_count AS summaryDerivedRawCount,
                raw_excerpt_hash AS rawExcerptHash, raw_excerpt_preview_json AS rawExcerptPreviewJson,
                authority_report_json AS authorityReportJson, delivery_report_json AS deliveryReportJson,
                metadata_json AS metadataJson, created_at AS createdAt
         FROM evidence_packets
         WHERE run_id = ?
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(run.runId) as
      | {
          packetId: string;
          status: string;
          selectedAuthoritativeRawCount: number;
          selectedRawCount: number;
          summaryDerivedRawCount: number;
          rawExcerptHash?: string;
          rawExcerptPreviewJson: string;
          authorityReportJson: string;
          deliveryReportJson: string;
          metadataJson: string;
          createdAt: string;
        }
      | undefined;

    const candidateRows = queryId
      ? db
          .prepare(
            `SELECT lane, status, target_kind AS targetKind, target_id AS targetId, raw_id_hint AS rawIdHint,
                    summary_id_hint AS summaryIdHint, rank, score, reason_json AS reasonJson
             FROM retrieval_candidates
             WHERE query_id = ?
             ORDER BY lane ASC, rank ASC, score DESC`
          )
          .all(queryId)
      : db
          .prepare(
            `SELECT lane, status, target_kind AS targetKind, target_id AS targetId, raw_id_hint AS rawIdHint,
                    summary_id_hint AS summaryIdHint, rank, score, reason_json AS reasonJson
             FROM retrieval_candidates
             WHERE run_id = ?
             ORDER BY lane ASC, rank ASC, score DESC`
          )
          .all(run.runId);

    const fusedCandidates =
      fusionRunId && typeof fusionRunId === "string"
        ? db
            .prepare(
              `SELECT raw_id AS rawId, fused_rank AS fusedRank, fused_score AS fusedScore,
                      lane_votes_json AS laneVotesJson, reason_json AS reasonJson
               FROM fused_candidates
               WHERE fusion_run_id = ?
               ORDER BY fused_rank ASC
               LIMIT 20`
            )
            .all(fusionRunId)
            .map((row) => {
              const value = row as {
                rawId: string;
                fusedRank: number;
                fusedScore: number;
                laneVotesJson: string;
                reasonJson: string;
              };
              return {
                rawId: value.rawId,
                fusedRank: value.fusedRank,
                fusedScore: value.fusedScore,
                laneVotes: parseJson<unknown[]>(value.laneVotesJson) ?? [],
                reason: parseJson<Record<string, unknown>>(value.reasonJson) ?? {}
              };
            })
        : [];

    const groupedCandidates = new Map<
      string,
      {
        candidateCount: number;
        statuses: string[];
        topCandidates: Array<Record<string, unknown>>;
      }
    >();
    for (const row of candidateRows) {
      const value = row as {
        lane?: string;
        status?: string;
        targetKind?: string;
        targetId?: string;
        rawIdHint?: string;
        summaryIdHint?: string;
        rank?: number;
        score?: number;
        reasonJson?: string;
      };
      const lane = String(value.lane ?? "unknown");
      const entry = groupedCandidates.get(lane) ?? { candidateCount: 0, statuses: [], topCandidates: [] };
      entry.candidateCount += 1;
      if (value.status && !entry.statuses.includes(value.status)) {
        entry.statuses.push(value.status);
      }
      if (entry.topCandidates.length < 5) {
        entry.topCandidates.push({
          targetKind: value.targetKind ?? null,
          targetId: value.targetId ?? null,
          rawIdHint: value.rawIdHint ?? null,
          summaryIdHint: value.summaryIdHint ?? null,
          rank: value.rank ?? null,
          score: value.score ?? null,
          reason: parseJson<Record<string, unknown>>(value.reasonJson ?? "{}") ?? {}
        });
      }
      groupedCandidates.set(lane, entry);
    }

    return {
      ok: true,
      dbPath: input.dbPath,
      sessionId: run.sessionId ?? input.sessionId,
      run: {
        runId: run.runId,
        createdAt: run.createdAt,
        query: run.query,
        mode: run.mode,
        intent: run.intent,
        status: run.status,
        timingsMs: parseJson<Record<string, number>>(run.timingsJson) ?? {}
      },
      summary: {
        queryId: queryId ?? null,
        caseId: metadata.caseId ?? null,
        requiredLane: metadata.requiredLane ?? null,
        lanesUsed: Array.isArray(metadata.lanesUsed) ? metadata.lanesUsed : Array.from(groupedCandidates.keys()),
        lanesDegraded: Array.isArray(metadata.lanesDegraded) ? metadata.lanesDegraded : [],
        candidateCount: typeof metadata.candidateCount === "number" ? metadata.candidateCount : candidateRows.length,
        fusionRunId: fusionRunId ?? null,
        answerPolicy: metadata.answerPolicy ?? null,
        reason: metadata.reason ?? null,
        packetId: metadata.packetId ?? packet?.packetId ?? null,
        packetStatus: metadata.packetStatus ?? packet?.status ?? null,
        packetDelivered:
          typeof metadata.packetDelivered === "boolean" ? metadata.packetDelivered : (metadata.packetStatus ?? packet?.status) === "delivered",
        sourceRoutes: Array.isArray(metadata.sourceRoutes) ? metadata.sourceRoutes : parseJson<Record<string, unknown>>(packet?.metadataJson ?? "{}")?.sourceRoutes ?? []
      },
      candidatesByLane: Object.fromEntries(groupedCandidates.entries()),
      fusedCandidates,
      packet: packet
        ? {
            packetId: packet.packetId,
            status: packet.status,
            selectedAuthoritativeRawCount: packet.selectedAuthoritativeRawCount,
            selectedRawCount: packet.selectedRawCount,
            summaryDerivedRawCount: packet.summaryDerivedRawCount,
            rawExcerptHash: packet.rawExcerptHash ?? null,
            rawExcerptPreview: parseJson<unknown[]>(packet.rawExcerptPreviewJson) ?? [],
            authorityReport: parseJson<Record<string, unknown>>(packet.authorityReportJson) ?? {},
            deliveryReport: parseJson<Record<string, unknown>>(packet.deliveryReportJson) ?? {},
            metadata: parseJson<Record<string, unknown>>(packet.metadataJson) ?? {},
            createdAt: packet.createdAt
          }
        : null
    };
  } finally {
    db.close();
  }
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

function resolveQuestionSessionKey(runDir: string): string | null {
  const questionArtifact = readOptionalJson<{ sessionKey?: string }>(join(runDir, "send-question.json"));
  return typeof questionArtifact?.sessionKey === "string" ? questionArtifact.sessionKey : null;
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

function parseJson<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
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
