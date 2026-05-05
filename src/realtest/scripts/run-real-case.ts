import { join, resolve } from "node:path";
import { sendOne } from "./acp-send-one.js";
import { buildJudgeBundle } from "./build-judge-bundle.js";
import { collectOpenClawArtifacts } from "./collect-openclaw-artifacts.js";
import { mergeVerdict } from "./merge-verdict.js";
import { runPreflight } from "./preflight-openclaw.js";
import { runCodexJudge } from "./run-codex-judge.js";
import { waitOmsReady } from "./wait-oms-ready.js";
import { ensureDir, isMain, makeRunId, makeSessionKey, parseArgs, readJson, writeJson } from "../common.js";

interface CaseManifest {
  caseId: string;
  materialFiles: string[];
  formalQuestionFile: string;
  timeouts?: {
    sendTurnMs?: number;
    materialReadyMs?: number;
    questionTurnMs?: number;
  };
}

export async function runRealCase(input: {
  caseDir: string;
  runDir?: string;
  expectedDist?: string;
  agent: string;
  tokenFile?: string;
  url?: string;
}) {
  const caseDir = resolve(input.caseDir);
  const manifest = readJson<CaseManifest>(join(caseDir, "manifest.json"));
  const runId = input.runDir ? input.runDir.split(/[\\/]/u).at(-1) ?? makeRunId(manifest.caseId) : makeRunId(manifest.caseId);
  const runDir = resolve(input.runDir ?? join("realtest", "artifacts", "runs", runId));
  ensureDir(runDir);
  writeJson(join(runDir, "run-plan.json"), {
    runId,
    caseId: manifest.caseId,
    caseDir,
    agent: input.agent,
    expectedDist: input.expectedDist ?? "dist/index.js",
    senderBoundary: "one_prompt_per_acp_sender_invocation_transport_only",
    createdAt: new Date().toISOString()
  });

  const preflight = runPreflight({ caseDir, runDir, expectedDist: input.expectedDist });
  if (!preflight.ok) {
    await writeStoppedArtifacts({ caseDir, runDir, reason: "preflight_failed" });
    const verdict = mergeVerdict({ runDir });
    return { runDir, verdict };
  }

  for (const [index, materialFile] of manifest.materialFiles.entries()) {
    const sessionKey = makeSessionKey({ agent: input.agent, runId, caseId: manifest.caseId, suffix: "material" });
    await sendOne({
      caseFile: join(caseDir, materialFile),
      out: join(runDir, `send-material-${String(index + 1).padStart(3, "0")}.json`),
      sessionKey,
      timeoutMs: manifest.timeouts?.sendTurnMs ?? 600000,
      resetSession: index === 0,
      tokenFile: input.tokenFile,
      url: input.url
    });
  }

  const readiness = await waitOmsReady({ runDir, timeoutMs: manifest.timeouts?.materialReadyMs ?? 900000 });
  if (!readiness.ok) {
    await writeStoppedArtifacts({ caseDir, runDir, reason: "material_not_ready" });
    const verdict = mergeVerdict({ runDir });
    return { runDir, verdict };
  }

  await sendOne({
    caseFile: join(caseDir, manifest.formalQuestionFile),
    out: join(runDir, "send-question.json"),
    sessionKey: makeSessionKey({ agent: input.agent, runId, caseId: manifest.caseId, suffix: "question" }),
    timeoutMs: manifest.timeouts?.questionTurnMs ?? 600000,
    resetSession: true,
    tokenFile: input.tokenFile,
    url: input.url
  });

  await sleep(1500);
  collectOpenClawArtifacts({ runDir });
  const judgeInput = buildJudgeBundle({ caseDir, runDir });
  const bundleDir = String(judgeInput.bundleDir);
  runCodexJudge({ bundleDir });
  const verdict = mergeVerdict({ runDir, bundleDir });
  return { runDir, verdict };
}

async function writeStoppedArtifacts(input: { caseDir: string; runDir: string; reason: string }) {
  writeJson(join(input.runDir, "readiness.json"), {
    ok: false,
    status: "ENV_FAIL",
    runDir: input.runDir,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    materialArtifacts: [],
    failureReasons: [input.reason],
    notes: ["Protocol stop: sender was not invoked after failed preflight/readiness gate."]
  });
  collectOpenClawArtifacts({ runDir: input.runDir });
  const judgeInput = buildJudgeBundle({ caseDir: input.caseDir, runDir: input.runDir });
  runCodexJudge({ bundleDir: String(judgeInput.bundleDir) });
}

async function main() {
  const args = parseArgs();
  const result = await runRealCase({
    caseDir: String(args["case-dir"] ?? "realtest/cases/locomo_melanie_sunrise"),
    runDir: args["run-dir"] ? String(args["run-dir"]) : undefined,
    expectedDist: args["expected-dist"] ? String(args["expected-dist"]) : undefined,
    agent: String(args.agent ?? "main"),
    tokenFile: args["token-file"] ? String(args["token-file"]) : undefined,
    url: args.url ? String(args.url) : undefined
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.verdict.overallPass) {
    process.exitCode = result.verdict.status === "ENV_FAIL" ? 2 : 4;
  }
}

if (isMain(import.meta.url)) {
  await main();
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
