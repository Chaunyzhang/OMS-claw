import { basename, join, resolve } from "node:path";
import { isMain, listFiles, parseArgs, readJson, writeJson } from "../common.js";

interface VerdictFile {
  status: string;
  overallPass: boolean;
  answerCorrect?: boolean;
  requiredModuleUsed?: boolean;
  authoritativeEvidenceValid?: boolean;
  runValid?: boolean;
  failureReasons?: string[];
  runDir?: string;
}

interface QueryTraceFile {
  ok?: boolean;
  summary?: {
    lanesUsed?: string[];
    lanesDegraded?: Array<{ lane?: string; status?: string; error?: string }>;
    answerPolicy?: string | null;
    packetStatus?: string | null;
    candidateCount?: number;
  };
  run?: {
    mode?: string;
    query?: string;
    timingsMs?: Record<string, number>;
  };
}

interface RunPlanFile {
  runId?: string;
  caseId?: string;
  createdAt?: string;
}

interface SenderArtifactFile {
  durationMs?: number;
}

export interface BatchSummary {
  ok: boolean;
  generatedAt: string;
  sourceRoot: string;
  totalRuns: number;
  passedRuns: number;
  failedRuns: number;
  envFailedRuns: number;
  passRate: number;
  answerCorrectRate: number;
  authoritativeEvidenceRate: number;
  runValidRate: number;
  averageQuestionDurationMs: number | null;
  medianQuestionDurationMs: number | null;
  averageCandidateCount: number | null;
  statusCounts: Record<string, number>;
  answerPolicyCounts: Record<string, number>;
  packetStatusCounts: Record<string, number>;
  laneUsageCounts: Record<string, number>;
  degradedLaneCounts: Record<string, number>;
  failureReasonCounts: Record<string, number>;
  runs: Array<{
    runId: string;
    caseId: string;
    status: string;
    overallPass: boolean;
    answerCorrect: boolean;
    authoritativeEvidenceValid: boolean;
    runValid: boolean;
    answerPolicy: string | null;
    packetStatus: string | null;
    candidateCount: number | null;
    questionDurationMs: number | null;
    query: string | null;
    mode: string | null;
    failureReasons: string[];
  }>;
}

