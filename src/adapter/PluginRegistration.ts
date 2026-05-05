import { ConfigResolver } from "../core/ConfigResolver.js";
import { Logger } from "../core/Logger.js";
import { OmsOrchestrator } from "../core/OmsOrchestrator.js";
import { controlPanelContract } from "../ui/ControlPanelContract.js";
import { asToolResponse, jsonSchema } from "./OpenClawDiplomat.js";
import type { OpenClawPluginApi, OpenClawToolDefinition } from "./OpenClawTypes.js";

function tool(name: string, description: string, parameters: Record<string, unknown>, execute: OpenClawToolDefinition["execute"]): OpenClawToolDefinition {
  return { name, description, parameters, execute };
}

function registerTools(api: OpenClawPluginApi, orchestrator: OmsOrchestrator): void {
  const tools: OpenClawToolDefinition[] = [
    tool("oms_status", "Return OMS runtime attestation, registration state, counts, and health.", jsonSchema({}), () =>
      asToolResponse(orchestrator.status())
    ),
    tool(
      "oms_timeline",
      "Return recent raw visible user/assistant timeline records.",
      jsonSchema({ limit: { type: "number", default: 100 } }),
      (_id, params) => asToolResponse(orchestrator.timeline(Number(params.limit ?? 100)))
    ),
    tool(
      "oms_summary_search",
      "Search summary DAG navigation hits. Returned summaries are not evidence and must be expanded.",
      jsonSchema({ query: { type: "string" }, limit: { type: "number", default: 10 } }, ["query"]),
      (_id, params) => asToolResponse(orchestrator.summarySearchTool(params))
    ),
    tool(
      "oms_expand_evidence",
      "Expand a summary/raw/query candidate into an authoritative raw evidence packet.",
      jsonSchema({
        summaryId: { type: "string" },
        rawMessageId: { type: "string" },
        query: { type: "string" },
        mode: { type: "string", enum: ["low", "medium", "high", "xhigh"] },
        evidencePolicy: {
          type: "string",
          enum: ["general_history", "assistant_history", "material_evidence", "diagnostic_history"]
        },
        caseId: { type: "string" },
        windowTurns: { type: "number" },
        maxRawMessages: { type: "number" },
        sessionId: { type: "string" }
      }),
      (_id, params) => asToolResponse(orchestrator.expandEvidenceTool(params))
    ),
    tool(
      "oms_fts_search",
      "Search raw normalized text through SQLite FTS5 while honoring evidence policy.",
      jsonSchema({
        query: { type: "string" },
        evidencePolicy: {
          type: "string",
          enum: ["general_history", "assistant_history", "material_evidence", "diagnostic_history"]
        },
        caseId: { type: "string" },
        limit: { type: "number" }
      }, ["query"]),
      (_id, params) => asToolResponse(orchestrator.ftsSearchTool(params))
    ),
    tool(
      "oms_trace",
      "Trace query/run/summary/source-edge/raw/evidence delivery lineage.",
      jsonSchema({ summaryId: { type: "string" }, packetId: { type: "string" }, messageId: { type: "string" } }),
      (_id, params) => asToolResponse(orchestrator.traceTool(params))
    ),
    tool(
      "oms_why",
      "Explain why a query matched or failed, including blocked reasons and enabled modules.",
      jsonSchema({ query: { type: "string" }, mode: { type: "string" }, caseId: { type: "string" } }, ["query"]),
      (_id, params) => asToolResponse(orchestrator.whyTool(params))
    ),
    tool(
      "oms_git_export",
      "Export redacted raw timeline Markdown to the configured memory repo.",
      jsonSchema({ limit: { type: "number" }, force: { type: "boolean" } }),
      (_id, params) => asToolResponse(orchestrator.gitExportTool(params))
    )
  ];

  if (orchestrator.config.debug) {
    tools.push(
      tool(
        "oms_debug_raw",
        "Debug-only raw table inspection. Never use for normal answer paths.",
        jsonSchema({ limit: { type: "number", default: 100 } }),
        (_id, params) => asToolResponse(orchestrator.debugRawTool(params))
      )
    );
  }

  for (const definition of tools) {
    api.registerTool?.(definition);
  }
  orchestrator.markRegistered({ toolsRegistered: true });
}

const entry = {
  id: "oms",
  name: "OMS OpenClaw Memory",
  description: "Long-term raw transcript memory. Summary is navigation; raw is truth.",
  register(api: OpenClawPluginApi) {
    const logger = new Logger(api.logger);
    const config = ConfigResolver.resolve(api.pluginConfig ?? {});
    const orchestrator = new OmsOrchestrator(config, { loadedFromPath: api.source ?? "dist/index.js", logger });

    if (api.registerContextEngine) {
      api.registerContextEngine("oms", () => orchestrator.createContextEngine());
      orchestrator.markRegistered({ contextEngineRegistered: true, activeContextEngineId: "oms" });
    }

    if (api.registerMemoryCapability) {
      api.registerMemoryCapability({
        id: "oms",
        kind: "memory",
        description: "Raw transcript ledger with evidence expansion and Git Markdown export.",
        publicArtifacts: {
          listArtifacts: () => [
            {
              kind: "timeline",
              path: config.memoryRepoPath,
              format: "oms-timeline-v1"
            }
          ]
        },
        controlPanel: controlPanelContract()
      });
      orchestrator.markRegistered({ memorySlotRegistered: true, activeMemorySlotId: "oms" });
    }

    registerTools(api, orchestrator);
    return orchestrator;
  }
};

export default entry;
