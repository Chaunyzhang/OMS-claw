import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isMain, makeRunId, parseArgs, readJson, writeJson } from "../common.js";
import { runRealCase } from "./run-real-case.js";
import { summarizeResults } from "./summarize-results.js";

interface CaseManifest {
  caseId: string;
}

export async function runBatch(input: {
  casesDir: string;
  runRoot?: string;
  expectedDist?: string;
  agent: string;
  tokenFile?: string;
  url?: string;
  onlyCaseIds?: string[];
}) {
  const casesDir = resolve(input.casesDir);
  const batchId = makeRunId("batch");
  const runRoot = resolve(input.runRoot ?? join("realtest", "artifacts", "batches", batchId));
  const caseDirs = await listCaseDirs(casesDir, input.onlyCaseIds);
  const startedAt = new Date().toISOString();
  const runs: Array<{ caseId: string; runDir: string; verdict: unknown }> = [];

  for (const [index, caseDir] of caseDirs.entries()) {
    const manifest = readJson<CaseManifest>(join(caseDir, "manifest.json"));
    const runDir = join(runRoot, `${String(index + 1).padStart(3, "0")}-${manifest.caseId}`);
    const result = await runRealCase({
      caseDir,
      runDir,
      expectedDist: input.expectedDist,
      agent: input.agent,
      tokenFile: input.tokenFile,
      url: input.url
    });
    runs.push({ caseId: manifest.caseId, runDir: result.runDir, verdict: result.verdict });
  }

  const summary = summarizeResults({ sourceRoot: runRoot, outFile: join(runRoot, "summary.json") });
  const output = {
    ok: true,
    startedAt,
    completedAt: new Date().toISOString(),
    batchId,
    casesDir,
    runRoot,
    totalCases: caseDirs.length,
    runs,
    summary
  };
  writeJson(join(runRoot, "batch-run.json"), output);
  return output;
}

async function listCaseDirs(casesDir: string, onlyCaseIds?: string[]): Promise<string[]> {
  const entries = await readdir(casesDir, { withFileTypes: true });
  const requested = new Set((onlyCaseIds ?? []).map((value) => value.trim()).filter(Boolean));
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(casesDir, entry.name))
    .filter((caseDir) => {
      const manifest = readJson<CaseManifest>(join(caseDir, "manifest.json"));
      return requested.size === 0 || requested.has(manifest.caseId);
    })
    .sort((left, right) => left.localeCompare(right));
}

async function main() {
  const args = parseArgs();
  const result = await runBatch({
    casesDir: String(args["cases-dir"] ?? join("realtest", "cases")),
    runRoot: args["run-root"] ? String(args["run-root"]) : undefined,
    expectedDist: args["expected-dist"] ? String(args["expected-dist"]) : undefined,
    agent: String(args.agent ?? "main"),
    tokenFile: args["token-file"] ? String(args["token-file"]) : undefined,
    url: args.url ? String(args.url) : undefined,
    onlyCaseIds: typeof args.only === "string" ? String(args.only).split(",") : undefined
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.summary || result.summary.totalRuns === 0) {
    process.exitCode = 3;
  } else if (result.summary.failedRuns > 0 || result.summary.envFailedRuns > 0) {
    process.exitCode = 4;
  }
}

if (isMain(import.meta.url)) {
  await main();
}