export function summarizeResults(input: { sourceRoot: string; outFile?: string }): BatchSummary {
  const sourceRoot = resolve(input.sourceRoot);
  const runDirs = findRunDirs(sourceRoot);
  const runs = runDirs.flatMap((runDir) => {
    const verdictPath = join(runDir, "verdict.json");
    if (!listFiles(runDir).includes(verdictPath) && !existsVerdict(runDir)) {
      return [];
    }
    const verdict = readJson<VerdictFile>(join(runDir, "verdict.json"));
    const queryTrace = readOptionalJson<QueryTraceFile>(join(runDir, "query-trace.json"));
    const runPlan = readOptionalJson<RunPlanFile>(join(runDir, "run-plan.json"));
    const sendQuestion = readOptionalJson<SenderArtifactFile>(join(runDir, "send-question.json"));
    return [
      {
        runId: runPlan?.runId ?? basename(runDir),
        caseId: runPlan?.caseId ?? basename(runDir),
        status: verdict.status,
        overallPass: verdict.overallPass === true,
        answerCorrect: verdict.answerCorrect === true,
        authoritativeEvidenceValid: verdict.authoritativeEvidenceValid === true,
        runValid: verdict.runValid === true,
        answerPolicy: queryTrace?.summary?.answerPolicy ?? null,
        packetStatus: queryTrace?.summary?.packetStatus ?? null,
        candidateCount: typeof queryTrace?.summary?.candidateCount === "number" ? queryTrace.summary.candidateCount : null,
        questionDurationMs: typeof sendQuestion?.durationMs === "number" ? sendQuestion.durationMs : null,
        query: typeof queryTrace?.run?.query === "string" ? queryTrace.run.query : null,
        mode: typeof queryTrace?.run?.mode === "string" ? queryTrace.run.mode : null,
        lanesUsed: Array.isArray(queryTrace?.summary?.lanesUsed) ? queryTrace.summary.lanesUsed : [],
        lanesDegraded: Array.isArray(queryTrace?.summary?.lanesDegraded) ? queryTrace.summary.lanesDegraded : [],
        failureReasons: Array.isArray(verdict.failureReasons) ? verdict.failureReasons : []
      }
    ];
  });

  const statusCounts = countBy(runs.map((run) => run.status));
  const answerPolicyCounts = countBy(runs.map((run) => run.answerPolicy).filter((value): value is string => typeof value === "string" && value.length > 0));
  const packetStatusCounts = countBy(runs.map((run) => run.packetStatus).filter((value): value is string => typeof value === "string" && value.length > 0));
  const laneUsageCounts = countBy(runs.flatMap((run) => run.lanesUsed));
  const degradedLaneCounts = countBy(
    runs.flatMap((run) =>
      run.lanesDegraded
        .map((entry) => (typeof entry?.lane === "string" && entry.lane.length > 0 ? entry.lane : undefined))
        .filter((value): value is string => typeof value === "string")
    )
  );
  const failureReasonCounts = countBy(runs.flatMap((run) => run.failureReasons));
  const questionDurations = runs.map((run) => run.questionDurationMs).filter((value): value is number => typeof value === "number");
  const candidateCounts = runs.map((run) => run.candidateCount).filter((value): value is number => typeof value === "number");

  const summary: BatchSummary = {
    ok: true,
    generatedAt: new Date().toISOString(),
    sourceRoot,
    totalRuns: runs.length,
    passedRuns: runs.filter((run) => run.overallPass).length,
    failedRuns: runs.filter((run) => !run.overallPass && run.status !== "ENV_FAIL").length,
    envFailedRuns: runs.filter((run) => run.status === "ENV_FAIL").length,
    passRate: rate(runs.filter((run) => run.overallPass).length, runs.length),
    answerCorrectRate: rate(runs.filter((run) => run.answerCorrect).length, runs.length),
    authoritativeEvidenceRate: rate(runs.filter((run) => run.authoritativeEvidenceValid).length, runs.length),
    runValidRate: rate(runs.filter((run) => run.runValid).length, runs.length),
    averageQuestionDurationMs: average(questionDurations),
    medianQuestionDurationMs: median(questionDurations),
    averageCandidateCount: average(candidateCounts),
    statusCounts,
    answerPolicyCounts,
    packetStatusCounts,
    laneUsageCounts,
    degradedLaneCounts,
    failureReasonCounts,
    runs: runs.map((run) => ({
      runId: run.runId,
      caseId: run.caseId,
      status: run.status,
      overallPass: run.overallPass,
      answerCorrect: run.answerCorrect,
      authoritativeEvidenceValid: run.authoritativeEvidenceValid,
      runValid: run.runValid,
      answerPolicy: run.answerPolicy,
      packetStatus: run.packetStatus,
      candidateCount: run.candidateCount,
      questionDurationMs: run.questionDurationMs,
      query: run.query,
      mode: run.mode,
      failureReasons: run.failureReasons
    }))
  };

  if (input.outFile) {
    writeJson(input.outFile, summary);
  }
  return summary;
}

function findRunDirs(sourceRoot: string): string[] {
  const verdictFiles = listFiles(sourceRoot).filter((file) => basename(file) === "verdict.json");
  return verdictFiles.map((file) => resolve(file, "..")).sort((left, right) => left.localeCompare(right));
}

function existsVerdict(runDir: string): boolean {
  try {
    readJson(join(runDir, "verdict.json"));
    return true;
  } catch {
    return false;
  }
}

function readOptionalJson<T>(path: string): T | undefined {
  try {
    return readJson<T>(path);
  } catch {
    return undefined;
  }
}

function countBy(values: string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) {
    result[value] = (result[value] ?? 0) + 1;
  }
  return result;
}

function average(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2));
}

function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Number(((sorted[mid - 1] + sorted[mid]) / 2).toFixed(2)) : sorted[mid];
}

function rate(numerator: number, denominator: number): number {
  if (denominator === 0) {
    return 0;
  }
  return Number(((numerator / denominator) * 100).toFixed(2));
}

async function main() {
  const args = parseArgs();
  const sourceRoot = String(args["source-root"] ?? join("realtest", "artifacts", "runs"));
  const outFile = args["out-file"] ? String(args["out-file"]) : join(sourceRoot, "summary.json");
  const summary = summarizeResults({ sourceRoot, outFile });
  console.log(JSON.stringify(summary, null, 2));
  if (summary.totalRuns === 0) {
    process.exitCode = 3;
  }
}

if (isMain(import.meta.url)) {
  await main();
}
