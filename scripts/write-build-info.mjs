import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const snapshotPath = resolve(root, "src/generated/build-info.snapshot.json");
const toolNames = [
  "oms_status",
  "oms_search",
  "oms_retrieve",
  "oms_timeline",
  "oms_summary_search",
  "oms_expand_evidence",
  "oms_fts_search",
  "oms_trace",
  "oms_debug_lanes",
  "oms_why",
  "oms_git_export",
  "oms_debug_raw"
];

function gitSha() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "no-git";
  }
}

const toolSchemaHash = `sha256:${createHash("sha256")
  .update(JSON.stringify(toolNames))
  .digest("hex")}`;

const generatedInfo = {
  packageVersion: packageJson.version,
  commitSha: gitSha(),
  buildTimestamp: new Date().toISOString(),
  schemaVersion: "v1",
  toolSchemaHash,
  contextEngineId: "oms",
  loadedFromPath: "dist/index.js"
};

const info =
  process.argv.includes("--json") && readSnapshot()
    ? readSnapshot()
    : generatedInfo;

function readSnapshot() {
  try {
    return JSON.parse(readFileSync(snapshotPath, "utf8"));
  } catch {
    return undefined;
  }
}

const tsPath = resolve(root, "src/generated/build-info.ts");
mkdirSync(dirname(tsPath), { recursive: true });
if (!process.argv.includes("--json")) {
  writeFileSync(snapshotPath, `${JSON.stringify(info, null, 2)}\n`, "utf8");
  writeFileSync(
    tsPath,
    `import type { BuildInfo } from "../types.js";\n\nexport const buildInfo: BuildInfo = ${JSON.stringify(info, null, 2)};\n`,
    "utf8"
  );
}

if (process.argv.includes("--json")) {
  const jsonPath = resolve(root, "dist/build-info.json");
  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, `${JSON.stringify(info, null, 2)}\n`, "utf8");
}
