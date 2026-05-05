import { resolve } from "node:path";
import { OmsOrchestrator } from "../core/OmsOrchestrator.js";
import { runOpenClawRegistrationHarness } from "../adapter/OpenClawRegistrationHarness.js";

const [role = "user", text = ""] = process.argv.slice(2);
if (role !== "user" && role !== "assistant") {
  console.error("Usage: openclaw-send-one <user|assistant> <text>");
  process.exit(2);
}

const loadedFromPath = resolve(process.cwd(), "dist", "index.js");
const harness = runOpenClawRegistrationHarness({
  source: loadedFromPath,
  pluginConfig: {
    agentId: process.env.OMS_AGENT_ID ?? "oms-send-one",
    dbPath: process.env.OMS_DB_PATH ?? resolve(process.cwd(), ".omx", "send-one.sqlite"),
    memoryRepoPath: process.env.OMS_MEMORY_REPO ?? resolve(process.cwd(), ".omx", "send-one-memory"),
    debug: process.env.OMS_DEBUG === "1"
  }
});
if (!harness.ok) {
  console.error(JSON.stringify({ ok: false, registrationHarness: harness }, null, 2));
  process.exit(1);
}
const orchestrator = harness.orchestrator as OmsOrchestrator;
const result = orchestrator.ingest({
  sessionId: process.env.OMS_SESSION_ID ?? "manual-session",
  turnId: process.env.OMS_TURN_ID ?? "manual-turn-1",
  turnIndex: Number(process.env.OMS_TURN_INDEX ?? 1),
  role,
  text
});
console.log(JSON.stringify({ result, status: orchestrator.status() }, null, 2));
orchestrator.connection.close();
