import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { ensureDir, isMain, listFiles, parseArgs, readJson, sha256File, writeJson } from "../common.js";

interface CaseManifest {
  caseId: string;
  materialFiles: string[];
  formalQuestionFile: string;
  answerKey?: unknown;
  requiredModule?: string;
}

export function buildJudgeBundle(input: { caseDir: string; runDir: string; bundleDir?: string }) {
  const manifest = readJson<CaseManifest>(join(input.caseDir, "manifest.json"));
  const bundleDir = input.bundleDir ?? join(input.runDir, "judge-bundle");
  ensureDir(bundleDir);
  const caseBundleDir = join(bundleDir, "case");
  mkdirSync(caseBundleDir, { recursive: true });

  const caseFiles = ["manifest.json", ...manifest.materialFiles, manifest.formalQuestionFile, "answer-key.json"];
  const copiedCaseFiles = caseFiles
    .map((file) => ({ source: join(input.caseDir, file), target: join(caseBundleDir, file) }))
    .filter((item) => existsSync(item.source));
  for (const file of copiedCaseFiles) {
    copyFileSync(file.source, file.target);
  }
  copyIfExists(resolve("realtest", "judge", "codex-judge-prompt.md"), join(bundleDir, "codex-judge-prompt.md"));
  copyIfExists(resolve("realtest", "schemas", "judge-output.schema.json"), join(bundleDir, "judge-output.schema.json"));

  const collector = existsSync(join(input.runDir, "collector-report.json"))
    ? readJson<{ transcriptFile?: string | null; finalAnswerFile?: string | null; runtimeReportFile?: string | null }>(
        join(input.runDir, "collector-report.json")
      )
    : {};

  const runArtifacts = [
    "preflight.json",
    "readiness.json",
    "collector-report.json",
    "runtime-report.json",
    "query-trace.json",
    "final-answer.txt",
    "final-answer.meta.json"
  ]
    .map((file) => join(input.runDir, file))
    .filter((file) => existsSync(file));
  const senderArtifacts = listFiles(input.runDir).filter((file) => /^send-(material-\d+|question)\.json$/u.test(basename(file)));
  const copiedRunFiles = [...runArtifacts, ...senderArtifacts].map((source) => {
    const target = join(bundleDir, basename(source));
    copyFileSync(source, target);
    return { source, target, hash: sha256File(source) };
  });

  const transcriptFile = collector.transcriptFile && existsSync(collector.transcriptFile) ? collector.transcriptFile : null;
  const frozenTranscriptFile = transcriptFile ? join(bundleDir, "openclaw-transcript.jsonl") : null;
  if (transcriptFile && frozenTranscriptFile) {
    copyFileSync(transcriptFile, frozenTranscriptFile);
  }
  const finalAnswerSource =
    collector.finalAnswerFile && existsSync(collector.finalAnswerFile)
      ? collector.finalAnswerFile
      : existsSync(join(input.runDir, "final-answer.txt"))
        ? join(input.runDir, "final-answer.txt")
        : null;
  const frozenFinalAnswerFile = finalAnswerSource ? join(bundleDir, "final-answer.txt") : null;
  if (finalAnswerSource && frozenFinalAnswerFile) {
    copyFileSync(finalAnswerSource, frozenFinalAnswerFile);
  }

  const judgeInput = {
    caseId: manifest.caseId,
    requiredModule: manifest.requiredModule,
    answerKey: manifest.answerKey ?? readOptionalJson(join(input.caseDir, "answer-key.json")),
    runDir: input.runDir,
    bundleDir,
    transcriptFile: frozenTranscriptFile,
    finalAnswerFile: frozenFinalAnswerFile,
    runtimeReportFiles: copiedRunFiles.filter((file) => /runtime-report|collector-report|preflight|readiness|query-trace/u.test(basename(file.target))),
    senderArtifacts: copiedRunFiles.filter((file) => /^send-/u.test(basename(file.target))),
    caseFiles: copiedCaseFiles.map((file) => ({ file: file.target, hash: sha256File(file.target) })),
    bundleCreatedAt: new Date().toISOString(),
    judgeBoundary: "frozen_bundle_only_no_openclaw_no_live_oms_search"
  };
  writeJson(join(bundleDir, "judge-input.json"), judgeInput);
  return judgeInput;
}

function copyIfExists(source: string, target: string): void {
  if (existsSync(source)) {
    copyFileSync(source, target);
  }
}

function readOptionalJson(path: string): unknown {
  try {
    return readJson(path);
  } catch {
    return undefined;
  }
}

async function main() {
  const args = parseArgs();
  const caseDir = String(args["case-dir"] ?? "realtest/cases/locomo_melanie_sunrise");
  const runDir = String(args["run-dir"] ?? "realtest/artifacts/runs/manual-preflight");
  const bundleDir = args["bundle-dir"] ? String(args["bundle-dir"]) : undefined;
  const result = buildJudgeBundle({ caseDir, runDir, bundleDir });
  console.log(JSON.stringify(result, null, 2));
}

if (isMain(import.meta.url)) {
  await main();
}
