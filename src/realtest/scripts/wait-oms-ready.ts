import { basename, join } from "node:path";
import { isMain, listFiles, parseArgs, readJson, writeJson } from "../common.js";

interface ReadinessReport {
  ok: boolean;
  status: "PASS" | "ENV_FAIL" | "TIMEOUT" | "NOT_READY";
  runDir: string;
  startedAt: string;
  completedAt: string;
  materialArtifacts: Array<{ file: string; ok: boolean | null }>;
  failureReasons: string[];
  notes: string[];
}

interface PreflightReport {
  ok?: boolean;
  status?: string;
  failureReasons?: string[];
}

export async function waitOmsReady(input: { runDir: string; timeoutMs: number }): Promise<ReadinessReport> {
  const startedAt = new Date().toISOString();
  const preflightPath = join(input.runDir, "preflight.json");
  const preflight = readOptionalJson<PreflightReport>(preflightPath);
  const materialArtifacts = listFiles(input.runDir)
    .filter((file) => /^send-material-\d+\.json$/u.test(basename(file)))
    .map((file) => {
      const artifact = readOptionalJson<{ ok?: boolean }>(file);
      return { file, ok: typeof artifact?.ok === "boolean" ? artifact.ok : null };
    });

  if (preflight && preflight.ok !== true) {
    const report: ReadinessReport = {
      ok: false,
      status: "ENV_FAIL",
      runDir: input.runDir,
      startedAt,
      completedAt: new Date().toISOString(),
      materialArtifacts,
      failureReasons: preflight.failureReasons ?? ["preflight_failed"],
      notes: ["Preflight failed; material ingestion readiness was not probed and no sender step should run."]
    };
    writeJson(join(input.runDir, "readiness.json"), report);
    return report;
  }

  const deadline = Date.now() + input.timeoutMs;
  let lastArtifacts = materialArtifacts;
  while (Date.now() <= deadline) {
    lastArtifacts = listFiles(input.runDir)
      .filter((file) => /^send-material-\d+\.json$/u.test(basename(file)))
      .map((file) => {
        const artifact = readOptionalJson<{ ok?: boolean }>(file);
        return { file, ok: typeof artifact?.ok === "boolean" ? artifact.ok : null };
      });
    if (lastArtifacts.length > 0 && lastArtifacts.every((artifact) => artifact.ok === true)) {
      const report: ReadinessReport = {
        ok: true,
        status: "PASS",
        runDir: input.runDir,
        startedAt,
        completedAt: new Date().toISOString(),
        materialArtifacts: lastArtifacts,
        failureReasons: [],
        notes: ["All material sender artifacts completed successfully. Deep OMS DB/log inspection is performed by collect-openclaw-artifacts."]
      };
      writeJson(join(input.runDir, "readiness.json"), report);
      return report;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  const report: ReadinessReport = {
    ok: false,
    status: lastArtifacts.length === 0 ? "NOT_READY" : "TIMEOUT",
    runDir: input.runDir,
    startedAt,
    completedAt: new Date().toISOString(),
    materialArtifacts: lastArtifacts,
    failureReasons: lastArtifacts.length === 0 ? ["material_artifacts_missing"] : ["material_readiness_timeout"],
    notes: ["Timed out before all material sender artifacts reported ok=true."]
  };
  writeJson(join(input.runDir, "readiness.json"), report);
  return report;
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
  const timeoutMs = Number(args["timeout-ms"] ?? 900000);
  const report = await waitOmsReady({ runDir, timeoutMs });
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) {
    process.exitCode = report.status === "ENV_FAIL" ? 2 : 3;
  }
}

if (isMain(import.meta.url)) {
  await main();
}
