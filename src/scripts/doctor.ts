import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { RuntimeAttestation } from "../core/RuntimeAttestation.js";
import { runOpenClawRegistrationHarness } from "../adapter/OpenClawRegistrationHarness.js";

const root = process.cwd();
const loadedFromPath = resolve(root, "dist", "index.js");
const harness = runOpenClawRegistrationHarness({
  source: loadedFromPath,
  pluginConfig: {
    agentId: "oms-doctor",
    dbPath: ":memory:",
    memoryRepoPath: resolve(root, ".omx", "doctor-memory")
  }
});
const attestation = new RuntimeAttestation(loadedFromPath);
const buildInfoPath = resolve(root, "dist", "build-info.json");
const buildInfoExists = existsSync(buildInfoPath);
const buildInfo = buildInfoExists ? JSON.parse(readFileSync(buildInfoPath, "utf8")) : null;
const verification = attestation.verifyDistBuildInfo(root);
const status = harness.bootstrapStatus as { build?: { loadedFromPath?: string }; openclaw?: Record<string, boolean> } | undefined;
const loadedPathObserved = status?.build?.loadedFromPath === loadedFromPath;
const registeredObserved =
  status?.openclaw?.contextEngineRegistered === true &&
  status.openclaw.memorySlotRegistered === true &&
  status.openclaw.toolsRegistered === true;

const report = {
  ok: buildInfoExists && verification.ok && harness.ok && loadedPathObserved && registeredObserved,
  buildInfoExists,
  buildInfo,
  verification,
  registrationHarness: {
    ok: harness.ok,
    source: harness.source,
    toolNames: harness.toolNames,
    contextEngineIds: harness.contextEngineIds,
    memoryCapabilityIds: harness.memoryCapabilityIds,
    errors: harness.errors,
    loadedPathObserved,
    registeredObserved
  },
  status
};

console.log(JSON.stringify(report, null, 2));
if (!report.ok) {
  process.exitCode = 1;
}
