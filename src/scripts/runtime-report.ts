import { resolve } from "node:path";
import { runOpenClawRegistrationHarness } from "../adapter/OpenClawRegistrationHarness.js";

const loadedFromPath = resolve(process.cwd(), "dist", "index.js");
const harness = runOpenClawRegistrationHarness({
  source: loadedFromPath,
  pluginConfig: {
    agentId: process.env.OMS_AGENT_ID ?? "oms-runtime-report",
    dbPath: process.env.OMS_DB_PATH ?? ":memory:",
    memoryRepoPath: process.env.OMS_MEMORY_REPO ?? resolve(process.cwd(), ".omx", "runtime-memory"),
    debug: process.env.OMS_DEBUG === "1"
  }
});

console.log(
  JSON.stringify(
    {
      ok: harness.ok,
      source: harness.source,
      toolNames: harness.toolNames,
      contextEngineIds: harness.contextEngineIds,
      memoryCapabilityIds: harness.memoryCapabilityIds,
      errors: harness.errors,
      status: harness.bootstrapStatus
    },
    null,
    2
  )
);
