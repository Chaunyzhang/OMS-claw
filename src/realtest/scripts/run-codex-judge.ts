import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isMain, parseArgs, readJson, runCommand, writeJson } from "../common.js";

interface JudgeInput {
  caseId: string;
  requiredModule?: string;
  answerKey?: {
    expected?: string;
    acceptable?: string[];
    forbidden?: string[];
  };
  transcriptFile?: string | null;
  finalAnswerFile?: string | null;
  runtimeReportFiles?: Array<{ target?: string; file?: string }>;
}

interface JudgeOutput {
  run_valid: boolean;
  answer_correct: boolean;
  required_module_used: boolean;
  authoritative_evidence_valid: boolean;
  contamination_detected: boolean;
  overall_pass: boolean;
  status: string;
  final_answer: string;
  expected_answer: string;
  matched_answer_variant: string | null;
  required_module: string | null;
  used_module: string | null;
  evidence_packet_id: string | null;
  raw_excerpt_hash: string | null;
  selected_authoritative_raw_count: number;
  summary_derived_raw_count: number;
  rationale: string;
  evidence_refs: string[];
  failure_reasons: string[];
}

export function runCodexJudge(input: { bundleDir: string }): JudgeOutput {
  const judgeInput = readJson<JudgeInput>(join(input.bundleDir, "judge-input.json"));
  if (process.env.OMS_REALTEST_INTERNAL_JUDGE !== "1") {
    const external = runExternalCodexJudge(input.bundleDir);
    if (external && externalOutputIsConsistent(input.bundleDir, judgeInput, external)) {
      return external;
    }
  }
  const output = buildInternalJudgeOutput(input.bundleDir, judgeInput, "internal_fallback_after_codex_cli_unavailable_or_invalid");
  writeJson(join(input.bundleDir, "judge-output.json"), output);
  return output;
}

function runExternalCodexJudge(bundleDir: string): JudgeOutput | null {
  const promptPath = join(bundleDir, "codex-judge-prompt.md");
  const schemaPath = join(bundleDir, "judge-output.schema.json");
  if (!existsSync(promptPath) || !existsSync(schemaPath)) {
    return null;
  }
  const outputPath = join(bundleDir, "judge-output.json");
  const frozenContext = ["judge-input.json", "preflight.json", "readiness.json", "collector-report.json"]
    .map((file) => {
      const path = join(bundleDir, file);
      return existsSync(path) ? `\n\n--- ${file} ---\n${readFileSync(path, "utf8")}` : "";
    })
    .join("");
  const prompt = `${readFileSync(promptPath, "utf8")}

Frozen bundle directory: ${bundleDir}

Use only files from this frozen bundle. Do not ask for more input. If the run stopped at preflight ENV_FAIL, judge it as ENV_FAIL.

For convenience, here are exact read-only copies of the key frozen bundle files:${frozenContext}

Return JSON only.`;
  const result = runCommand(
    "codex",
    [
      "exec",
      "--cd",
      bundleDir,
      "--sandbox",
      "read-only",
      "--ephemeral",
      "--ignore-rules",
      "--ignore-user-config",
      "--output-schema",
      schemaPath,
      "--output-last-message",
      outputPath
    ],
    { timeoutMs: 600000, input: prompt }
  );
  writeJson(join(bundleDir, "judge-run.json"), {
    mode: "codex_cli",
    command: result.command,
    exitCode: result.exitCode,
    stdoutPreview: result.stdout.slice(0, 4000),
    stderrPreview: result.stderr.slice(0, 4000),
    durationMs: result.durationMs,
    error: result.error
  });
  if (result.exitCode !== 0 || !existsSync(outputPath)) {
    return null;
  }
  try {
    return readJson<JudgeOutput>(outputPath);
  } catch {
    return null;
  }
}

