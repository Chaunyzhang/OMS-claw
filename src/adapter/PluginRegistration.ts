import { basename, dirname } from "node:path";
import { ConfigResolver } from "../core/ConfigResolver.js";
import { Logger } from "../core/Logger.js";
import { OmsOrchestrator } from "../core/OmsOrchestrator.js";
import { controlPanelContract } from "../ui/ControlPanelContract.js";
import { asToolResponse, jsonSchema } from "./OpenClawDiplomat.js";
import type { OpenClawPluginApi, OpenClawToolDefinition } from "./OpenClawTypes.js";

function tool(name: string, description: string, parameters: Record<string, unknown>, execute: OpenClawToolDefinition["execute"]): OpenClawToolDefinition {
  return { name, description, parameters, execute };
}

const retrievalToolParameters = jsonSchema(
  {
    query: { type: "string" },
    mode: { type: "string", enum: ["low", "medium", "high", "xhigh", "ultra"], default: "high" },
    evidencePolicy: {
      type: "string",
      enum: ["general_history", "assistant_history", "material_evidence", "diagnostic_history"]
    },
    caseId: { type: "string" },
    sessionId: { type: "string" },
    requiredLane: { type: "string", enum: ["fts_bm25", "trigram", "summary_dag", "ann_vector", "graph_cte"] },
    limit: { type: "number", default: 20 }
  },
  ["query"]
);

