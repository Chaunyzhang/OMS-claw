import { join } from "node:path";
import { isMain, parseArgs, readJson, writeJson } from "../common.js";

export function mergeVerdict(input: { runDir: string; bundleDir?: string }) {
  const bundleDir = input.bundleDir ?? join(input.runDir, "judge-bundle");
  const preflight = readOptionalJson<{ ok?: boolean; status?: string; failureReasons?: string[] }>(join(input.runDir, "preflight.json"));
  const readiness = readOptionalJson<{ ok?: boolean; status?: string; failureReasons?: string[] }>(join(input.runDir, "readiness.json"));
  const collector = readOptionalJson<{ ok?: boolean; status?: string; failureReasons?: string[] }>(join(input.runDir, "collector-report.json"));
  const judge = readOptionalJson<{
    answer_correct?: boolean;
    required_module_used?: boolean;
    authoritative_evidence_valid?: boolean;
    run_valid?: boolean;
    overall_pass?: boolean;
    rationale?: string;
  }>(join(bundleDir, "judge-output.json"));

  const status = preflight?.ok === false ? "ENV_FAIL" : judge?.overall_pass === true ? "PASS" : "FAIL";
  const failureReasons = [
    ...(preflight?.failureReasons ?? []),
    ...(readiness?.failureReasons ?? []),
    ...(collector?.failureReasons ?? []),
    ...(judge?.overall_pass === false ? ["judge_overall_pass_false"] : [])
  ];
  const verdict = {
    status,
    overallPass: status === "PASS",
    answerCorrect: judge?.answer_correct === true,
    requiredModuleUsed: judge?.required_module_used === true,
    authoritativeEvidenceValid: judge?.authoritative_evidence_valid === true,
    runValid: judge?.run_valid === true,
    failureReasons: Array.from(new Set(failureReasons)),
    judgeRationale: judge?.rationale ?? null,
    runDir: input.runDir,
    bundleDir,
    verdictAt: new Date().toISOString()
  };
  writeJson(join(input.runDir, "verdict.json"), verdict);
  return verdict;
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
  const bundleDir = args["bundle-dir"] ? String(args["bundle-dir"]) : undefined;
  const verdict = mergeVerdict({ runDir, bundleDir });
  console.log(JSON.stringify(verdict, null, 2));
  if (!verdict.overallPass) {
    process.exitCode = verdict.status === "ENV_FAIL" ? 2 : 4;
  }
}

if (isMain(import.meta.url)) {
  await main();
}