function externalOutputIsConsistent(bundleDir: string, judgeInput: JudgeInput, output: JudgeOutput): boolean {
  const finalAnswerExists = Boolean(judgeInput.finalAnswerFile && existsSync(judgeInput.finalAnswerFile));
  const transcriptExists = Boolean(judgeInput.transcriptFile && existsSync(judgeInput.transcriptFile));
  const preflight = readOptionalJson<{ ok?: boolean }>(join(bundleDir, "preflight.json"));
  const collector = readOptionalJson<{ ok?: boolean }>(join(bundleDir, "collector-report.json"));
  if (finalAnswerExists && output.final_answer.trim().length === 0) {
    return false;
  }
  if (preflight?.ok === true && collector?.ok === true && transcriptExists && output.run_valid === false) {
    return false;
  }
  if (/not included|not available|missing/iu.test(output.rationale) && finalAnswerExists && runtimeTexts(judgeInput).length > 0) {
    return false;
  }
  return true;
}

function buildInternalJudgeOutput(bundleDir: string, judgeInput: JudgeInput, judgeMode: string): JudgeOutput {
  const preflight = readOptionalJson<{ ok?: boolean; failureReasons?: string[] }>(join(bundleDir, "preflight.json"));
  const collector = readOptionalJson<{ ok?: boolean; failureReasons?: string[] }>(join(bundleDir, "collector-report.json"));
  const finalAnswer = readFinalAnswer(judgeInput);
  const answerCorrect = finalAnswer ? matchesAnswer(finalAnswer, judgeInput.answerKey) : false;
  const requiredModuleUsed = requiredModuleObserved(judgeInput);
  const authoritativeEvidenceValid = authoritativeEvidenceObserved(judgeInput);
  const runValid = preflight?.ok === true && collector?.ok === true && Boolean(judgeInput.transcriptFile);
  const failureReasons = [
    ...(preflight?.ok === false ? preflight.failureReasons ?? ["preflight_failed"] : []),
    ...(collector?.ok === false ? collector.failureReasons ?? ["collector_failed"] : [])
  ];
  const status =
    preflight?.ok === false
      ? "ENV_FAIL"
      : !runValid
        ? "INVALID_RUN"
        : !answerCorrect
          ? "ANSWER_FAIL"
          : !requiredModuleUsed
            ? "MODULE_FAIL"
            : !authoritativeEvidenceValid
              ? "EVIDENCE_FAIL"
              : "PASS";
  return {
    run_valid: runValid,
    answer_correct: answerCorrect,
    required_module_used: requiredModuleUsed,
    authoritative_evidence_valid: authoritativeEvidenceValid,
    contamination_detected: false,
    overall_pass: answerCorrect && requiredModuleUsed && authoritativeEvidenceValid && runValid,
    status,
    final_answer: finalAnswer ?? "",
    expected_answer: judgeInput.answerKey?.expected ?? "",
    matched_answer_variant: answerCorrect ? judgeInput.answerKey?.expected ?? null : null,
    required_module: judgeInput.requiredModule ?? null,
    used_module: requiredModuleUsed ? judgeInput.requiredModule ?? null : null,
    evidence_packet_id: null,
    raw_excerpt_hash: null,
    selected_authoritative_raw_count: 0,
    summary_derived_raw_count: 0,
    rationale:
      preflight?.ok === false
        ? `preflight ENV_FAIL: ${(preflight.failureReasons ?? []).join(", ")}`
        : collector?.ok === false
          ? `collector gaps: ${(collector.failureReasons ?? []).join(", ")}`
          : `judged from frozen bundle artifacts via ${judgeMode}`,
    evidence_refs: buildEvidenceRefs(judgeInput),
    failure_reasons: Array.from(new Set(failureReasons))
  };
}

function readFinalAnswer(input: JudgeInput): string | null {
  if (input.finalAnswerFile && existsSync(input.finalAnswerFile)) {
    const parsed = readOptionalJson<{ text?: string }>(input.finalAnswerFile);
    if (parsed?.text) {
      return parsed.text;
    }
    return readFileSync(input.finalAnswerFile, "utf8");
  }
  if (input.transcriptFile && existsSync(input.transcriptFile)) {
    return readFileSync(input.transcriptFile, "utf8");
  }
  return null;
}

function matchesAnswer(finalAnswer: string, answerKey: JudgeInput["answerKey"]): boolean {
  const normalized = normalizeAnswerText(finalAnswer);
  const acceptable = [answerKey?.expected, ...(answerKey?.acceptable ?? [])].filter((item): item is string => Boolean(item));
  const hasAcceptable = acceptable.some((candidate) => normalized.includes(normalizeAnswerText(candidate)));
  if (!hasAcceptable) {
    return false;
  }
  for (const forbidden of answerKey?.forbidden ?? []) {
    const normalizedForbidden = normalizeAnswerText(forbidden);
    if (normalizedForbidden && normalized.includes(normalizedForbidden)) {
      return false;
    }
  }
  return true;
}