function registerTools(api: OpenClawPluginApi, orchestrator: OmsOrchestrator): void {
  const tools: OpenClawToolDefinition[] = [
    tool("oms_status", "Return OMS runtime attestation, registration state, counts, and health.", jsonSchema({}), () =>
      asToolResponse(orchestrator.status())
    ),
    tool(
      "oms_search",
      "Run decoupled OMS retrieval lanes, SQL fusion, and raw-only evidence packet construction.",
      retrievalToolParameters,
      async (_id, params) => asToolResponse(await orchestrator.retrieveTool(params))
    ),
    tool(
      "oms_retrieve",
      "Alias for oms_search. Returns candidates plus raw-only packet; never answers from candidates.",
      retrievalToolParameters,
      async (_id, params) => asToolResponse(await orchestrator.retrieveTool(params))
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
      "FTS BM25 lane retrieval through the raw-only evidence packet path. Candidates are not evidence.",
      jsonSchema({
        query: { type: "string" },
        mode: { type: "string", enum: ["low", "medium", "high", "xhigh", "ultra"], default: "medium" },
        evidencePolicy: {
          type: "string",
          enum: ["general_history", "assistant_history", "material_evidence", "diagnostic_history"]
        },
        caseId: { type: "string" },
        sessionId: { type: "string" },
        limit: { type: "number" }
      }, ["query"]),
      async (_id, params) => asToolResponse(await orchestrator.ftsSearchTool(params))
    ),
    tool(
      "oms_trace",
      "Trace query/run/summary/source-edge/raw/evidence delivery lineage.",
      jsonSchema({ summaryId: { type: "string" }, packetId: { type: "string" }, messageId: { type: "string" } }),
      (_id, params) => asToolResponse(orchestrator.traceTool(params))
    ),
    tool(
      "oms_debug_lanes",
      "Inspect lane candidates and degradation for a query. Candidate text is not evidence.",
      jsonSchema({ query: { type: "string" }, mode: { type: "string" }, caseId: { type: "string" } }, ["query"]),
      async (_id, params) => asToolResponse(await orchestrator.whyTool(params))
    ),
    tool(
      "oms_why",
      "Explain why a query matched or failed, including blocked reasons and enabled modules.",
      jsonSchema({ query: { type: "string" }, mode: { type: "string" }, caseId: { type: "string" } }, ["query"]),
      async (_id, params) => asToolResponse(await orchestrator.whyTool(params))
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

function hasAvailableTool(availableTools: unknown, name: string): boolean {
  if (!availableTools) {
    return false;
  }
  if (availableTools instanceof Set) {
    return availableTools.has(name);
  }
  if (Array.isArray(availableTools)) {
    return availableTools.includes(name);
  }
  if (typeof availableTools === "object" && typeof (availableTools as { has?: unknown }).has === "function") {
    return Boolean((availableTools as { has: (toolName: string) => boolean }).has(name));
  }
  return false;
}

function buildOmsPromptSection(params: { availableTools?: unknown; citationsMode?: string } = {}): string[] {
  const hasOmsTools =
    hasAvailableTool(params.availableTools, "oms_summary_search") ||
    hasAvailableTool(params.availableTools, "oms_search") ||
    hasAvailableTool(params.availableTools, "oms_retrieve") ||
    hasAvailableTool(params.availableTools, "oms_expand_evidence") ||
    hasAvailableTool(params.availableTools, "oms_fts_search");
  if (!hasOmsTools) {
    return [];
  }

  const lines = [
    "## OMS Memory Recall",
    "Before answering prior-conversation facts, dates, corrections, or formal memory tests, use OMS memory tools.",
    "For formal tests, call oms_search with the exact question text in high or ultra mode before answering.",
    "Answer only when oms_search or oms_expand_evidence returns a delivered raw evidence packet. Candidate lanes, summaries, embeddings, graph labels, and snippets are not evidence."
  ];
  if (params.citationsMode === "off") {
    lines.push("Citations are disabled: do not mention internal paths unless the user explicitly asks.");
  } else {
    lines.push("Mention evidence succinctly when it helps verification, but do not expose raw internal details unnecessarily.");
  }
  lines.push("");
  return lines;
}

function createOmsMemoryRuntime(orchestrator: OmsOrchestrator) {
  const manager = {
    async search(query: string, opts: { maxResults?: number; minScore?: number; sessionId?: string } = {}) {
      const result = await orchestrator.retrieveTool({
        query,
        evidencePolicy: "general_history",
        mode: "medium",
        requiredLane: "fts_bm25",
        sessionId: opts.sessionId,
        limit: opts.maxResults ?? 10
      });
      if (!result.ok || result.packet?.status !== "delivered") {
        return [];
      }
      const excerpts = result.packet.rawExcerpts;
      return excerpts.map((excerpt, index) => ({
        source: "memory",
        path: `oms/evidence/${result.packet?.packetId}/${excerpt.messageId}.md`,
        startLine: 1,
        endLine: 1,
        score: Math.max(0.01, 1 - index / Math.max(1, excerpts.length + 1)),
        snippet: excerpt.originalText
      }));
    },
    async readFile(params: { relPath?: string; path?: string }) {
      const lookup = String(params.relPath ?? params.path ?? "");
      const packetId = lookup.match(/pkt_[A-Za-z0-9-]+/)?.[0];
      const rawId = lookup.match(/raw_[A-Za-z0-9-]+/)?.[0];
      if (!packetId || !rawId) {
        return {
          path: lookup,
          text: "",
          disabled: true,
          error: "OMS evidence packet id and raw message id are required"
        };
      }
      const item = orchestrator.connection.db
        .prepare("SELECT excerpt_text AS text FROM evidence_packet_items WHERE packet_id = ? AND raw_id = ?")
        .get(packetId, rawId) as { text: string } | undefined;
      if (!item) {
        return {
          path: lookup,
          text: "",
          disabled: true,
          error: "OMS evidence packet item not found"
        };
      }
      return {
        path: lookup,
        text: item.text
      };
    },
    status() {
      return {
        backend: "builtin",
        provider: "oms",
        model: "sqlite-fts5+trigram+sqlite-canonical-vectors+graph-cte+sql-rrf",
        sources: ["memory"],
        files: orchestrator.rawMessages.count(),
        chunks: orchestrator.rawMessages.count(),
        dirty: false,
        custom: {
          oms: {
            agentId: orchestrator.config.agentId,
            rawMessages: orchestrator.rawMessages.count(),
            summaries: orchestrator.summaries.count()
          }
        }
      };
    },
    async sync() {},
    async probeEmbeddingAvailability() {
      const status = orchestrator.embeddingProvider.status();
      return {
        ok: (orchestrator.config.annEnabled || orchestrator.config.ragEnabled) && status.ok,
        provider: status.provider,
        model: status.model,
        reason: status.reason,
        optional: true
      };
    },
    async probeVectorAvailability() {
      const status = orchestrator.embeddingProvider.status();
      return (orchestrator.config.annEnabled || orchestrator.config.ragEnabled) && status.ok;
    },
    async close() {}
  };

  return {
    async getMemorySearchManager() {
      return { manager };
    },
    resolveMemoryBackendConfig(params: { cfg?: { memory?: { citations?: string } } } = {}) {
      return {
        backend: "builtin",
        citations: params.cfg?.memory?.citations ?? "auto",
        oms: {
          agentId: orchestrator.config.agentId
        }
      };
    },
    async closeAllMemorySearchManagers() {
      await manager.close();
    }
  };
}

function listOmsPublicArtifacts(orchestrator: OmsOrchestrator) {
  if (!orchestrator.config.memoryRepoPath) {
    return [];
  }
  return [
    {
      kind: "oms-redacted-timeline-repo",
      workspaceDir: dirname(orchestrator.config.memoryRepoPath),
      relativePath: basename(orchestrator.config.memoryRepoPath),
      absolutePath: orchestrator.config.memoryRepoPath,
      agentIds: [orchestrator.config.agentId],
      contentType: "directory"
    }
  ];
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
        promptBuilder: buildOmsPromptSection,
        runtime: createOmsMemoryRuntime(orchestrator),
        publicArtifacts: {
          listArtifacts: () => listOmsPublicArtifacts(orchestrator)
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
