import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { ensureDir, hashDirectory, isMain, parseArgs, readJson, runCommand, sha256File, sha256Text, writeJson } from "../common.js";

interface Check {
  name: string;
  ok: boolean;
  detail?: unknown;
}

interface InspectedPlugin {
  id?: string;
  source?: string;
  status?: string;
  version?: string;
}

function parsePluginInspect(output: string): InspectedPlugin {
  const source = output.match(/^Source:\s*(.+)$/mu)?.[1]?.trim();
  const status = output.match(/^Status:\s*(.+)$/mu)?.[1]?.trim();
  const version = output.match(/^Version:\s*(.+)$/mu)?.[1]?.trim();
  const id = output.match(/^id:\s*(.+)$/mu)?.[1]?.trim();
  return { id, source, status, version };
}

function normalizePath(value?: string): string | undefined {
  return value ? resolve(value).toLowerCase() : undefined;
}

export function runPreflight(input: { caseDir: string; runDir: string; expectedDist?: string }) {
  const startedAt = new Date().toISOString();
  ensureDir(input.runDir);
  const manifestPath = join(input.caseDir, "manifest.json");
  const manifest = readJson<{ caseId: string; materialFiles: string[]; formalQuestionFile: string }>(manifestPath);
  const expectedDist = resolve(input.expectedDist ?? "dist/index.js");
  const buildInfoPath = resolve("dist/build-info.json");
  const buildInfo = existsSync(buildInfoPath) ? readJson(buildInfoPath) : undefined;
  const expectedDistHash = existsSync("dist") ? hashDirectory(resolve("dist")) : null;
  const caseFiles = [manifestPath, ...manifest.materialFiles.map((file) => join(input.caseDir, file)), join(input.caseDir, manifest.formalQuestionFile)];
  const casePackHash = sha256Text(caseFiles.map((file) => `${file.replace(/\\/gu, "/")}\t${sha256File(file)}`).join("\n"));

  const checks: Check[] = [];
  const openclawVersion = runCommand("openclaw", ["--version"], { timeoutMs: 30000 });
  checks.push({ name: "openclaw_cli_available", ok: openclawVersion.exitCode === 0, detail: openclawVersion });

  const acpHelp = runCommand("openclaw", ["acp", "--help"], { timeoutMs: 60000 });
  checks.push({ name: "openclaw_acp_available", ok: acpHelp.exitCode === 0, detail: { exitCode: acpHelp.exitCode, stderr: acpHelp.stderr } });

  const contextSlot = runCommand("openclaw", ["config", "get", "plugins.slots.contextEngine"], { timeoutMs: 60000 });
  checks.push({ name: "context_engine_slot_is_oms", ok: contextSlot.exitCode === 0 && contextSlot.stdout.trim() === "oms", detail: contextSlot.stdout.trim() });

  const entry = runCommand("openclaw", ["config", "get", "plugins.entries.oms"], { timeoutMs: 60000 });
  const entryConfig = entry.exitCode === 0 ? safeJson(entry.stdout) : undefined;
  checks.push({ name: "oms_plugin_enabled_in_config", ok: entry.exitCode === 0 && (entryConfig as { enabled?: boolean } | undefined)?.enabled === true, detail: entryConfig ?? entry.stderr });

  const inspect = runCommand("openclaw", ["plugins", "inspect", "oms"], { timeoutMs: 90000 });
  const inspected: InspectedPlugin = inspect.exitCode === 0 ? parsePluginInspect(inspect.stdout) : {};
  checks.push({ name: "oms_plugin_loaded", ok: inspect.exitCode === 0 && inspected.status === "loaded", detail: inspected });
  checks.push({
    name: "loaded_oms_source_matches_target_dist",
    ok: normalizePath(inspected.source) === normalizePath(expectedDist),
    detail: { expectedDist, loadedSource: inspected.source }
  });

  checks.push({
    name: "target_build_info_exists",
    ok: buildInfo !== undefined,
    detail: buildInfo ?? "dist/build-info.json missing"
  });
  checks.push({
    name: "target_build_attestation_complete",
    ok:
      typeof buildInfo?.commitSha === "string" &&
      buildInfo.commitSha.length >= 7 &&
      typeof buildInfo?.schemaVersion === "string" &&
      typeof buildInfo?.toolSchemaHash === "string" &&
      buildInfo.contextEngineId === "oms",
    detail: buildInfo
  });

  const tokenMode = {
    tokenFileFromEnv: process.env.OPENCLAW_TOKEN_FILE,
    tokenProvidedInEnv: process.env.OPENCLAW_TOKEN ? "present" : "absent",
    note: "No command-line token is used by this harness; token-file is passed only if configured at send time."
  };
  checks.push({ name: "gateway_token_not_on_command_line", ok: true, detail: tokenMode });

  checks.push({
    name: "case_pack_hash_recorded",
    ok: true,
    detail: { casePackHash, files: caseFiles }
  });

  const failed = checks.filter((check) => !check.ok);
  const preflight = {
    runId: input.runDir.split(/[\\/]/u).pop(),
    caseId: manifest.caseId,
    status: failed.length === 0 ? "PASS" : "ENV_FAIL",
    ok: failed.length === 0,
    startedAt,
    completedAt: new Date().toISOString(),
    expected: {
      pluginId: "oms",
      expectedDist,
      expectedCommitSha: buildInfo?.commitSha ?? null,
      expectedDistHash,
      schemaVersion: buildInfo?.schemaVersion ?? null,
      toolSchemaHash: buildInfo?.toolSchemaHash ?? null
    },
    environment: {
      nodeVersion: process.version,
      openclawVersion: openclawVersion.stdout.trim(),
      configEntryOms: entryConfig,
      inspectedOms: inspected
    },
    casePackHash,
    checks,
    failureReasons: failed.map((check) => check.name)
  };
  writeJson(join(input.runDir, "preflight.json"), preflight);
  return preflight;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text.trim();
  }
}

async function main() {
  const args = parseArgs();
  const caseDir = String(args["case-dir"] ?? "realtest/cases/locomo_melanie_sunrise");
  const runDir = String(args["run-dir"] ?? "realtest/artifacts/runs/manual-preflight");
  const expectedDist = args["expected-dist"] ? String(args["expected-dist"]) : undefined;
  const result = runPreflight({ caseDir, runDir, expectedDist });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    process.exitCode = 2;
  }
}

if (isMain(import.meta.url)) {
  await main();
}