function normalizeAnswerText(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

function requiredModuleObserved(input: JudgeInput): boolean {
  const required = input.requiredModule;
  if (!required) {
    return false;
  }
  if (required === "summary_dag_expand_evidence") {
    return runtimeEvidencePackets(input).some((packet) => packetIsDeliveredSummaryDerived(packet));
  }
  return runtimeTexts(input).some((text) => text.includes(required) || /summary.*evidence|expand.*evidence/isu.test(text));
}

function authoritativeEvidenceObserved(input: JudgeInput): boolean {
  if (runtimeEvidencePackets(input).some((packet) => packetIsAuthoritative(packet))) {
    return true;
  }
  return runtimeTexts(input).some(
    (text) =>
      /original_user_supplied_material/iu.test(text) &&
      /material_corpus/iu.test(text) &&
      /deliveredToOpenClaw"?\s*:\s*true/iu.test(text) &&
      /rawExcerptHash|raw_excerpt_hash/iu.test(text)
  );
}

function runtimeEvidencePackets(input: JudgeInput): Array<Record<string, unknown>> {
  const packets: Array<Record<string, unknown>> = [];
  for (const text of runtimeTexts(input)) {
    const parsed = parseJson<Record<string, unknown>>(text);
    const dbReport = asRecord(parsed?.dbReport);
    const candidates = [parsed?.recentEvidencePackets, dbReport?.recentEvidencePackets].filter(Array.isArray) as unknown[][];
    for (const list of candidates) {
      packets.push(...list.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null));
    }
  }
  return packets;
}

function packetIsDeliveredSummaryDerived(packet: Record<string, unknown>): boolean {
  if (String(packet.status) !== "delivered") {
    return false;
  }
  const summaryDerivedRawCount = Number(packet.summary_derived_raw_count ?? packet.summaryDerivedRawCount ?? 0);
  const sourceSummaryIds = parseJson<unknown[]>(String(packet.source_summary_ids_json ?? "[]")) ?? [];
  return summaryDerivedRawCount > 0 || sourceSummaryIds.length > 0;
}

function packetIsAuthoritative(packet: Record<string, unknown>): boolean {
  if (!packetIsDeliveredSummaryDerived(packet)) {
    return false;
  }
  const selectedCount = Number(packet.selected_authoritative_raw_count ?? packet.selectedAuthoritativeRawCount ?? 0);
  const authorityReport = asRecord(parseJson(String(packet.authority_report_json ?? "{}")) ?? packet.authorityReport);
  const deliveryReport = asRecord(parseJson(String(packet.delivery_report_json ?? "{}")) ?? packet.deliveryReceipt);
  const rawPreviewText = String(packet.raw_excerpt_preview_json ?? JSON.stringify(packet.rawExcerpts ?? []));
  return (
    selectedCount > 0 &&
    authorityReport?.ok === true &&
    /material_corpus/iu.test(rawPreviewText) &&
    /original_user_supplied_material/iu.test(rawPreviewText) &&
    /deliveredToOpenClaw"?\s*:\s*true/iu.test(JSON.stringify(deliveryReport))
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function parseJson<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

function runtimeTexts(input: JudgeInput): string[] {
  return (input.runtimeReportFiles ?? [])
    .map((file) => file.target ?? file.file)
    .filter((file): file is string => typeof file === "string" && existsSync(file))
    .map((file) => readFileSync(file, "utf8"));
}

function buildEvidenceRefs(input: JudgeInput): string[] {
  return (input.runtimeReportFiles ?? [])
    .map((file) => file.target ?? file.file)
    .filter((file): file is string => typeof file === "string");
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
  const bundleDir = String(args["bundle-dir"] ?? "realtest/artifacts/runs/manual-preflight/judge-bundle");
  const output = runCodexJudge({ bundleDir });
  console.log(JSON.stringify(output, null, 2));
  if (!output.overall_pass) {
    process.exitCode = 4;
  }
}

if (isMain(import.meta.url)) {
  await main();
}
